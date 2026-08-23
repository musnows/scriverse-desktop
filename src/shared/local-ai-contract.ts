export const LOCAL_AI_PROTOCOL = "openai-chat-completions" as const;
export const LOCAL_AI_MAX_TOKENS_PARAMETERS = ["max_tokens", "max_completion_tokens"] as const;
export const LOCAL_AI_THINKING_TYPES = ["enabled", "adaptive"] as const;
export const LOCAL_AI_THINKING_EFFORTS = ["default", "auto", "low", "medium", "high", "xhigh", "max"] as const;
export const LOCAL_AI_MODEL_PURPOSES = [
  "chat",
  "continue",
  "polish",
  "chapter-analysis",
  "book-analysis",
  "timeline-analysis",
  "relationship-analysis",
  "consistency-check"
] as const;

export type LocalAiProviderInput = {
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: typeof LOCAL_AI_PROTOCOL;
  maxTokensParameter: typeof LOCAL_AI_MAX_TOKENS_PARAMETERS[number];
  thinkingType: typeof LOCAL_AI_THINKING_TYPES[number];
  concurrencyLimit: number;
  rpmLimit: number;
  note: string;
  status: "enabled" | "disabled";
};

export type LocalAiProviderUpdateInput = LocalAiProviderInput & {
  providerId: string;
  replaceApiKey: boolean;
};

export type LocalAiProviderSummary = Omit<LocalAiProviderInput, "apiKey"> & {
  id: string;
  scope: "local";
  connectionStatus: "unchecked" | "success" | "error";
  hasApiKey: boolean;
  apiKey: string;
  lastError: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LocalAiModelInput = {
  providerId: string;
  displayName: string;
  modelId: string;
  purposes: typeof LOCAL_AI_MODEL_PURPOSES[number][];
  contextNote: string;
  contextWindow: number;
  outputNote: string;
  preset: {
    temperature: number;
    max_tokens: number;
  };
  thinkingEnabled: boolean;
  thinkingEffort: typeof LOCAL_AI_THINKING_EFFORTS[number];
  multimodalEnabled: boolean;
  imageToolDefault: boolean;
  enabled: boolean;
  note: string;
};

export type LocalAiModelUpdateInput = LocalAiModelInput & { localModelId: string };

export type LocalAiModelSummary = LocalAiModelInput & {
  id: string;
  scope: "local";
  providerName: string;
  providerStatus: "enabled" | "disabled";
  providerConnectionStatus: "unchecked" | "success" | "error";
  createdAt: string;
  updatedAt: string;
};

export type LocalAiConfigurationSummary = {
  systemPrompt: string;
  providers: LocalAiProviderSummary[];
  models: LocalAiModelSummary[];
  updatedAt: string;
};

export type LocalAiWorkspaceCatalog = {
  models: LocalAiModelSummary[];
  updatedAt: string;
};

export type LocalAiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LocalAiCompletionInput = {
  modelId: string;
  remoteSystemPrompt: string;
  messages: LocalAiMessage[];
};

export type LocalAiCompletionRequestInput = LocalAiCompletionInput & {
  requestId: string;
};

export type LocalAiCompletionResult = {
  modelId: string;
  model: string;
  content: string;
  scope: "local";
};

export class LocalAiContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalAiContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new LocalAiContractError("LOCAL_AI_INPUT_INVALID", `${label}包含未知字段`);
  }
}

function requiredString(value: unknown, maximum: number, code: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new LocalAiContractError(code, `${label}长度必须在 1 到 ${maximum} 个字符之间`);
  }
  return normalized;
}

function optionalString(value: unknown, maximum: number, code: string, label: string): string {
  if (typeof value !== "string" || value.length > maximum) {
    throw new LocalAiContractError(code, `${label}不能超过 ${maximum} 个字符`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, code: string, label: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new LocalAiContractError(code, `${label}必须是 ${minimum} 到 ${maximum} 之间的整数`);
  }
  return normalized;
}

export function parseLocalAiProviderId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new LocalAiContractError("LOCAL_AI_PROVIDER_ID_INVALID", "本地 AI 供应商 id 无效");
  }
  return value;
}

export function parseLocalAiModelId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new LocalAiContractError("LOCAL_AI_MODEL_ID_INVALID", "本地 AI 模型 id 无效");
  }
  return value;
}

export function parseLocalAiRequestId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new LocalAiContractError("LOCAL_AI_REQUEST_ID_INVALID", "本地 AI 请求 id 无效");
  }
  return value;
}

export function normalizeLocalAiBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2_048) {
    throw new LocalAiContractError("LOCAL_AI_BASE_URL_INVALID", "本地 AI Base URL 长度必须在 1 到 2048 个字符之间");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new LocalAiContractError("LOCAL_AI_BASE_URL_INVALID", "本地 AI Base URL 不是有效 URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.hostname === ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new LocalAiContractError("LOCAL_AI_BASE_URL_INVALID", "本地 AI Base URL 只允许无凭据、query 和 hash 的 HTTP(S) 地址");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  const normalized = url.toString();
  return url.pathname === "/" ? normalized.slice(0, -1) : normalized;
}

export function parseCreateLocalAiProviderInput(value: unknown): LocalAiProviderInput {
  if (!isRecord(value)) throw new LocalAiContractError("LOCAL_AI_INPUT_INVALID", "新增本地 AI 供应商请求无效");
  assertExactKeys(value, [
    "name",
    "baseUrl",
    "apiKey",
    "protocol",
    "maxTokensParameter",
    "thinkingType",
    "concurrencyLimit",
    "rpmLimit",
    "note",
    "status"
  ], "新增本地 AI 供应商请求");
  const protocol = value.protocol ?? LOCAL_AI_PROTOCOL;
  const maxTokensParameter = value.maxTokensParameter ?? "max_tokens";
  const thinkingType = value.thinkingType ?? "enabled";
  const status = value.status ?? "enabled";
  if (protocol !== LOCAL_AI_PROTOCOL) throw new LocalAiContractError("LOCAL_AI_PROTOCOL_INVALID", "本地 AI 当前仅支持 OpenAI Chat Completions");
  if (!LOCAL_AI_MAX_TOKENS_PARAMETERS.includes(maxTokensParameter as typeof LOCAL_AI_MAX_TOKENS_PARAMETERS[number])) {
    throw new LocalAiContractError("LOCAL_AI_MAX_TOKENS_PARAMETER_INVALID", "本地 AI 最大输出令牌参数无效");
  }
  if (!LOCAL_AI_THINKING_TYPES.includes(thinkingType as typeof LOCAL_AI_THINKING_TYPES[number])) {
    throw new LocalAiContractError("LOCAL_AI_THINKING_TYPE_INVALID", "本地 AI 思考类型无效");
  }
  if (status !== "enabled" && status !== "disabled") {
    throw new LocalAiContractError("LOCAL_AI_STATUS_INVALID", "本地 AI 供应商状态无效");
  }
  const apiKey = optionalString(value.apiKey ?? "", 8_192, "LOCAL_AI_API_KEY_INVALID", "本地 AI API Key");
  return {
    name: requiredString(value.name, 200, "LOCAL_AI_NAME_INVALID", "本地 AI 供应商名称"),
    baseUrl: normalizeLocalAiBaseUrl(value.baseUrl),
    apiKey,
    protocol,
    maxTokensParameter: maxTokensParameter as LocalAiProviderInput["maxTokensParameter"],
    thinkingType: thinkingType as LocalAiProviderInput["thinkingType"],
    concurrencyLimit: boundedInteger(value.concurrencyLimit ?? 10, 1, 100, "LOCAL_AI_CONCURRENCY_INVALID", "本地 AI 最大并发请求数"),
    rpmLimit: boundedInteger(value.rpmLimit ?? 10, 1, 10_000, "LOCAL_AI_RPM_INVALID", "本地 AI 每分钟请求上限"),
    note: optionalString(value.note ?? "", 10_000, "LOCAL_AI_NOTE_INVALID", "本地 AI 供应商用途备注"),
    status
  };
}

export function parseUpdateLocalAiProviderInput(value: unknown): LocalAiProviderUpdateInput {
  if (!isRecord(value)) throw new LocalAiContractError("LOCAL_AI_INPUT_INVALID", "修改本地 AI 供应商请求无效");
  assertExactKeys(value, [
    "providerId",
    "name",
    "baseUrl",
    "apiKey",
    "replaceApiKey",
    "protocol",
    "maxTokensParameter",
    "thinkingType",
    "concurrencyLimit",
    "rpmLimit",
    "note",
    "status"
  ], "修改本地 AI 供应商请求");
  if (typeof value.replaceApiKey !== "boolean") throw new LocalAiContractError("LOCAL_AI_INPUT_INVALID", "本地 AI API Key 替换标记无效");
  return {
    providerId: parseLocalAiProviderId(value.providerId),
    replaceApiKey: value.replaceApiKey,
    ...parseCreateLocalAiProviderInput({
      name: value.name,
      baseUrl: value.baseUrl,
      apiKey: value.apiKey,
      protocol: value.protocol,
      maxTokensParameter: value.maxTokensParameter,
      thinkingType: value.thinkingType,
      concurrencyLimit: value.concurrencyLimit,
      rpmLimit: value.rpmLimit,
      note: value.note,
      status: value.status
    })
  };
}

export function parseRemoveLocalAiProviderInput(value: unknown): { providerId: string } {
  if (!isRecord(value)) throw new LocalAiContractError("LOCAL_AI_INPUT_INVALID", "删除本地 AI 供应商请求无效");
  assertExactKeys(value, ["providerId"], "删除本地 AI 供应商请求");
  return { providerId: parseLocalAiProviderId(value.providerId) };
}

function parseLocalAiModelInput(value: Record<string, unknown>): LocalAiModelInput {
  const purposes = Array.isArray(value.purposes) ? [...new Set(value.purposes)] : [];
  if (
    purposes.length === 0
    || purposes.length > LOCAL_AI_MODEL_PURPOSES.length
    || purposes.some((purpose) => typeof purpose !== "string" || !LOCAL_AI_MODEL_PURPOSES.includes(purpose as typeof LOCAL_AI_MODEL_PURPOSES[number]))
  ) throw new LocalAiContractError("LOCAL_AI_MODEL_PURPOSES_INVALID", "本地 AI 模型用途无效");
  if (!isRecord(value.preset)) throw new LocalAiContractError("LOCAL_AI_MODEL_PRESET_INVALID", "本地 AI 模型默认参数无效");
  assertExactKeys(value.preset, ["temperature", "max_tokens"], "本地 AI 模型默认参数");
  const temperature = Number(value.preset.temperature);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new LocalAiContractError("LOCAL_AI_TEMPERATURE_INVALID", "本地 AI temperature 必须在 0 到 2 之间");
  }
  const thinkingEffort = value.thinkingEffort ?? "default";
  if (!LOCAL_AI_THINKING_EFFORTS.includes(thinkingEffort as typeof LOCAL_AI_THINKING_EFFORTS[number])) {
    throw new LocalAiContractError("LOCAL_AI_THINKING_EFFORT_INVALID", "本地 AI 模型思考强度无效");
  }
  for (const [key, label] of [["thinkingEnabled", "思考模式"], ["multimodalEnabled", "多模态能力"], ["imageToolDefault", "默认读图模型"], ["enabled", "启用状态"]] as const) {
    if (typeof value[key] !== "boolean") throw new LocalAiContractError("LOCAL_AI_MODEL_INPUT_INVALID", `本地 AI 模型${label}无效`);
  }
  if (value.imageToolDefault === true && (value.multimodalEnabled !== true || value.enabled !== true)) {
    throw new LocalAiContractError("LOCAL_AI_MODEL_IMAGE_DEFAULT_INVALID", "只有已启用的多模态本地模型才能设为默认读图模型");
  }
  return {
    providerId: parseLocalAiProviderId(value.providerId),
    displayName: requiredString(value.displayName, 200, "LOCAL_AI_MODEL_NAME_INVALID", "本地 AI 模型显示名称"),
    modelId: requiredString(value.modelId, 300, "LOCAL_AI_MODEL_NAME_INVALID", "本地 AI 模型标识符"),
    purposes: purposes as LocalAiModelInput["purposes"],
    contextNote: optionalString(value.contextNote ?? "", 10_000, "LOCAL_AI_MODEL_NOTE_INVALID", "本地 AI 模型上下文说明"),
    contextWindow: boundedInteger(value.contextWindow, 32_768, 2_000_000, "LOCAL_AI_CONTEXT_WINDOW_INVALID", "本地 AI 模型上下文令牌总量"),
    outputNote: optionalString(value.outputNote ?? "", 10_000, "LOCAL_AI_MODEL_NOTE_INVALID", "本地 AI 模型输出说明"),
    preset: {
      temperature,
      max_tokens: boundedInteger(value.preset.max_tokens, 1, 2_000_000, "LOCAL_AI_MAX_TOKENS_INVALID", "本地 AI 默认最大输出令牌数")
    },
    thinkingEnabled: value.thinkingEnabled as boolean,
    thinkingEffort: thinkingEffort as LocalAiModelInput["thinkingEffort"],
    multimodalEnabled: value.multimodalEnabled as boolean,
    imageToolDefault: value.imageToolDefault as boolean,
    enabled: value.enabled as boolean,
    note: optionalString(value.note ?? "", 10_000, "LOCAL_AI_MODEL_NOTE_INVALID", "本地 AI 模型用途备注")
  };
}

export function parseCreateLocalAiModelInput(value: unknown): LocalAiModelInput {
  if (!isRecord(value)) throw new LocalAiContractError("LOCAL_AI_MODEL_INPUT_INVALID", "新增本地 AI 模型请求无效");
  assertExactKeys(value, [
    "providerId",
    "displayName",
    "modelId",
    "purposes",
    "contextNote",
    "contextWindow",
    "outputNote",
    "preset",
    "thinkingEnabled",
    "thinkingEffort",
    "multimodalEnabled",
    "imageToolDefault",
    "enabled",
    "note"
  ], "新增本地 AI 模型请求");
  return parseLocalAiModelInput(value);
}

export function parseUpdateLocalAiModelInput(value: unknown): LocalAiModelUpdateInput {
  if (!isRecord(value)) throw new LocalAiContractError("LOCAL_AI_MODEL_INPUT_INVALID", "修改本地 AI 模型请求无效");
  assertExactKeys(value, [
    "localModelId",
    "providerId",
    "displayName",
    "modelId",
    "purposes",
    "contextNote",
    "contextWindow",
    "outputNote",
    "preset",
    "thinkingEnabled",
    "thinkingEffort",
    "multimodalEnabled",
    "imageToolDefault",
    "enabled",
    "note"
  ], "修改本地 AI 模型请求");
  return { localModelId: parseLocalAiModelId(value.localModelId), ...parseLocalAiModelInput(value) };
}

export function parseRemoveLocalAiModelInput(value: unknown): { modelId: string } {
  if (!isRecord(value)) throw new LocalAiContractError("LOCAL_AI_MODEL_INPUT_INVALID", "删除本地 AI 模型请求无效");
  assertExactKeys(value, ["modelId"], "删除本地 AI 模型请求");
  return { modelId: parseLocalAiModelId(value.modelId) };
}

export function parseLocalAiSystemPromptInput(value: unknown): { systemPrompt: string } {
  if (!isRecord(value)) throw new LocalAiContractError("LOCAL_AI_PROMPT_INVALID", "本地 AI 系统提示词请求无效");
  assertExactKeys(value, ["systemPrompt"], "本地 AI 系统提示词请求");
  return { systemPrompt: optionalString(value.systemPrompt, 100_000, "LOCAL_AI_PROMPT_INVALID", "本地 AI 系统提示词") };
}

export function parseLocalAiCompletionInput(value: unknown): LocalAiCompletionInput {
  if (!isRecord(value)) throw new LocalAiContractError("LOCAL_AI_INPUT_INVALID", "本地 AI 请求无效");
  assertExactKeys(value, ["modelId", "remoteSystemPrompt", "messages"], "本地 AI 请求");
  if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > 256) {
    throw new LocalAiContractError("LOCAL_AI_MESSAGES_INVALID", "本地 AI 消息数量必须在 1 到 256 条之间");
  }
  let totalCharacters = 0;
  const messages = value.messages.map((message): LocalAiMessage => {
    if (!isRecord(message)) throw new LocalAiContractError("LOCAL_AI_MESSAGES_INVALID", "本地 AI 消息无效");
    assertExactKeys(message, ["role", "content"], "本地 AI 消息");
    const role = message.role;
    const content = message.content;
    if (
      (role !== "system" && role !== "user" && role !== "assistant")
      || typeof content !== "string"
      || content.length === 0
      || content.length > 1_000_000
    ) throw new LocalAiContractError("LOCAL_AI_MESSAGES_INVALID", "本地 AI 消息字段无效");
    totalCharacters += content.length;
    return { role, content };
  });
  const remoteSystemPrompt = optionalString(value.remoteSystemPrompt, 300_000, "LOCAL_AI_PROMPT_INVALID", "远端 AI 系统提示词");
  totalCharacters += remoteSystemPrompt.length;
  if (totalCharacters > 4_000_000) {
    throw new LocalAiContractError("LOCAL_AI_MESSAGES_INVALID", "本地 AI 消息总长度不能超过 4000000 个字符");
  }
  return { modelId: parseLocalAiModelId(value.modelId), remoteSystemPrompt, messages };
}

export function parseLocalAiCompletionRequestInput(value: unknown): LocalAiCompletionRequestInput {
  if (!isRecord(value)) throw new LocalAiContractError("LOCAL_AI_INPUT_INVALID", "本地 AI 调用请求无效");
  assertExactKeys(value, ["requestId", "modelId", "remoteSystemPrompt", "messages"], "本地 AI 调用请求");
  return {
    requestId: parseLocalAiRequestId(value.requestId),
    ...parseLocalAiCompletionInput({
      modelId: value.modelId,
      remoteSystemPrompt: value.remoteSystemPrompt,
      messages: value.messages
    })
  };
}

export function parseCancelLocalAiCompletionInput(value: unknown): { requestId: string } {
  if (!isRecord(value)) throw new LocalAiContractError("LOCAL_AI_INPUT_INVALID", "取消本地 AI 请求无效");
  assertExactKeys(value, ["requestId"], "取消本地 AI 请求");
  return { requestId: parseLocalAiRequestId(value.requestId) };
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

export function localAiPromptXml(localPrompt: string): string {
  const prompt = localPrompt.trim();
  return prompt ? `<desktop_local_ai_prompt>\n${escapeXmlText(prompt)}\n</desktop_local_ai_prompt>` : "";
}

export function mergeRemoteAndLocalAiPrompt(remotePrompt: string, localPrompt: string): string {
  return [remotePrompt.trim(), localAiPromptXml(localPrompt)].filter(Boolean).join("\n\n");
}
