const MODEL_THINKING_EFFORT_OPTIONS = [
  ["default", "模型默认"],
  ["auto", "自动（auto）"],
  ["low", "低（low）"],
  ["medium", "中（medium）"],
  ["high", "高（high）"],
  ["xhigh", "超高（xhigh）"],
  ["max", "最高（max）"]
];

function providerConnectionLabel(value) {
  return ({ unchecked: "未测试", success: "连接正常", error: "连接失败" })[value] ?? String(value ?? "未测试");
}

function providerProtocolLabel(value, protocolOptions = []) {
  return protocolOptions.find((option) => option.value === value)?.label ?? String(value ?? "OpenAI Chat Completions");
}

function providerStatusLabel(value) {
  return value === "enabled" ? "已启用" : value === "disabled" ? "已停用" : String(value ?? "未知");
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

function emptyProviderConfiguration() {
  return '<div class="empty-state"><b>尚未配置 AI 供应商</b>添加供应商后，再配置要使用的模型。</div>';
}

function modelThinkingEffortLabel(model) {
  return MODEL_THINKING_EFFORT_OPTIONS.find(([value]) => value === model.thinkingEffort)?.[1] ?? "模型默认";
}

function modelKindLabel(model) {
  return model.modelKind === "embedding" ? "Embedding" : model.modelKind === "rerank" ? "Rerank" : "Chat";
}

function providerScopeLabel(provider) {
  return provider.scope === "local" ? "本地" : "平台级";
}

export function renderAiProviderConfigurationCards(providers, models, protocolOptions = [], { showScope = true } = {}) {
  if (!Array.isArray(providers) || providers.length === 0) return emptyProviderConfiguration();
  return `<div class="card-grid provider-card-grid">${providers.map((provider) => {
    const providerModels = models.filter((model) => model.providerId === provider.id);
    const providerStatusClass = provider.status === "disabled" ? "is-disabled" : provider.status === "error" ? "is-error" : "is-enabled";
    const disabledNotice = provider.status === "disabled"
      ? '<div class="provider-disabled-notice" role="status"><strong>已停用</strong><span>不会出现在新任务的模型列表中，历史任务仍可查看。</span></div>'
      : "";
    return `
    <article class="record-card provider-card ${provider.status === "disabled" ? "is-disabled" : ""}"><div class="provider-card-meta"><small>${showScope ? `<span class="provider-scope-badge ${provider.scope === "local" ? "is-local" : ""}">${esc(providerScopeLabel(provider))}</span> · ` : ""}${esc(providerProtocolLabel(provider.protocol, protocolOptions))} · ${esc(providerConnectionLabel(provider.connectionStatus))}</small><span class="provider-status-badge ${providerStatusClass}">${esc(providerStatusLabel(provider.status))}</span></div><h3>${esc(provider.name)}</h3>
    ${disabledNotice}<p>${esc(provider.baseUrl)}\n密钥：${esc(provider.apiKey)}\n最大输出参数：${esc(provider.maxTokensParameter ?? "max_tokens")}\n思考类型：${esc(provider.thinkingType ?? "enabled")}\n并发：${Number(provider.concurrencyLimit) || 10} · 每分钟请求：${Number(provider.rpmLimit) || 10}\n分析请求超时：${Number(provider.analysisTimeoutSeconds) || 300} 秒${provider.scope === "local" ? "" : `\n每日 Token 额度：${provider.dailyTokenQuota === null || provider.dailyTokenQuota === undefined ? "未限制" : Number(provider.dailyTokenQuota).toLocaleString("zh-CN")} · 每月 Token 额度：${provider.monthlyTokenQuota === null || provider.monthlyTokenQuota === undefined ? "未限制" : Number(provider.monthlyTokenQuota).toLocaleString("zh-CN")}`}${provider.lastError ? `\n错误：${esc(provider.lastError)}` : ""}</p>
    <div class="provider-models">${providerModels.map((model) => {
      const modelUnavailable = !model.enabled || provider.status !== "enabled" || provider.connectionStatus !== "success";
      const modelStatus = !model.enabled
        ? '<span class="model-status-badge is-disabled">模型已停用</span>'
        : provider.connectionStatus !== "success"
          ? '<span class="model-status-badge is-unavailable">连接不可用</span>'
          : "";
      const capability = model.multimodalEnabled ? " · 多模态" : "";
      const defaultBadge = model.imageToolDefault ? " · 默认读图模型" : "";
      const modelKind = model.modelKind === "embedding" || model.modelKind === "rerank" ? model.modelKind : "chat";
      return `<div class="provider-model-row${modelUnavailable ? " is-unavailable" : ""}"><button class="pill model-pill" type="button" data-edit-model="${esc(model.id)}" aria-label="编辑模型 ${esc(model.displayName)}">${esc(model.displayName)} · ${esc(modelKindLabel(model))} · ${model.enabled ? "启用" : "停用"}${capability}${defaultBadge}${modelKind === "chat" ? ` · 思考模式 ${model.thinkingEnabled ? "开启" : "关闭"} · 思考强度 ${esc(modelThinkingEffortLabel(model))} · 上下文 ${Number(model.contextWindow ?? 128000).toLocaleString("zh-CN")} 令牌 · 最大输出 ${Number(model.preset?.max_tokens ?? 32000).toLocaleString("zh-CN")}` : ""}</button>${modelStatus}</div>`;
    }).join("")}</div>
    <div class="card-actions"><button data-edit-provider="${esc(provider.id)}">编辑配置</button>${provider.status === "enabled" ? `<button data-test-provider="${esc(provider.id)}" ${providerModels.length ? "" : 'disabled aria-disabled="true" title="请先添加模型"'}>测试连接</button>${provider.scope === "local" ? "" : `<button data-import-provider-models="${esc(provider.id)}">获取模型</button>`}` : ""}<button data-add-model="${esc(provider.id)}">添加模型</button></div></article>`;
  }).join("")}</div>`;
}
