import {
  isLocalAiLongRunningAnalysisTaskType,
  mergeRemoteAndLocalAiPrompt,
  parseLocalAiCompletionInput,
  type LocalAiCompletionInput,
  type LocalAiCompletionResult,
  type LocalAiMessage
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
    throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "本地 AI 返回格式无效");
  }
  const message = value.choices[0].message;
  if (!isRecord(message)) throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "本地 AI 返回消息无效");
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
  throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "本地 AI 返回内容无效");
}

function apiErrorMessage(value: unknown, status: number): string {
  const message = isRecord(value) && isRecord(value.error) && typeof value.error.message === "string"
    ? value.error.message.trim()
    : "";
  return message.length > 0 && message.length <= 300 ? message : `本地 AI 请求失败（HTTP ${status}）`;
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

  async complete(credential: LocalAiModelCredential, value: LocalAiCompletionInput, signal?: AbortSignal): Promise<LocalAiCompletionResult> {
    const input = parseLocalAiCompletionInput(value);
    if (input.modelId !== credential.model.id) {
      throw new LocalAiClientError("LOCAL_AI_MODEL_MISMATCH", "本地 AI 模型与请求不匹配");
    }
    if (credential.provider.status !== "enabled" || credential.model.enabled !== true) {
      throw new LocalAiClientError("LOCAL_AI_MODEL_DISABLED", "本地 AI 供应商或模型已停用");
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
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(credential.provider.apiKey === "" ? {} : { Authorization: `Bearer ${credential.provider.apiKey}` })
        },
        body: JSON.stringify({
          model: credential.model.modelId,
          messages: localAiRequestMessages(input, credential.systemPrompt),
          temperature: credential.model.preset.temperature,
          [maxTokensParameter]: credential.model.preset.max_tokens,
          ...thinkingParameters,
          stream: false
        }),
        redirect: "error",
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
          : AbortSignal.timeout(requestTimeoutMs)
      });
    } catch (error) {
      if (signal?.aborted) {
        throw new LocalAiClientError("LOCAL_AI_CANCELLED", "本地 AI 请求已取消");
      }
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
        throw new LocalAiClientError("LOCAL_AI_TIMEOUT", `本地 AI 响应超时（${Math.round(requestTimeoutMs / 1_000)} 秒）`);
      }
      throw new LocalAiClientError("LOCAL_AI_NETWORK_ERROR", "无法连接本地 AI Base URL");
    }
    const declaredBytes = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredBytes) && declaredBytes > LOCAL_AI_MAX_RESPONSE_BYTES) {
      throw new LocalAiClientError("LOCAL_AI_RESPONSE_TOO_LARGE", "本地 AI 响应过大");
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > LOCAL_AI_MAX_RESPONSE_BYTES) {
      throw new LocalAiClientError("LOCAL_AI_RESPONSE_TOO_LARGE", "本地 AI 响应过大");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new LocalAiClientError("LOCAL_AI_RESPONSE_INVALID", "本地 AI 未返回有效 JSON");
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
}
