import {
  isLocalAiLongRunningAnalysisTaskType,
  mergeRemoteAndLocalAiPrompt,
  parseLocalAiAgentRoundInput,
  parseLocalAiCompletionInput,
  type LocalAiProviderInput,
  type LocalAiAgentRoundInput,
  type LocalAiAgentRoundResult,
  type LocalAiCompletionInput,
  type LocalAiCompletionResult,
  type LocalAiMessage,
  type LocalAiStreamEvent
} from "../shared/local-ai-contract.js";
import type { LocalAiModelCredential } from "./local-ai-provider-store.js";
import {
  LocalAiCredentialResolver,
  localAiCompletionUrl,
  localAiEmbeddingUrl,
  localAiLegacyCompletionUrl,
  localAiRequestHeaders
} from "./local-ai-protocol.js";

export const LOCAL_AI_REQUEST_TIMEOUT_MS = 180_000;
export const LOCAL_AI_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class LocalAiClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalAiClientError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function localAiChatCompletionsUrl(baseUrl: string): string {
  return localAiCompletionUrl(baseUrl, "openai-chat-completions");
}

function openAiChatResponseContent(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.choices) || !isRecord(value.choices[0])) {
    throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "AI 供应商返回格式无效");
  }
  const message = value.choices[0].message;
  if (!isRecord(message)) throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "AI 供应商返回消息无效");
  if (typeof message.content === "string" && message.content.length > 0 && message.content.length <= 2_000_000) {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    const content = message.content
      .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text))
      .join("");
    if (content.length > 0 && content.length <= 2_000_000) return content;
  }
  throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "AI 供应商返回内容无效");
}

function anthropicResponseContent(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) {
    throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "Anthropic Messages 返回格式无效");
  }
  const content = value.content
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("");
  if (content.length > 0 && content.length <= 2_000_000) return content;
  throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "Anthropic Messages 返回内容无效");
}

function responsesApiContent(value: unknown): string {
  if (!isRecord(value)) throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "OpenAI Responses 返回格式无效");
  if (typeof value.output_text === "string" && value.output_text.length > 0 && value.output_text.length <= 2_000_000) {
    return value.output_text;
  }
  const output = Array.isArray(value.output) ? value.output : [];
  const content = output.flatMap((item) => {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) return [];
    return item.content.flatMap((block) => (
      isRecord(block) && block.type === "output_text" && typeof block.text === "string" ? [block.text] : []
    ));
  }).join("");
  if (content.length > 0 && content.length <= 2_000_000) return content;
  throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "OpenAI Responses 返回内容无效");
}

function responseContent(protocol: LocalAiProviderInput["protocol"], value: unknown): string {
  if (protocol === "anthropic-messages") return anthropicResponseContent(value);
  if (protocol === "openai-responses") return responsesApiContent(value);
  return openAiChatResponseContent(value);
}

function apiErrorMessage(value: unknown, status: number): string {
  const message = isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
    ? value.error.message.trim()
    : "";
  return message.length > 0 && message.length <= 300 ? message : `AI 供应商请求失败（HTTP ${status}）`;
}

type StreamEventHandler = (event: LocalAiStreamEvent) => void;

type StreamToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

function streamText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((block) => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => String((block as Record<string, unknown>).text))
    .join("");
}

function appendStreamToolCalls(target: StreamToolCall[], value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!isRecord(item)) continue;
    const index = Number.isInteger(item.index) && Number(item.index) >= 0 ? Number(item.index) : 0;
    const current = target[index] ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
    if (typeof item.id === "string" && item.id.length > 0) current.id = item.id;
    if (item.type === "function") current.type = "function";
    if (isRecord(item.function)) {
      if (typeof item.function.name === "string") current.function.name += item.function.name;
      if (typeof item.function.arguments === "string") current.function.arguments += item.function.arguments;
    }
    target[index] = current;
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  const declaredBytes = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredBytes) && declaredBytes > LOCAL_AI_MAX_RESPONSE_BYTES) {
    throw new LocalAiClientError("LOCAL_AI_RESPONSE_TOO_LARGE", "AI 供应商响应过大");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > LOCAL_AI_MAX_RESPONSE_BYTES) {
    throw new LocalAiClientError("LOCAL_AI_RESPONSE_TOO_LARGE", "AI 供应商响应过大");
  }
  return text;
}

function streamFrameData(frame: string): string | null {
  const lines = frame.split(/\r?\n/u);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^\s/u, ""))
    .join("\n");
  return data === "" ? null : data;
}

async function streamedOpenAiChatCompletionBody(response: Response, onEvent?: StreamEventHandler): Promise<string> {
  if (!response.ok || !response.body || !String(response.headers.get("content-type") ?? "").toLocaleLowerCase("en-US").includes("text/event-stream")) {
    const text = await boundedResponseText(response);
    if (response.ok && onEvent) {
      try {
        const content = openAiChatResponseContent(JSON.parse(text) as unknown);
        if (content) onEvent({ type: "content-delta", delta: content });
      } catch {
        // 完整 JSON 仍由调用方统一校验并返回规范错误。
      }
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let receivedBytes = 0;
  let eventCount = 0;
  let completionId = "";
  let completionModel = "";
  let completionCreated = 0;
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: unknown = undefined;
  const toolCalls: StreamToolCall[] = [];

  const consumeFrame = (frame: string): void => {
    const data = streamFrameData(frame);
    if (!data || data === "[DONE]") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "AI 供应商返回了无效的流事件");
    }
    if (!isRecord(payload)) throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "AI 供应商返回了无效的流事件");
    if (isRecord(payload.error)) {
      const message = typeof payload.error.message === "string" ? payload.error.message : "AI 供应商流式请求失败";
      throw new LocalAiClientError("LOCAL_AI_STREAM_ERROR", message);
    }
    eventCount += 1;
    if (typeof payload.id === "string") completionId = payload.id;
    if (typeof payload.model === "string") completionModel = payload.model;
    if (Number.isInteger(payload.created)) completionCreated = Number(payload.created);
    if (payload.usage !== undefined && payload.usage !== null) usage = structuredClone(payload.usage);
    const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : null;
    if (!choice) return;
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = isRecord(choice.delta) ? choice.delta : null;
    if (!delta) return;
    const contentDelta = streamText(delta.content);
    if (contentDelta) {
      content += contentDelta;
      onEvent?.({ type: "content-delta", delta: contentDelta });
    }
    const reasoningDelta = typeof delta.reasoning_content === "string"
      ? delta.reasoning_content
      : typeof delta.reasoning === "string" ? delta.reasoning : "";
    if (reasoningDelta) {
      reasoning += reasoningDelta;
      onEvent?.({ type: "reasoning-delta", delta: reasoningDelta });
    }
    appendStreamToolCalls(toolCalls, delta.tool_calls);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > LOCAL_AI_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new LocalAiClientError("LOCAL_AI_RESPONSE_TOO_LARGE", "AI 供应商响应过大");
    }
    buffered += decoder.decode(value, { stream: true });
    while (true) {
      const separator = buffered.match(/\r?\n\r?\n/u);
      if (!separator || separator.index === undefined) break;
      const frame = buffered.slice(0, separator.index);
      buffered = buffered.slice(separator.index + separator[0].length);
      consumeFrame(frame);
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) consumeFrame(buffered);
  if (eventCount === 0) throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "AI 供应商没有返回有效的流事件");
  const normalizedToolCalls = toolCalls.filter((toolCall) => toolCall && (toolCall.id || toolCall.function.name));
  const body = {
    id: completionId || `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: completionCreated || Math.floor(Date.now() / 1_000),
    model: completionModel,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content || null,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(normalizedToolCalls.length > 0 ? { tool_calls: normalizedToolCalls } : {})
      },
      finish_reason: finishReason ?? (normalizedToolCalls.length > 0 ? "tool_calls" : "stop")
    }],
    ...(usage === undefined ? {} : { usage })
  };
  const serialized = JSON.stringify(body);
  if (new TextEncoder().encode(serialized).byteLength > LOCAL_AI_MAX_RESPONSE_BYTES) {
    throw new LocalAiClientError("LOCAL_AI_RESPONSE_TOO_LARGE", "AI 供应商响应过大");
  }
  return serialized;
}

async function readEventStream(
  response: Response,
  consume: (eventName: string, payload: Record<string, unknown>) => void
): Promise<void> {
  if (!response.body) throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "AI 供应商流式响应缺少正文");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let receivedBytes = 0;
  let eventCount = 0;
  const consumeFrame = (frame: string): void => {
    const data = streamFrameData(frame);
    if (!data || data === "[DONE]") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "AI 供应商返回了无效的流事件");
    }
    if (!isRecord(payload)) throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "AI 供应商返回了无效的流事件");
    const eventLine = frame.split(/\r?\n/u).find((line) => line.startsWith("event:"));
    const eventName = eventLine?.slice(6).trim() || (typeof payload.type === "string" ? payload.type : "message");
    eventCount += 1;
    consume(eventName, payload);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > LOCAL_AI_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new LocalAiClientError("LOCAL_AI_RESPONSE_TOO_LARGE", "AI 供应商响应过大");
    }
    buffered += decoder.decode(value, { stream: true });
    while (true) {
      const separator = buffered.match(/\r?\n\r?\n/u);
      if (!separator || separator.index === undefined) break;
      const frame = buffered.slice(0, separator.index);
      buffered = buffered.slice(separator.index + separator[0].length);
      consumeFrame(frame);
    }
  }
  buffered += decoder.decode();
  if (buffered.trim()) consumeFrame(buffered);
  if (eventCount === 0) throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "AI 供应商没有返回有效的流事件");
}

async function streamedAnthropicBody(response: Response, onEvent?: StreamEventHandler): Promise<string> {
  if (!response.ok || !response.body || !String(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
    const text = await boundedResponseText(response);
    if (response.ok && onEvent) {
      try {
        const content = anthropicResponseContent(JSON.parse(text) as unknown);
        if (content) onEvent({ type: "content-delta", delta: content });
      } catch {
        // 完整 JSON 仍由调用方统一校验并返回规范错误。
      }
    }
    return text;
  }
  let id = "";
  let model = "";
  let stopReason: string | null = null;
  let usage: Record<string, unknown> = {};
  const blocks = new Map<number, Record<string, unknown>>();
  const toolJson = new Map<number, string>();
  await readEventStream(response, (eventName, payload) => {
    if (eventName === "error" || payload.type === "error") {
      const error = isRecord(payload.error) ? payload.error : payload;
      throw new LocalAiClientError("LOCAL_AI_STREAM_ERROR", typeof error.message === "string" ? error.message : "Anthropic Messages 流式请求失败");
    }
    if (eventName === "message_start" && isRecord(payload.message)) {
      if (typeof payload.message.id === "string") id = payload.message.id;
      if (typeof payload.message.model === "string") model = payload.message.model;
      if (isRecord(payload.message.usage)) usage = { ...usage, ...payload.message.usage };
      return;
    }
    const index = Number.isInteger(payload.index) ? Number(payload.index) : -1;
    if (eventName === "content_block_start" && index >= 0 && isRecord(payload.content_block)) {
      blocks.set(index, structuredClone(payload.content_block));
      if (payload.content_block.type === "tool_use") toolJson.set(index, "");
      return;
    }
    if (eventName === "content_block_delta" && index >= 0 && isRecord(payload.delta)) {
      const block = blocks.get(index) ?? { type: "text", text: "" };
      if (payload.delta.type === "text_delta" && typeof payload.delta.text === "string") {
        block.text = `${typeof block.text === "string" ? block.text : ""}${payload.delta.text}`;
        onEvent?.({ type: "content-delta", delta: payload.delta.text });
      } else if (payload.delta.type === "thinking_delta" && typeof payload.delta.thinking === "string") {
        block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${payload.delta.thinking}`;
        onEvent?.({ type: "reasoning-delta", delta: payload.delta.thinking });
      } else if (payload.delta.type === "signature_delta" && typeof payload.delta.signature === "string") {
        block.signature = `${typeof block.signature === "string" ? block.signature : ""}${payload.delta.signature}`;
      } else if (payload.delta.type === "input_json_delta" && typeof payload.delta.partial_json === "string") {
        toolJson.set(index, `${toolJson.get(index) ?? ""}${payload.delta.partial_json}`);
      }
      blocks.set(index, block);
      return;
    }
    if (eventName === "content_block_stop" && index >= 0) {
      const block = blocks.get(index);
      if (block?.type === "tool_use") {
        try {
          block.input = JSON.parse(toolJson.get(index) || "{}") as unknown;
        } catch {
          block.input = {};
        }
      }
      return;
    }
    if (eventName === "message_delta") {
      if (isRecord(payload.delta) && typeof payload.delta.stop_reason === "string") stopReason = payload.delta.stop_reason;
      if (isRecord(payload.usage)) usage = { ...usage, ...payload.usage };
    }
  });
  return JSON.stringify({
    id: id || `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content: [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block),
    stop_reason: stopReason ?? "end_turn",
    stop_sequence: null,
    usage
  });
}

async function streamedResponsesBody(response: Response, onEvent?: StreamEventHandler): Promise<string> {
  if (!response.ok || !response.body || !String(response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
    const text = await boundedResponseText(response);
    if (response.ok && onEvent) {
      try {
        const content = responsesApiContent(JSON.parse(text) as unknown);
        if (content) onEvent({ type: "content-delta", delta: content });
      } catch {
        // 完整 JSON 仍由调用方统一校验并返回规范错误。
      }
    }
    return text;
  }
  let completedResponse: Record<string, unknown> | null = null;
  let id = "";
  let model = "";
  let text = "";
  let reasoning = "";
  let usage: unknown = undefined;
  const toolCalls = new Map<string, Record<string, unknown>>();
  await readEventStream(response, (eventName, payload) => {
    if (eventName === "error" || payload.type === "error") {
      const error = isRecord(payload.error) ? payload.error : payload;
      throw new LocalAiClientError("LOCAL_AI_STREAM_ERROR", typeof error.message === "string" ? error.message : "OpenAI Responses 流式请求失败");
    }
    if (isRecord(payload.response)) {
      if (typeof payload.response.id === "string") id = payload.response.id;
      if (typeof payload.response.model === "string") model = payload.response.model;
      if (payload.response.usage !== undefined) usage = structuredClone(payload.response.usage);
    }
    if ((eventName === "response.output_text.delta" || payload.type === "response.output_text.delta") && typeof payload.delta === "string") {
      text += payload.delta;
      onEvent?.({ type: "content-delta", delta: payload.delta });
    }
    if ((eventName.includes("reasoning") || String(payload.type ?? "").includes("reasoning")) && typeof payload.delta === "string") {
      reasoning += payload.delta;
      onEvent?.({ type: "reasoning-delta", delta: payload.delta });
    }
    if (isRecord(payload.item) && payload.item.type === "function_call") {
      const key = typeof payload.item.call_id === "string" ? payload.item.call_id : typeof payload.item.id === "string" ? payload.item.id : String(payload.output_index ?? toolCalls.size);
      toolCalls.set(key, structuredClone(payload.item));
    }
    if ((eventName === "response.function_call_arguments.delta" || payload.type === "response.function_call_arguments.delta") && typeof payload.delta === "string") {
      const key = typeof payload.call_id === "string" ? payload.call_id : typeof payload.item_id === "string" ? payload.item_id : String(payload.output_index ?? 0);
      const call = toolCalls.get(key) ?? { type: "function_call", call_id: key, name: "", arguments: "" };
      call.arguments = `${typeof call.arguments === "string" ? call.arguments : ""}${payload.delta}`;
      toolCalls.set(key, call);
    }
    if ((eventName === "response.completed" || payload.type === "response.completed") && isRecord(payload.response)) {
      completedResponse = structuredClone(payload.response);
    }
  });
  if (completedResponse) return JSON.stringify(completedResponse);
  const output: Record<string, unknown>[] = [];
  if (reasoning) output.push({ type: "reasoning", summary: [{ type: "summary_text", text: reasoning }] });
  if (text) output.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  output.push(...toolCalls.values());
  return JSON.stringify({
    id: id || `resp_${crypto.randomUUID()}`,
    object: "response",
    status: "completed",
    model,
    output,
    output_text: text,
    ...(usage === undefined ? {} : { usage })
  });
}

async function streamedCompletionBody(
  response: Response,
  protocol: LocalAiProviderInput["protocol"],
  onEvent?: StreamEventHandler
): Promise<string> {
  if (protocol === "anthropic-messages") return streamedAnthropicBody(response, onEvent);
  if (protocol === "openai-responses") return streamedResponsesBody(response, onEvent);
  return streamedOpenAiChatCompletionBody(response, onEvent);
}

export function localAiRequestMessages(input: LocalAiCompletionInput, localSystemPrompt: string): LocalAiMessage[] {
  const systemPrompt = mergeRemoteAndLocalAiPrompt(input.remoteSystemPrompt, localSystemPrompt);
  if (!systemPrompt) return input.messages;
  const messages = [...input.messages];
  const firstNonSystem = messages.findIndex((message) => message.role !== "system");
  messages.splice(firstNonSystem < 0 ? messages.length : firstNonSystem, 0, { role: "system", content: systemPrompt });
  return messages;
}

function localAiThinkingParameters(credential: LocalAiModelCredential): Record<string, unknown> {
  const { provider, model } = credential;
  const effort = model.thinkingEffort;
  if (provider.protocol === "openai-responses") {
    return model.thinkingEnabled
      ? (effort === "default" ? {} : { reasoning: { effort } })
      : { reasoning: { effort: "none" } };
  }
  const effortParameters = model.thinkingEnabled && effort !== "default"
    ? provider.protocol === "anthropic-messages" ? { output_config: { effort } } : { reasoning_effort: effort }
    : {};
  if (provider.protocol === "anthropic-messages") {
    let hostname = "";
    try {
      hostname = new URL(provider.baseUrl).hostname.toLowerCase();
    } catch {
      hostname = "";
    }
    const supportsThinkingType = hostname === "api.longcat.chat"
      || hostname === "open.bigmodel.cn"
      || hostname.endsWith(".bigmodel.cn")
      || hostname === "api.z.ai"
      || hostname.endsWith(".z.ai");
    return {
      ...(supportsThinkingType ? { thinking: { type: model.thinkingEnabled ? provider.thinkingType : "disabled" } } : {}),
      ...effortParameters
    };
  }
  return {
    thinking: { type: model.thinkingEnabled ? provider.thinkingType : "disabled" },
    ...effortParameters
  };
}

function simpleCompletionBody(credential: LocalAiModelCredential, messages: LocalAiMessage[]): Record<string, unknown> {
  const { provider, model } = credential;
  const thinking = localAiThinkingParameters(credential);
  if (provider.protocol === "openai-responses") {
    return {
      model: model.modelId,
      input: messages.map((message) => ({
        type: "message",
        role: message.role,
        content: [{ type: "input_text", text: message.content }]
      })),
      temperature: model.preset.temperature,
      max_output_tokens: model.preset.max_tokens,
      ...thinking,
      stream: true
    };
  }
  if (provider.protocol === "anthropic-messages") {
    const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
    return {
      model: model.modelId,
      ...(system ? { system } : {}),
      messages: messages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role, content: [{ type: "text", text: message.content }] })),
      temperature: model.preset.temperature,
      max_tokens: model.preset.max_tokens,
      ...thinking,
      stream: true
    };
  }
  return {
    model: model.modelId,
    messages,
    temperature: model.preset.temperature,
    [provider.maxTokensParameter]: model.preset.max_tokens,
    ...thinking,
    stream: true,
    stream_options: { include_usage: true }
  };
}

function appendLocalPromptToAgentBody(
  protocol: LocalAiProviderInput["protocol"],
  value: Record<string, unknown>,
  localSystemPrompt: string
): Record<string, unknown> {
  const body = structuredClone(value);
  const localPrompt = mergeRemoteAndLocalAiPrompt("", localSystemPrompt);
  if (localPrompt) {
    if (protocol === "anthropic-messages") {
      if (typeof body.system === "string") body.system = mergeRemoteAndLocalAiPrompt(body.system, localSystemPrompt);
      else if (Array.isArray(body.system)) body.system.push({ type: "text", text: localPrompt });
      else body.system = localPrompt;
    } else if (protocol === "openai-responses") {
      const input = Array.isArray(body.input) ? body.input : [];
      const system = [...input].reverse().find((item) => isRecord(item) && (item.role === "system" || item.role === "developer"));
      if (isRecord(system) && typeof system.content === "string") system.content = `${system.content}\n\n${localPrompt}`;
      else if (isRecord(system) && Array.isArray(system.content)) system.content.push({ type: "input_text", text: localPrompt });
      else input.unshift({ type: "message", role: "system", content: [{ type: "input_text", text: localPrompt }] });
      body.input = input;
    } else {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = [...messages].reverse().find((message) => isRecord(message) && message.role === "system");
      if (isRecord(system) && typeof system.content === "string") system.content = `${system.content}\n\n${localPrompt}`;
      else if (isRecord(system) && Array.isArray(system.content)) system.content.push({ type: "text", text: localPrompt });
      else messages.unshift({ role: "system", content: localPrompt });
      body.messages = messages;
    }
  }
  body.stream = true;
  if (protocol === "openai-chat-completions" || protocol === "google-vertex") {
    body.stream_options = { include_usage: true };
  } else {
    delete body.stream_options;
  }
  return body;
}

export class LocalAiClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly credentials: LocalAiCredentialResolver;

  constructor(fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
    this.fetch = (input, init) => fetchImpl(input, init);
    this.credentials = new LocalAiCredentialResolver(this.fetch);
  }

  async complete(
    credential: LocalAiModelCredential,
    value: LocalAiCompletionInput,
    signal?: AbortSignal,
    onEvent?: StreamEventHandler
  ): Promise<LocalAiCompletionResult> {
    const input = parseLocalAiCompletionInput(value);
    if (input.modelId !== credential.model.id) {
      throw new LocalAiClientError("LOCAL_AI_MODEL_MISMATCH", "AI 模型与请求不匹配");
    }
    if (credential.provider.status !== "enabled" || credential.model.enabled !== true) {
      throw new LocalAiClientError("LOCAL_AI_MODEL_DISABLED", "AI 供应商或模型已停用");
    }
    if ((credential.model.modelKind ?? "chat") !== "chat") {
      throw new LocalAiClientError("LOCAL_AI_MODEL_KIND_UNSUPPORTED", "Embedding 与 rerank 模型不能用于 AI 对话或分析任务");
    }
    const requestTimeoutMs = isLocalAiLongRunningAnalysisTaskType(input.taskType)
      ? credential.provider.analysisTimeoutSeconds * 1_000
      : LOCAL_AI_REQUEST_TIMEOUT_MS;
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
      : AbortSignal.timeout(requestTimeoutMs);
    const accessToken = await this.credentials.accessToken(credential.provider, requestSignal);
    if (signal?.aborted) throw new LocalAiClientError("LOCAL_AI_CANCELLED", "AI 请求已取消");
    let response: Response;
    try {
      response = await this.fetch(localAiCompletionUrl(credential.provider.baseUrl, credential.provider.protocol), {
        method: "POST",
        headers: localAiRequestHeaders(credential.provider.protocol, accessToken, "text/event-stream"),
        body: JSON.stringify(simpleCompletionBody(credential, localAiRequestMessages(input, credential.systemPrompt))),
        redirect: "error",
        cache: "no-store",
        signal: requestSignal
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new LocalAiClientError("LOCAL_AI_CANCELLED", "AI 请求已取消");
      }
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new LocalAiClientError("LOCAL_AI_TIMEOUT", `AI 供应商响应超时（${Math.round(requestTimeoutMs / 1_000)} 秒）`);
      }
      throw new LocalAiClientError("LOCAL_AI_NETWORK_ERROR", "无法连接 AI 供应商 Base URL");
    }
    const text = await streamedCompletionBody(response, credential.provider.protocol, onEvent);
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "AI 供应商未返回有效 JSON");
    }
    if (!response.ok) {
      throw new LocalAiClientError(`LOCAL_AI_HTTP_${response.status}`, apiErrorMessage(payload, response.status));
    }
    return {
      modelId: credential.model.id,
      model: credential.model.modelId,
      content: responseContent(credential.provider.protocol, payload),
      scope: "local"
    };
  }

  async testModel(
    credential: LocalAiModelCredential,
    signal: AbortSignal = AbortSignal.timeout(LOCAL_AI_REQUEST_TIMEOUT_MS)
  ): Promise<{ modelKind: LocalAiModelCredential["model"]["modelKind"]; vectorDimension?: number }> {
    const kind = credential.model.modelKind ?? "chat";
    if (kind === "chat") {
      await this.complete(credential, {
        modelId: credential.model.id,
        taskType: "chat",
        remoteSystemPrompt: "",
        messages: [{ role: "user", content: "仅回复 OK" }]
      }, signal);
      return { modelKind: kind };
    }
    if (credential.provider.protocol !== "openai-chat-completions" && credential.provider.protocol !== "openai-responses") {
      throw new LocalAiClientError("LOCAL_AI_SEMANTIC_PROTOCOL_UNSUPPORTED", "Embedding 与 rerank 模型必须使用 OpenAI-compatible 供应商协议");
    }
    const accessToken = await this.credentials.accessToken(credential.provider, signal);
    const headers = localAiRequestHeaders(credential.provider.protocol, accessToken, "application/json");
    const url = kind === "embedding"
      ? localAiEmbeddingUrl(credential.provider.baseUrl)
      : localAiLegacyCompletionUrl(credential.provider.baseUrl);
    const body = kind === "embedding"
      ? { model: credential.model.modelId, input: ["连接测试"] }
      : {
          model: credential.model.modelId,
          prompt: "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be yes or no.<|im_end|>\n<|im_start|>user\n<Instruct>: Retrieve a relevant passage\n<Query>: connection test\n<Document>: connection test<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
          temperature: 0,
          max_tokens: 1,
          stream: false
        };
    let response: Response;
    try {
      response = await this.fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", cache: "no-store", signal });
    } catch (error) {
      if (signal.aborted) throw new LocalAiClientError("LOCAL_AI_TIMEOUT", "AI 供应商响应超时");
      throw new LocalAiClientError("LOCAL_AI_NETWORK_ERROR", "无法连接 AI 供应商 Base URL");
    }
    const text = await boundedResponseText(response);
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "AI 供应商未返回有效 JSON");
    }
    if (!response.ok) throw new LocalAiClientError(`LOCAL_AI_HTTP_${response.status}`, apiErrorMessage(payload, response.status));
    if (kind === "embedding") {
      const record = isRecord(payload) && Array.isArray(payload.data) && isRecord(payload.data[0]) ? payload.data[0] : null;
      const embedding = record && Array.isArray(record.embedding) ? record.embedding : null;
      if (!embedding || embedding.length === 0 || embedding.length > 65_536 || embedding.some((item) => !Number.isFinite(Number(item)))) {
        throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "Embedding 供应商返回了无效向量");
      }
      return { modelKind: kind, vectorDimension: embedding.length };
    }
    const choice = isRecord(payload) && Array.isArray(payload.choices) && isRecord(payload.choices[0]) ? payload.choices[0] : null;
    const answer = typeof choice?.text === "string" ? choice.text.trim().toLowerCase() : "";
    if (answer !== "yes" && answer !== "no") {
      throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "Rerank 供应商没有返回 yes 或 no");
    }
    return { modelKind: kind };
  }

  async completeAgentRound(
    credential: LocalAiModelCredential,
    value: LocalAiAgentRoundInput,
    signal?: AbortSignal,
    onEvent?: StreamEventHandler
  ): Promise<LocalAiAgentRoundResult> {
    const input = parseLocalAiAgentRoundInput(value);
    if (input.modelId !== credential.model.id) {
      throw new LocalAiClientError("LOCAL_AI_MODEL_MISMATCH", "AI 模型与 Agent 请求不匹配");
    }
    if (credential.provider.status !== "enabled" || credential.model.enabled !== true) {
      throw new LocalAiClientError("LOCAL_AI_MODEL_DISABLED", "AI 供应商或模型已停用");
    }
    if ((credential.model.modelKind ?? "chat") !== "chat") {
      throw new LocalAiClientError("LOCAL_AI_MODEL_KIND_UNSUPPORTED", "Embedding 与 rerank 模型不能用于 AI 对话或分析任务");
    }
    if (input.body.model !== credential.model.modelId) {
      throw new LocalAiClientError("LOCAL_AI_MODEL_MISMATCH", "Server Agent 请求的模型标识符与当前配置不匹配");
    }
    const body = appendLocalPromptToAgentBody(credential.provider.protocol, input.body, input.purpose === "generation" ? credential.systemPrompt : "");
    body.model = credential.model.modelId;
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)])
      : AbortSignal.timeout(input.timeoutMs);
    const accessToken = await this.credentials.accessToken(credential.provider, requestSignal);
    if (signal?.aborted) throw new LocalAiClientError("LOCAL_AI_CANCELLED", "AI 请求已取消");
    let response: Response;
    try {
      response = await this.fetch(localAiCompletionUrl(credential.provider.baseUrl, credential.provider.protocol), {
        method: "POST",
        headers: localAiRequestHeaders(credential.provider.protocol, accessToken, "text/event-stream"),
        body: JSON.stringify(body),
        redirect: "error",
        cache: "no-store",
        signal: requestSignal
      });
    } catch (error) {
      if (signal?.aborted) throw new LocalAiClientError("LOCAL_AI_CANCELLED", "AI 请求已取消");
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new LocalAiClientError("LOCAL_AI_TIMEOUT", `AI 供应商响应超时（${Math.round(input.timeoutMs / 1_000)} 秒）`);
      }
      throw new LocalAiClientError("LOCAL_AI_NETWORK_ERROR", "无法连接 AI 供应商 Base URL");
    }
    const responseBody = await streamedCompletionBody(response, credential.provider.protocol, onEvent);
    return {
      status: response.status,
      body: responseBody,
      retryAfter: response.headers.get("retry-after")
    };
  }
}
