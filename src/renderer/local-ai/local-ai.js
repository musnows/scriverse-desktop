import { installExternalUrlPrompt } from "../external-url-prompt.js";
import { renderAiProviderConfigurationCards } from "./ai-provider-config-view.js";
import {
  MODEL_PURPOSE_OPTIONS,
  MODEL_THINKING_EFFORT_OPTIONS,
  modelFormValues,
  modelPayload as normalizedModelPayload,
  supportsMultimodalModelProtocol
} from "./model-config.js";

const DEFAULT_AI_ANALYSIS_TIMEOUT_SECONDS = 300;
const MIN_AI_ANALYSIS_TIMEOUT_SECONDS = 30;
const MAX_AI_ANALYSIS_TIMEOUT_SECONDS = 3_600;
const LOCAL_AI_PROTOCOL_OPTIONS = Object.freeze([
  { value: "openai-chat-completions", label: "OpenAI Chat Completions", defaultBaseUrl: "http://127.0.0.1:11434/v1", credentialKind: "api-key", supportsMultimodal: true, supportsMaxCompletionTokens: true },
  { value: "openai-responses", label: "OpenAI Responses", defaultBaseUrl: "https://api.openai.com/v1", credentialKind: "api-key", supportsMultimodal: true, supportsMaxCompletionTokens: false },
  { value: "anthropic-messages", label: "Anthropic Messages", defaultBaseUrl: "https://api.anthropic.com", credentialKind: "api-key", supportsMultimodal: true, supportsMaxCompletionTokens: false },
  { value: "google-vertex", label: "Google Vertex", defaultBaseUrl: "https://aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/global/endpoints/openapi", credentialKind: "service-account-json", supportsMultimodal: true, supportsMaxCompletionTokens: true }
]);

document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

const bridge = window.scriverseDesktop?.localAi;
const providerList = document.querySelector("#local-ai-provider-list");
const systemPrompt = document.querySelector("#local-ai-system-prompt");
const formDialog = document.querySelector("#local-ai-form-dialog");
const form = document.querySelector("#local-ai-dynamic-form");
const dialogTitle = document.querySelector("#local-ai-dialog-title");
const dialogEyebrow = document.querySelector("#local-ai-dialog-eyebrow");
const dialogMeta = document.querySelector("#local-ai-dialog-meta");
const dialogFields = document.querySelector("#local-ai-dialog-fields");
const dialogError = document.querySelector("#local-ai-dialog-error");
const dialogSubmit = document.querySelector("#local-ai-dialog-submit");
const dialogDanger = document.querySelector("#local-ai-dialog-danger");
const toast = document.querySelector("#local-ai-toast");

const state = {
  configuration: { systemPrompt: "", providers: [], models: [], updatedAt: "" },
  onSubmit: null,
  onDanger: null,
  toastTimer: null
};

function requireElement(value, label) {
  if (!(value instanceof HTMLElement)) throw new Error(`Local AI element missing: ${label}`);
  return value;
}

[
  [providerList, "provider-list"],
  [systemPrompt, "system-prompt"],
  [formDialog, "form-dialog"],
  [form, "dynamic-form"],
  [dialogTitle, "dialog-title"],
  [dialogEyebrow, "dialog-eyebrow"],
  [dialogMeta, "dialog-meta"],
  [dialogFields, "dialog-fields"],
  [dialogError, "dialog-error"],
  [dialogSubmit, "dialog-submit"],
  [dialogDanger, "dialog-danger"],
  [toast, "toast"]
].forEach(([value, label]) => requireElement(value, label));

function unwrap(result) {
  if (result?.ok === true) return result.data;
  const error = new Error(result?.error?.message ?? "AI 配置操作失败，请重试");
  error.code = result?.error?.code ?? "DESKTOP_BRIDGE_FAILED";
  throw error;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}

function showToast(message, error = false) {
  window.clearTimeout(state.toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  state.toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4_200);
}

installExternalUrlPrompt({ bridge: window.scriverseDesktop?.external, toast, notify: showToast });

function setBusy(button, busy, busyLabel = "处理中") {
  if (!(button instanceof HTMLButtonElement)) return;
  if (busy) button.dataset.idleLabel = button.textContent;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  button.textContent = busy ? busyLabel : button.dataset.idleLabel || button.textContent;
}

function field(name, label, type, value = "", options = {}) {
  if (type === "textarea") {
    return `<label class="form-field"><span>${esc(label)}</span><textarea name="${esc(name)}" maxlength="${Number(options.maxlength ?? 10000)}" ${options.required ? "required" : ""}>${esc(value)}</textarea>${options.hint ? `<small>${esc(options.hint)}</small>` : ""}</label>`;
  }
  if (type === "select") {
    return `<label class="form-field"><span>${esc(label)}</span><select name="${esc(name)}">${options.options.map(([optionValue, optionLabel]) => `<option value="${esc(optionValue)}" ${optionValue === value ? "selected" : ""}>${esc(optionLabel)}</option>`).join("")}</select>${options.hint ? `<small>${esc(options.hint)}</small>` : ""}</label>`;
  }
  if (type === "checkbox") {
    return `<label class="checkbox-field form-field"><input name="${esc(name)}" type="checkbox" ${value ? "checked" : ""}><span>${esc(label)}</span></label>`;
  }
  return `<label class="form-field"><span>${esc(label)}</span><input name="${esc(name)}" type="${esc(type)}" value="${esc(value)}" ${options.min === undefined ? "" : `min="${Number(options.min)}"`} ${options.max === undefined ? "" : `max="${Number(options.max)}"`} ${options.step === undefined ? "" : `step="${esc(options.step)}"`} ${options.maxlength === undefined ? "" : `maxlength="${Number(options.maxlength)}"`} ${options.required ? "required" : ""} autocomplete="${type === "password" ? "off" : "off"}">${options.hint ? `<small>${esc(options.hint)}</small>` : ""}</label>`;
}

function openDialog({ title, eyebrow, meta, fields, submitLabel = "保存", dangerLabel = "", onSubmit, onDanger = null }) {
  dialogTitle.textContent = title;
  dialogEyebrow.textContent = eyebrow;
  dialogMeta.textContent = meta;
  dialogFields.innerHTML = fields;
  dialogError.hidden = true;
  dialogSubmit.textContent = submitLabel;
  dialogDanger.textContent = dangerLabel;
  dialogDanger.classList.toggle("hidden", !onDanger);
  state.onSubmit = onSubmit;
  state.onDanger = onDanger;
  formDialog.showModal();
  window.setTimeout(() => dialogFields.querySelector("input, textarea, select")?.focus(), 0);
}

document.querySelectorAll("[data-local-ai-dialog-cancel]").forEach((button) => {
  button.addEventListener("click", () => formDialog.close("cancel"));
});

function providerFields(provider = null) {
  const protocol = provider?.protocol ?? LOCAL_AI_PROTOCOL_OPTIONS[0].value;
  const protocolOption = LOCAL_AI_PROTOCOL_OPTIONS.find((option) => option.value === protocol) ?? LOCAL_AI_PROTOCOL_OPTIONS[0];
  const credentialField = protocolOption.credentialKind === "service-account-json"
    ? field("apiKey", provider ? "替换服务账号 JSON（留空则不变）" : "服务账号 JSON", "textarea", "", { maxlength: 50000, required: !provider })
    : field("apiKey", provider ? "替换 API 密钥（留空则不变）" : "API 密钥（本地服务可留空）", "password", "", { maxlength: 50000 });
  return field("name", "显示名称", "text", provider?.name ?? "", { required: true, maxlength: 200 })
    + field("protocol", "接口协议", "select", protocol, {
      options: LOCAL_AI_PROTOCOL_OPTIONS.map((option) => [option.value, option.label])
    })
    + field("baseUrl", "API 基础地址", "url", provider?.baseUrl ?? protocolOption.defaultBaseUrl, {
      required: true,
      maxlength: 2048,
      hint: "本地服务可使用回环或局域网地址；Google Vertex 必须使用官方域名。"
    })
    + `<div data-provider-credential-field>${credentialField}</div>`
    + `<div data-provider-max-tokens-parameter-field class="${protocolOption.supportsMaxCompletionTokens ? "" : "hidden"}">${field("useMaxCompletionTokens", "使用 max_completion_tokens", "checkbox", protocolOption.supportsMaxCompletionTokens && provider?.maxTokensParameter === "max_completion_tokens")}</div>`
    + field("useAdaptiveThinking", "思考开启时使用 adaptive", "checkbox", provider?.thinkingType === "adaptive")
    + field("concurrencyLimit", "最大并发请求数", "number", provider?.concurrencyLimit ?? 10, { min: 1, max: 100, step: 1, required: true })
    + field("rpmLimit", "每分钟请求上限", "number", provider?.rpmLimit ?? 10, { min: 1, max: 10000, step: 1, required: true })
    + field("analysisTimeoutSeconds", "分析请求超时（秒）", "number", provider?.analysisTimeoutSeconds ?? DEFAULT_AI_ANALYSIS_TIMEOUT_SECONDS, {
      min: MIN_AI_ANALYSIS_TIMEOUT_SECONDS,
      max: MAX_AI_ANALYSIS_TIMEOUT_SECONDS,
      step: 1,
      required: true,
      hint: "用于全书分析和关系分析的单次请求"
    })
    + field("note", "用途备注", "textarea", provider?.note ?? "", { maxlength: 10000 })
    + field("enabled", provider ? "启用供应商" : "立即启用", "checkbox", provider ? provider.status === "enabled" : true);
}

function providerPayload(formData, provider = null) {
  const apiKey = String(formData.get("apiKey") ?? "");
  const analysisTimeoutSeconds = Number(formData.get("analysisTimeoutSeconds"));
  if (
    !Number.isInteger(analysisTimeoutSeconds)
    || analysisTimeoutSeconds < MIN_AI_ANALYSIS_TIMEOUT_SECONDS
    || analysisTimeoutSeconds > MAX_AI_ANALYSIS_TIMEOUT_SECONDS
  ) throw new Error("分析请求超时必须设置为 30–3600 秒的整数");
  return {
    ...(provider ? { providerId: provider.id, replaceApiKey: apiKey.trim().length > 0 } : {}),
    name: formData.get("name"),
    protocol: formData.get("protocol"),
    baseUrl: formData.get("baseUrl"),
    apiKey,
    maxTokensParameter: formData.get("useMaxCompletionTokens") === "on" ? "max_completion_tokens" : "max_tokens",
    thinkingType: formData.get("useAdaptiveThinking") === "on" ? "adaptive" : "enabled",
    concurrencyLimit: Number(formData.get("concurrencyLimit")),
    rpmLimit: Number(formData.get("rpmLimit")),
    analysisTimeoutSeconds,
    note: formData.get("note"),
    status: formData.get("enabled") === "on" ? "enabled" : "disabled"
  };
}

function bindProviderProtocolFields(provider = null) {
  const protocolSelect = dialogFields.querySelector("select[name='protocol']");
  const baseUrlInput = dialogFields.querySelector("input[name='baseUrl']");
  const credentialHost = dialogFields.querySelector("[data-provider-credential-field]");
  const maxTokensHost = dialogFields.querySelector("[data-provider-max-tokens-parameter-field]");
  const sync = () => {
    const option = LOCAL_AI_PROTOCOL_OPTIONS.find((item) => item.value === protocolSelect?.value) ?? LOCAL_AI_PROTOCOL_OPTIONS[0];
    if (credentialHost) {
      credentialHost.innerHTML = option.credentialKind === "service-account-json"
        ? field("apiKey", provider ? "替换服务账号 JSON（留空则不变）" : "服务账号 JSON", "textarea", "", { maxlength: 50000, required: !provider })
        : field("apiKey", provider ? "替换 API 密钥（留空则不变）" : "API 密钥（本地服务可留空）", "password", "", { maxlength: 50000 });
    }
    if (!provider && baseUrlInput) baseUrlInput.value = option.defaultBaseUrl;
    const maxTokensInput = maxTokensHost?.querySelector("input[name='useMaxCompletionTokens']");
    maxTokensHost?.classList.toggle("hidden", !option.supportsMaxCompletionTokens);
    if (maxTokensInput) {
      maxTokensInput.disabled = !option.supportsMaxCompletionTokens;
      if (!option.supportsMaxCompletionTokens) maxTokensInput.checked = false;
    }
  };
  protocolSelect?.addEventListener("change", sync);
}

function openProviderDialog(provider = null) {
  openDialog({
    title: provider ? "编辑 AI 供应商" : "新建 AI 供应商",
    eyebrow: "供应商配置",
    meta: "供应商设置",
    fields: providerFields(provider),
    dangerLabel: provider ? "删除供应商" : "",
    onSubmit: async (formData) => {
      if (provider) unwrap(await bridge.updateProvider(providerPayload(formData, provider)));
      else unwrap(await bridge.createProvider(providerPayload(formData)));
      showToast(provider ? "AI 供应商配置已保存" : "AI 供应商已创建");
      await refreshConfiguration();
    },
    onDanger: provider ? async () => {
      if (!window.confirm(`确认删除供应商“${provider.name}”及其全部模型吗？`)) return false;
      unwrap(await bridge.removeProvider({ providerId: provider.id }));
      showToast("AI 供应商已删除");
      await refreshConfiguration();
      return true;
    } : null
  });
  bindProviderProtocolFields(provider);
}

function purposeFields(values) {
  return `<fieldset class="form-field"><legend>支持用途（可多选）</legend><div class="local-ai-purpose-options">${MODEL_PURPOSE_OPTIONS.map(([value, label]) => `<label><input name="purposes" type="checkbox" value="${esc(value)}" ${values.purposes.includes(value) ? "checked" : ""}><span>${esc(label)}</span></label>`).join("")}</div></fieldset>`;
}

function modelFields(model = null, provider = null) {
  const values = modelFormValues(model);
  const modelKindFields = `<div class="form-field model-kind-fields" role="group" aria-labelledby="local-model-kind-heading"><span id="local-model-kind-heading">专用模型类型</span><label class="checkbox-field model-capability-option"><input name="embeddingModel" type="checkbox" ${values.modelKind === "embedding" ? "checked" : ""}><span><strong>这是一个 embedding 模型</strong><small>只用于语义向量，不会出现在 chat 框或 AI 分析任务中。</small></span></label><label class="checkbox-field model-capability-option"><input name="rerankModel" type="checkbox" ${values.modelKind === "rerank" ? "checked" : ""}><span><strong>这是一个 rerank 模型</strong><small>只用于语义候选重排，不会出现在 chat 框或 AI 分析任务中。</small></span></label><small>两项都不勾选时，该模型按普通 chat 模型使用。</small></div>`;
  const multimodalSupported = supportsMultimodalModelProtocol(provider?.protocol, LOCAL_AI_PROTOCOL_OPTIONS);
  const connectionTestDescription = values.modelKind === "embedding"
    ? "调用 OpenAI-compatible embeddings 接口并校验返回向量。"
    : values.modelKind === "rerank"
      ? "使用 yes/no 最小相关性判定校验 rerank 模型。"
      : "使用当前模型标识符、思考设置和供应商凭据发起最小请求。";
  const connectionTest = model && provider?.status === "enabled"
    ? `<section class="model-connection-test"><div><strong>模型连接测试</strong><p>${esc(connectionTestDescription)}</p></div><button class="ghost-button" type="button" data-test-model="${esc(model.id)}">测试连接</button></section>`
    : "";
  return field("displayName", "显示名称", "text", values.displayName, { required: true, maxlength: 200 })
    + field("modelId", "模型标识符", "text", values.modelId, { required: true, maxlength: 300 })
    + modelKindFields
    + `<div data-chat-model-fields class="${values.modelKind === "chat" ? "" : "hidden"}">`
    + purposeFields(values)
    + field("contextWindow", "模型上下文令牌总量", "number", values.contextWindow, { min: 32768, max: 2000000, step: 1, required: true })
    + field("temperature", "默认温度", "number", values.temperature, { min: 0, max: 2, step: "any", required: true })
    + field("maxTokens", "默认最大输出令牌数", "number", values.maxTokens, { min: 1, max: 2000000, step: 1, required: true })
    + field("thinkingEnabled", "开启思考模式（供应商需支持相应参数）", "checkbox", values.thinkingEnabled)
    + field("thinkingEffort", "思考强度（模型默认时不发送强度参数）", "select", values.thinkingEffort, { options: MODEL_THINKING_EFFORT_OPTIONS })
    + (multimodalSupported ? field("multimodalEnabled", "支持多模态图片理解", "checkbox", values.multimodalEnabled)
      + field("imageToolDefault", "设为多模态读图工具默认模型", "checkbox", values.imageToolDefault) : "")
    + `</div>`
    + field("enabled", "启用模型", "checkbox", values.enabled)
    + connectionTest;
}

function modelPayload(formData, providerId, model = null) {
  const modelKind = formData.get("embeddingModel") === "on" ? "embedding" : formData.get("rerankModel") === "on" ? "rerank" : "chat";
  const purposes = modelKind === "chat" ? formData.getAll("purposes") : [];
  if (modelKind === "chat" && purposes.length === 0) throw new Error("请至少选择一个模型用途");
  const values = normalizedModelPayload({
    displayName: formData.get("displayName"),
    modelId: formData.get("modelId"),
    modelKind,
    purposes,
    contextWindow: formData.get("contextWindow"),
    temperature: formData.get("temperature"),
    maxTokens: formData.get("maxTokens"),
    thinkingEnabled: formData.get("thinkingEnabled") === "on",
    thinkingEffort: formData.get("thinkingEffort"),
    multimodalEnabled: formData.get("multimodalEnabled") === "on",
    imageToolDefault: formData.get("imageToolDefault") === "on",
    enabled: formData.get("enabled") === "on"
  }, model?.preset);
  return {
    ...(model ? { localModelId: model.id } : {}),
    providerId,
    ...values,
    contextNote: "",
    outputNote: "",
    note: ""
  };
}

function openModelDialog(providerId, model = null) {
  const provider = state.configuration.providers.find((item) => item.id === providerId) ?? null;
  openDialog({
    title: model ? "编辑模型" : "添加模型",
    eyebrow: "模型配置",
    meta: "用途、上下文与生成参数",
    fields: modelFields(model, provider),
    dangerLabel: model ? "删除模型" : "",
    onSubmit: async (formData) => {
      if (model) unwrap(await bridge.updateModel(modelPayload(formData, providerId, model)));
      else unwrap(await bridge.createModel(modelPayload(formData, providerId)));
      showToast(model ? "AI 模型配置已保存" : "AI 模型已添加");
      await refreshConfiguration();
    },
    onDanger: model ? async () => {
      if (!window.confirm(`确认删除模型“${model.displayName}”吗？`)) return false;
      unwrap(await bridge.removeModel({ modelId: model.id }));
      showToast("AI 模型已删除");
      await refreshConfiguration();
      return true;
    } : null
  });
  const embeddingInput = dialogFields.querySelector("input[name='embeddingModel']");
  const rerankInput = dialogFields.querySelector("input[name='rerankModel']");
  const chatFields = dialogFields.querySelector("[data-chat-model-fields]");
  const syncModelKind = (changedInput = null) => {
    if (changedInput?.checked) {
      const other = changedInput === embeddingInput ? rerankInput : embeddingInput;
      if (other) other.checked = false;
    }
    chatFields?.classList.toggle("hidden", Boolean(embeddingInput?.checked || rerankInput?.checked));
  };
  embeddingInput?.addEventListener("change", () => syncModelKind(embeddingInput));
  rerankInput?.addEventListener("change", () => syncModelKind(rerankInput));
  dialogFields.querySelector("[data-test-model]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setBusy(button, true, "测试中");
    try {
      const result = unwrap(await bridge.testModel({ modelId: button.dataset.testModel }));
      const suffix = result.vectorDimension ? `，向量维度 ${Number(result.vectorDimension).toLocaleString("zh-CN")}` : "";
      showToast(result.ok ? `AI 模型连接测试成功${suffix}` : result.error, !result.ok);
      await refreshConfiguration();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  });
}

function bindProviderActions() {
  providerList.querySelectorAll("[data-edit-provider]").forEach((button) => button.addEventListener("click", () => {
    const provider = state.configuration.providers.find((item) => item.id === button.dataset.editProvider);
    if (provider) openProviderDialog(provider);
  }));
  providerList.querySelectorAll("[data-add-model]").forEach((button) => button.addEventListener("click", () => {
    openModelDialog(button.dataset.addModel);
  }));
  providerList.querySelectorAll("[data-edit-model]").forEach((button) => button.addEventListener("click", () => {
    const model = state.configuration.models.find((item) => item.id === button.dataset.editModel);
    if (model) openModelDialog(model.providerId, model);
  }));
  providerList.querySelectorAll("[data-test-provider]").forEach((button) => button.addEventListener("click", async () => {
    setBusy(button, true, "测试中");
    try {
      const result = unwrap(await bridge.testProvider({ providerId: button.dataset.testProvider }));
      showToast(result.ok ? "AI 供应商连接测试成功" : result.error, !result.ok);
      await refreshConfiguration();
    } catch (error) {
      showToast(error.message, true);
    } finally {
      setBusy(button, false);
    }
  }));
}

async function refreshConfiguration() {
  state.configuration = unwrap(await bridge.configuration());
  systemPrompt.value = state.configuration.systemPrompt;
  providerList.innerHTML = renderAiProviderConfigurationCards(
    state.configuration.providers,
    state.configuration.models,
    LOCAL_AI_PROTOCOL_OPTIONS,
    { showScope: false }
  );
  bindProviderActions();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (typeof state.onSubmit !== "function") return;
  dialogError.hidden = true;
  setBusy(dialogSubmit, true);
  try {
    await state.onSubmit(new FormData(form));
    formDialog.close();
  } catch (error) {
    dialogError.textContent = error.message;
    dialogError.hidden = false;
  } finally {
    setBusy(dialogSubmit, false);
  }
});

dialogDanger.addEventListener("click", async () => {
  if (typeof state.onDanger !== "function") return;
  dialogError.hidden = true;
  setBusy(dialogDanger, true);
  try {
    if (await state.onDanger()) formDialog.close();
  } catch (error) {
    dialogError.textContent = error.message;
    dialogError.hidden = false;
  } finally {
    setBusy(dialogDanger, false);
  }
});

document.querySelector("#local-ai-new-provider").addEventListener("click", () => openProviderDialog());
document.querySelector("#local-ai-save-system-prompt").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  setBusy(button, true);
  try {
    unwrap(await bridge.updateSystemPrompt({ systemPrompt: systemPrompt.value }));
    showToast("平台全局系统提示词已保存");
    await refreshConfiguration();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
  }
});

if (!bridge) {
  providerList.innerHTML = '<div class="empty-state"><b>AI 配置暂时不可用</b>请重新打开叙界。</div>';
} else {
  refreshConfiguration().catch((error) => {
    providerList.innerHTML = `<div class="empty-state"><b>AI 配置读取失败</b>${esc(error.message)}</div>`;
  });
}
