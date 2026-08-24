import {
  isLocalAiLongRunningAnalysisTaskType,
  mergeRemoteAndLocalAiPrompt,
  parseLocalAiAgentRoundInput,
  parseLocalAiCompletionInput,
  type LocalAiAgentRoundInput,
  type LocalAiAgentRoundResult,
  type LocalAiCompletionInput,
  type LocalAiCompletionResult,
  type LocalAiMessage,
  type LocalAiStreamEvent
} from "../shared/local-ai-contract.js";
import type { LocalAiModelCredential } from "./local-ai-provider-store.js";

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
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/u, "");
  url.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  return url.toString();
}

function responseContent(value: unknown): string {
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

async function streamedCompletionBody(response: Response, onEvent?: StreamEventHandler): Promise<string> {
  if (!response.ok || !response.body || !String(response.headers.get("content-type") ?? "").toLocaleLowerCase("en-US").includes("text/event-stream")) {
    const text = await boundedResponseText(response);
    if (response.ok && onEvent) {
      try {
        const content = responseContent(JSON.parse(text) as unknown);
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

export function localAiRequestMessages(input: LocalAiCompletionInput, localSystemPrompt: string): LocalAiMessage[] {
  const systemPrompt = mergeRemoteAndLocalAiPrompt(input.remoteSystemPrompt, localSystemPrompt);
  if (!systemPrompt) return input.messages;
  const messages = [...input.messages];
  const firstNonSystem = messages.findIndex((message) => message.role !== "system");
  messages.splice(firstNonSystem < 0 ? messages.length : firstNonSystem, 0, { role: "system", content: systemPrompt });
  return messages;
}

export class LocalAiClient {
  private readonly fetch: typeof globalThis.fetch;

  constructor(fetchImpl: typeof globalThis.fetch = globalThis.fetch) {
    this.fetch = (input, init) => fetchImpl(input, init);
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
    const maxTokensParameter = credential.provider.maxTokensParameter;
    const requestTimeoutMs = isLocalAiLongRunningAnalysisTaskType(input.taskType)
      ? credential.provider.analysisTimeoutSeconds * 1_000
      : LOCAL_AI_REQUEST_TIMEOUT_MS;
    const thinkingEffort = credential.model.thinkingEffort;
    const thinkingParameters = {
      thinking: {
        type: credential.model.thinkingEnabled ? credential.provider.thinkingType : "disabled"
      },
      ...(credential.model.thinkingEnabled && thinkingEffort !== "default"
        ? { reasoning_effort: thinkingEffort }
        : {})
    };
    let response: Response;
    try {
      response = await this.fetch(localAiChatCompletionsUrl(credential.provider.baseUrl), {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          ...(credential.provider.apiKey === "" ? {} : { Authorization: `Bearer ${credential.provider.apiKey}` })
        },
        body: JSON.stringify({
          model: credential.model.modelId,
          messages: localAiRequestMessages(input, credential.systemPrompt),
          temperature: credential.model.preset.temperature,
          [maxTokensParameter]: credential.model.preset.max_tokens,
          ...thinkingParameters,
          stream: true,
          stream_options: { include_usage: true }
        }),
        redirect: "error",
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
          : AbortSignal.timeout(requestTimeoutMs)
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
    const text = await streamedCompletionBody(response, onEvent);
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
      content: responseContent(payload),
      scope: "local"
    };
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
    if (input.body.model !== credential.model.modelId) {
      throw new LocalAiClientError("LOCAL_AI_MODEL_MISMATCH", "Server Agent 请求的模型标识符与当前配置不匹配");
    }
    const body = structuredClone(input.body);
    body.model = credential.model.modelId;
    body.stream = true;
    body.stream_options = { include_usage: true };
    if (input.purpose === "generation" && credential.systemPrompt.trim()) {
      const messages = Array.isArray(body.messages) ? structuredClone(body.messages) : [];
      const systemMessage = messages.find((message) => isRecord(message) && message.role === "system");
      if (isRecord(systemMessage) && typeof systemMessage.content === "string") {
        systemMessage.content = mergeRemoteAndLocalAiPrompt(systemMessage.content, credential.systemPrompt);
      } else {
        messages.unshift({ role: "system", content: mergeRemoteAndLocalAiPrompt("", credential.systemPrompt) });
      }
      body.messages = messages;
    }
    let response: Response;
    try {
      response = await this.fetch(localAiChatCompletionsUrl(credential.provider.baseUrl), {
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
          ...(credential.provider.apiKey === "" ? {} : { Authorization: `Bearer ${credential.provider.apiKey}` })
        },
        body: JSON.stringify(body),
        redirect: "error",
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)])
          : AbortSignal.timeout(input.timeoutMs)
      });
    } catch (error) {
      if (signal?.aborted) throw new LocalAiClientError("LOCAL_AI_CANCELLED", "AI 请求已取消");
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new LocalAiClientError("LOCAL_AI_TIMEOUT", `AI 供应商响应超时（${Math.round(input.timeoutMs / 1_000)} 秒）`);
      }
      throw new LocalAiClientError("LOCAL_AI_NETWORK_ERROR", "无法连接 AI 供应商 Base URL");
    }
    const responseBody = await streamedCompletionBody(response, onEvent);
    return {
      status: response.status,
      body: responseBody,
      retryAfter: response.headers.get("retry-after")
    };
  }
}
