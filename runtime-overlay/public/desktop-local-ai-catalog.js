const LOCAL_PROVIDER_PREFIX = "local/";

function localProviderName(value) {
  const name = String(value ?? "").trim().replace(/^local\/+\s*/iu, "").trim();
  return `${LOCAL_PROVIDER_PREFIX}${name || "未命名供应商"}`;
}

export function isDesktopWorkspaceSelectableModel(model, isServerSelectable) {
  // Server 的 isSelectableModel 要求连接探测成功。本地供应商创建后默认是 unchecked，
  // 已启用的本机对话模型仍应出现在在线工作区的模型列表中。
  if (model?.scope === "local") {
    return (model.modelKind ?? "chat") === "chat"
      && model.enabled !== false
      && model.providerStatus === "enabled";
  }
  return typeof isServerSelectable === "function" ? Boolean(isServerSelectable(model)) : false;
}

export function mergeDesktopLocalAiModels(serverModels, localModels) {
  const serverCatalog = Array.isArray(serverModels) ? serverModels : [];
  const localCatalog = Array.isArray(localModels) ? localModels : [];
  const serverModelIds = new Set(serverCatalog.map((model) => model?.id));
  const isolatedLocalModels = localCatalog
    .filter((model) => model?.scope === "local" && (model.modelKind ?? "chat") === "chat" && !serverModelIds.has(model.id))
    .map((model) => ({ ...model, providerName: localProviderName(model.providerName) }));
  return [...serverCatalog, ...isolatedLocalModels];
}
