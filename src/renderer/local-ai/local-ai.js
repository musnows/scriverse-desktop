import { renderAiProviderConfigurationCards } from "./ai-provider-config-view.js";
import { MODEL_PURPOSE_OPTIONS, MODEL_THINKING_EFFORT_OPTIONS, modelFormValues } from "./model-config.js";

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
  const error = new Error(result?.error?.message ?? "Desktop 本地 AI 操作失败");
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

function providerFields(provider = null) {
  return field("name", "显示名称", "text", provider?.name ?? "", { required: true, maxlength: 200 })
    + field("protocol", "接口协议", "select", "openai-chat-completions", {
      options: [["openai-chat-completions", "OpenAI Chat Completions"]]
    })
    + field("baseUrl", "API 基础地址", "url", provider?.baseUrl ?? "http://127.0.0.1:11434/v1", {
      required: true,
      maxlength: 2048,
      hint: "允许回环与局域网地址；不要包含凭据、query 或 hash。"
    })
    + field("apiKey", provider ? "替换 API 密钥（留空则不变）" : "API 密钥（本地服务可留空）", "password", "", { maxlength: 8192 })
    + field("useMaxCompletionTokens", "使用 max_completion_tokens", "checkbox", provider?.maxTokensParameter === "max_completion_tokens")
    + field("useAdaptiveThinking", "思考开启时使用 adaptive", "checkbox", provider?.thinkingType === "adaptive")
    + field("concurrencyLimit", "最大并发请求数", "number", provider?.concurrencyLimit ?? 10, { min: 1, max: 100, step: 1, required: true })
    + field("rpmLimit", "每分钟请求上限", "number", provider?.rpmLimit ?? 10, { min: 1, max: 10000, step: 1, required: true })
    + field("note", "用途备注", "textarea", provider?.note ?? "", { maxlength: 10000 })
    + field("enabled", provider ? "启用供应商" : "立即启用", "checkbox", provider ? provider.status === "enabled" : true);
}

function providerPayload(formData, provider = null) {
  const apiKey = String(formData.get("apiKey") ?? "");
  return {
    ...(provider ? { providerId: provider.id, replaceApiKey: apiKey.trim().length > 0 } : {}),
    name: formData.get("name"),
    protocol: "openai-chat-completions",
    baseUrl: formData.get("baseUrl"),
    apiKey,
    maxTokensParameter: formData.get("useMaxCompletionTokens") === "on" ? "max_completion_tokens" : "max_tokens",
    thinkingType: formData.get("useAdaptiveThinking") === "on" ? "adaptive" : "enabled",
    concurrencyLimit: Number(formData.get("concurrencyLimit")),
    rpmLimit: Number(formData.get("rpmLimit")),
    note: formData.get("note"),
    status: formData.get("enabled") === "on" ? "enabled" : "disabled"
  };
}

function openProviderDialog(provider = null) {
  openDialog({
    title: provider ? "编辑 AI 供应商" : "新建 AI 供应商",
    eyebrow: provider ? "本地配置" : "本地供应商",
    meta: "协议、限流与凭据",
    fields: providerFields(provider),
    dangerLabel: provider ? "删除供应商" : "",
    onSubmit: async (formData) => {
      if (provider) unwrap(await bridge.updateProvider(providerPayload(formData, provider)));
      else unwrap(await bridge.createProvider(providerPayload(formData)));
      showToast(provider ? "本地 AI 供应商配置已保存" : "本地 AI 供应商已创建");
      await refreshConfiguration();
    },
    onDanger: provider ? async () => {
      if (!window.confirm(`确认删除本地供应商“${provider.name}”及其全部模型吗？`)) return false;
      unwrap(await bridge.removeProvider({ providerId: provider.id }));
      showToast("本地 AI 供应商已删除");
      await refreshConfiguration();
      return true;
    } : null
  });
}

function purposeFields(values) {
  return `<fieldset class="form-field"><legend>支持用途（可多选）</legend><div class="local-ai-purpose-options">${MODEL_PURPOSE_OPTIONS.map(([value, label]) => `<label><input name="purposes" type="checkbox" value="${esc(value)}" ${values.purposes.includes(value) ? "checked" : ""}><span>${esc(label)}</span></label>`).join("")}</div></fieldset>`;
}

function modelFields(model = null) {
  const values = modelFormValues(model);
  return field("displayName", "显示名称", "text", values.displayName, { required: true, maxlength: 200 })
    + field("modelId", "模型标识符", "text", values.modelId, { required: true, maxlength: 300 })
    + purposeFields(values)
    + field("contextWindow", "模型上下文令牌总量", "number", values.contextWindow, { min: 32768, max: 2000000, step: 1, required: true })
    + field("temperature", "默认温度", "number", values.temperature, { min: 0, max: 2, step: "any", required: true })
    + field("maxTokens", "默认最大输出令牌数", "number", values.maxTokens, { min: 1, max: 2000000, step: 1, required: true })
    + field("thinkingEnabled", "开启思考模式（供应商需支持相应参数）", "checkbox", values.thinkingEnabled)
    + field("thinkingEffort", "思考强度（模型默认时不发送强度参数）", "select", values.thinkingEffort, { options: MODEL_THINKING_EFFORT_OPTIONS })
    + field("multimodalEnabled", "支持多模态图片理解", "checkbox", values.multimodalEnabled)
    + field("imageToolDefault", "设为多模态读图工具默认模型", "checkbox", values.imageToolDefault)
    + field("enabled", "启用模型", "checkbox", values.enabled);
}

function modelPayload(formData, providerId, model = null) {
  const purposes = formData.getAll("purposes");
  if (purposes.length === 0) throw new Error("请至少选择一个模型用途");
  return {
    ...(model ? { localModelId: model.id } : {}),
    providerId,
    displayName: formData.get("displayName"),
    modelId: formData.get("modelId"),
    purposes,
    contextNote: "",
    contextWindow: Number(formData.get("contextWindow")),
    outputNote: "",
    preset: {
      temperature: Number(formData.get("temperature")),
      max_tokens: Number(formData.get("maxTokens"))
    },
    thinkingEnabled: formData.get("thinkingEnabled") === "on",
    thinkingEffort: formData.get("thinkingEffort"),
    multimodalEnabled: formData.get("multimodalEnabled") === "on",
    imageToolDefault: formData.get("imageToolDefault") === "on",
    enabled: formData.get("enabled") === "on",
    note: ""
  };
}

function openModelDialog(providerId, model = null) {
  openDialog({
    title: model ? "编辑模型" : "添加模型",
    eyebrow: "本地模型",
    meta: "用途、上下文与生成参数",
    fields: modelFields(model),
    dangerLabel: model ? "删除模型" : "",
    onSubmit: async (formData) => {
      if (model) unwrap(await bridge.updateModel(modelPayload(formData, providerId, model)));
      else unwrap(await bridge.createModel(modelPayload(formData, providerId)));
      showToast(model ? "本地 AI 模型配置已保存" : "本地 AI 模型已添加");
      await refreshConfiguration();
    },
    onDanger: model ? async () => {
      if (!window.confirm(`确认删除本地模型“${model.displayName}”吗？`)) return false;
      unwrap(await bridge.removeModel({ modelId: model.id }));
      showToast("本地 AI 模型已删除");
      await refreshConfiguration();
      return true;
    } : null
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
      showToast(result.ok ? "本地 AI 连接测试成功" : result.error, !result.ok);
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
    [{ value: "openai-chat-completions", label: "OpenAI Chat Completions" }]
  );
  bindProviderActions();
}

form.addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
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
    showToast("本地全局系统提示词已保存");
    await refreshConfiguration();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBusy(button, false);
  }
});

if (!bridge) {
  providerList.innerHTML = '<div class="empty-state"><b>Desktop 安全桥接未加载</b>无法读取本地 AI 配置。</div>';
} else {
  refreshConfiguration().catch((error) => {
    providerList.innerHTML = `<div class="empty-state"><b>本地 AI 配置读取失败</b>${esc(error.message)}</div>`;
  });
}
