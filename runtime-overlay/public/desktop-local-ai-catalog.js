const LOCAL_PROVIDER_PREFIX = "local/";

function localProviderName(value) {
  const name = String(value ?? "").trim().replace(/^local\/+\s*/iu, "").trim();
  return `${LOCAL_PROVIDER_PREFIX}${name || "未命名供应商"}`;
}

export function mergeDesktopLocalAiModels(serverModels, localModels) {
  const serverCatalog = Array.isArray(serverModels) ? serverModels : [];
  const localCatalog = Array.isArray(localModels) ? localModels : [];
  const serverModelIds = new Set(serverCatalog.map((model) => model?.id));
  const isolatedLocalModels = localCatalog
    .filter((model) => model?.scope === "local" && !serverModelIds.has(model.id))
    .map((model) => ({ ...model, providerName: localProviderName(model.providerName) }));
  return [...serverCatalog, ...isolatedLocalModels];
}
