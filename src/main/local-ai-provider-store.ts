import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LOCAL_AI_PROTOCOL,
  localAiProviderDisplayName,
  parseCreateLocalAiModelInput,
  parseCreateLocalAiProviderInput,
  parseLocalAiModelId,
  parseLocalAiProviderId,
  parseLocalAiSystemPromptInput,
  parseUpdateLocalAiModelInput,
  parseUpdateLocalAiProviderInput,
  type LocalAiConfigurationSummary,
  type LocalAiModelInput,
  type LocalAiModelSummary,
  type LocalAiModelUpdateInput,
  type LocalAiProviderInput,
  type LocalAiProviderSummary,
  type LocalAiProviderUpdateInput,
  type LocalAiWorkspaceCatalog
} from "../shared/local-ai-contract.js";
import { writeDesktopJsonAtomically } from "../shared/storage-manifest.js";
import type { CredentialVault, EncryptedSecret } from "./credential-vault.js";

export const LOCAL_AI_PROVIDER_STORE_VERSION = 3;
export const LEGACY_LOCAL_AI_PROVIDER_STORE_VERSION = 2;
export const LEGACY_LOCAL_AI_PROVIDER_BACKUP_FILENAME = "config.keychain-v2.backup.json";
const LOCAL_AI_PROVIDER_LIMIT = 64;
const LOCAL_AI_MODEL_LIMIT = 512;
const LOCAL_AI_STORE_MAX_BYTES = 4 * 1024 * 1024;

type StoredLocalAiProvider = Omit<LocalAiProviderInput, "apiKey"> & {
  id: string;
  apiKeyCiphertext: EncryptedSecret | null;
  connectionStatus: "unchecked" | "success" | "error";
  lastError: string | null;
  lastSuccessAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type StoredLocalAiModel = LocalAiModelInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

type LocalAiProviderDocument = {
  version: typeof LOCAL_AI_PROVIDER_STORE_VERSION;
  systemPrompt: string;
  providers: StoredLocalAiProvider[];
  models: StoredLocalAiModel[];
  updatedAt: string;
};

export type LocalAiModelCredential = {
  provider: LocalAiProviderSummary & { apiKey: string };
  model: LocalAiModelSummary;
  systemPrompt: string;
};

export class LocalAiProviderStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalAiProviderStoreError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", `${label}包含未知字段`);
  }
}

function assertTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", `${label}无效`);
  }
  return value;
}

function assertNullableTimestamp(value: unknown, label: string): string | null {
  return value === null ? null : assertTimestamp(value, label);
}

function assertConnectionStatus(value: unknown): StoredLocalAiProvider["connectionStatus"] {
  if (value !== "unchecked" && value !== "success" && value !== "error") {
    throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI 连接状态无效");
  }
  return value;
}

function encryptedApiKeyValue(value: unknown): EncryptedSecret | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI API Key 密文无效");
  assertExactKeys(value, ["encrypted", "iv", "tag"], "本地 AI API Key 密文");
  const parts = [value.encrypted, value.iv, value.tag];
  if (parts.some((part) => typeof part !== "string" || part.length > 16_384 || !/^[A-Za-z0-9+/=]+$/u.test(part))) {
    throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI API Key 密文无效");
  }
  return { encrypted: String(value.encrypted), iv: String(value.iv), tag: String(value.tag) };
}

function legacyEncryptedApiKeyPresent(value: unknown): boolean {
  if (value === null) return false;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 16_384
    || !/^[A-Za-z0-9+/=]+$/u.test(value)
  ) throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "旧版本地 AI API Key 密文无效");
  return true;
}

function documentPath(directory: string): string {
  return join(directory, "config.json");
}

function providerSummary(provider: StoredLocalAiProvider): LocalAiProviderSummary {
  return {
    id: provider.id,
    scope: "local",
    name: localAiProviderDisplayName(provider.name),
    baseUrl: provider.baseUrl,
    protocol: LOCAL_AI_PROTOCOL,
    maxTokensParameter: provider.maxTokensParameter,
    thinkingType: provider.thinkingType,
    concurrencyLimit: provider.concurrencyLimit,
    rpmLimit: provider.rpmLimit,
    analysisTimeoutSeconds: provider.analysisTimeoutSeconds,
    note: provider.note,
    status: provider.status,
    connectionStatus: provider.connectionStatus,
    hasApiKey: provider.apiKeyCiphertext !== null,
    apiKey: provider.apiKeyCiphertext === null ? "未配置" : "已保存",
    lastError: provider.lastError,
    lastSuccessAt: provider.lastSuccessAt,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt
  };
}

function modelSummary(model: StoredLocalAiModel, provider: StoredLocalAiProvider): LocalAiModelSummary {
  return {
    ...structuredClone(model),
    scope: "local",
    providerName: localAiProviderDisplayName(provider.name),
    providerStatus: provider.status,
    providerConnectionStatus: provider.connectionStatus
  };
}

export class LocalAiProviderStore {
  constructor(
    private readonly directory: string,
    private readonly credentialVault: CredentialVault
  ) {}

  configuration(): LocalAiConfigurationSummary {
    const document = this.read();
    return {
      systemPrompt: document.systemPrompt,
      providers: document.providers.map(providerSummary),
      models: document.models.map((model) => modelSummary(model, this.requiredProvider(document, model.providerId))),
      updatedAt: document.updatedAt
    };
  }

  workspaceCatalog(): LocalAiWorkspaceCatalog {
    const configuration = this.configuration();
    return {
      models: configuration.models,
      updatedAt: configuration.updatedAt
    };
  }

  list(): LocalAiProviderSummary[] {
    return this.configuration().providers;
  }

  listModels(): LocalAiModelSummary[] {
    return this.configuration().models;
  }

  updateSystemPrompt(value: unknown): string {
    const { systemPrompt } = parseLocalAiSystemPromptInput(value);
    const document = this.read();
    document.systemPrompt = systemPrompt;
    document.updatedAt = new Date().toISOString();
    this.write(document);
    return systemPrompt;
  }

  create(value: LocalAiProviderInput): LocalAiProviderSummary {
    const input = parseCreateLocalAiProviderInput(value);
    const document = this.read();
    if (document.providers.length >= LOCAL_AI_PROVIDER_LIMIT) {
      throw new LocalAiProviderStoreError("LOCAL_AI_PROVIDER_LIMIT_REACHED", `本机最多保存 ${LOCAL_AI_PROVIDER_LIMIT} 个 AI 供应商`);
    }
    const timestamp = new Date().toISOString();
    const provider: StoredLocalAiProvider = {
      id: randomUUID(),
      name: input.name,
      baseUrl: input.baseUrl,
      protocol: LOCAL_AI_PROTOCOL,
      maxTokensParameter: input.maxTokensParameter,
      thinkingType: input.thinkingType,
      concurrencyLimit: input.concurrencyLimit,
      rpmLimit: input.rpmLimit,
      analysisTimeoutSeconds: input.analysisTimeoutSeconds,
      note: input.note,
      status: input.status,
      apiKeyCiphertext: input.apiKey === "" ? null : this.encryptApiKey(input.apiKey),
      connectionStatus: "unchecked",
      lastError: null,
      lastSuccessAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    document.providers.push(provider);
    document.updatedAt = timestamp;
    this.write(document);
    return providerSummary(provider);
  }

  update(value: LocalAiProviderUpdateInput): LocalAiProviderSummary {
    const input = parseUpdateLocalAiProviderInput(value);
    const document = this.read();
    const provider = this.requiredProvider(document, input.providerId);
    const connectionChanged = provider.baseUrl !== input.baseUrl
      || provider.protocol !== input.protocol
      || provider.maxTokensParameter !== input.maxTokensParameter
      || provider.thinkingType !== input.thinkingType
      || input.replaceApiKey;
    provider.name = input.name;
    provider.baseUrl = input.baseUrl;
    provider.protocol = input.protocol;
    provider.maxTokensParameter = input.maxTokensParameter;
    provider.thinkingType = input.thinkingType;
    provider.concurrencyLimit = input.concurrencyLimit;
    provider.rpmLimit = input.rpmLimit;
    provider.analysisTimeoutSeconds = input.analysisTimeoutSeconds;
    provider.note = input.note;
    provider.status = input.status;
    if (input.replaceApiKey) provider.apiKeyCiphertext = input.apiKey === "" ? null : this.encryptApiKey(input.apiKey);
    if (connectionChanged) {
      provider.connectionStatus = "unchecked";
      provider.lastError = null;
      provider.lastSuccessAt = null;
    }
    const timestamp = new Date().toISOString();
    provider.updatedAt = timestamp;
    document.updatedAt = timestamp;
    this.write(document);
    return providerSummary(provider);
  }

  remove(providerIdValue: string): string {
    const providerId = parseLocalAiProviderId(providerIdValue);
    const document = this.read();
    const nextProviders = document.providers.filter((provider) => provider.id !== providerId);
    if (nextProviders.length === document.providers.length) {
      throw new LocalAiProviderStoreError("LOCAL_AI_PROVIDER_NOT_FOUND", "本地 AI 供应商不存在");
    }
    document.providers = nextProviders;
    document.models = document.models.filter((model) => model.providerId !== providerId);
    document.updatedAt = new Date().toISOString();
    this.write(document);
    return providerId;
  }

  createModel(value: LocalAiModelInput): LocalAiModelSummary {
    const input = parseCreateLocalAiModelInput(value);
    const document = this.read();
    const provider = this.requiredProvider(document, input.providerId);
    if (document.models.length >= LOCAL_AI_MODEL_LIMIT) {
      throw new LocalAiProviderStoreError("LOCAL_AI_MODEL_LIMIT_REACHED", `本机最多保存 ${LOCAL_AI_MODEL_LIMIT} 个 AI 模型`);
    }
    const timestamp = new Date().toISOString();
    const model: StoredLocalAiModel = { id: randomUUID(), ...structuredClone(input), createdAt: timestamp, updatedAt: timestamp };
    if (model.imageToolDefault) this.clearImageToolDefault(document);
    document.models.push(model);
    document.updatedAt = timestamp;
    this.write(document);
    return modelSummary(model, provider);
  }

  updateModel(value: LocalAiModelUpdateInput): LocalAiModelSummary {
    const input = parseUpdateLocalAiModelInput(value);
    const document = this.read();
    const model = this.requiredModel(document, input.localModelId);
    if (model.providerId !== input.providerId) {
      throw new LocalAiProviderStoreError("LOCAL_AI_MODEL_PROVIDER_MISMATCH", "本地 AI 模型不能移动到其他供应商");
    }
    const provider = this.requiredProvider(document, input.providerId);
    if (input.imageToolDefault) this.clearImageToolDefault(document, model.id);
    Object.assign(model, structuredClone(input), { id: model.id, updatedAt: new Date().toISOString() });
    delete (model as StoredLocalAiModel & { localModelId?: string }).localModelId;
    document.updatedAt = model.updatedAt;
    this.write(document);
    return modelSummary(model, provider);
  }

  removeModel(modelIdValue: string): string {
    const modelId = parseLocalAiModelId(modelIdValue);
    const document = this.read();
    const next = document.models.filter((model) => model.id !== modelId);
    if (next.length === document.models.length) {
      throw new LocalAiProviderStoreError("LOCAL_AI_MODEL_NOT_FOUND", "本地 AI 模型不存在");
    }
    document.models = next;
    document.updatedAt = new Date().toISOString();
    this.write(document);
    return modelId;
  }

  markConnection(providerIdValue: string, result: { ok: boolean; error?: string }): LocalAiProviderSummary {
    const providerId = parseLocalAiProviderId(providerIdValue);
    const document = this.read();
    const provider = this.requiredProvider(document, providerId);
    const timestamp = new Date().toISOString();
    provider.connectionStatus = result.ok ? "success" : "error";
    provider.lastError = result.ok ? null : String(result.error ?? "本地 AI 连接测试失败").slice(0, 500);
    provider.lastSuccessAt = result.ok ? timestamp : provider.lastSuccessAt;
    provider.updatedAt = timestamp;
    document.updatedAt = timestamp;
    this.write(document);
    return providerSummary(provider);
  }

  credential(modelIdValue: string): LocalAiModelCredential {
    const modelId = parseLocalAiModelId(modelIdValue);
    const document = this.read();
    const model = this.requiredModel(document, modelId);
    const provider = this.requiredProvider(document, model.providerId);
    let apiKey = "";
    if (provider.apiKeyCiphertext !== null) {
      try {
        apiKey = this.credentialVault.decrypt(provider.apiKeyCiphertext);
      } catch {
        throw new LocalAiProviderStoreError("LOCAL_AI_API_KEY_DECRYPT_FAILED", "无法解锁本地 AI API Key");
      }
      if (apiKey.length === 0 || apiKey.length > 8_192) {
        throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI API Key 密文无效");
      }
    }
    return {
      provider: { ...providerSummary(provider), apiKey },
      model: modelSummary(model, provider),
      systemPrompt: document.systemPrompt
    };
  }

  private read(): LocalAiProviderDocument {
    const path = documentPath(this.directory);
    if (!existsSync(path)) {
      return {
        version: LOCAL_AI_PROVIDER_STORE_VERSION,
        systemPrompt: "",
        providers: [],
        models: [],
        updatedAt: new Date(0).toISOString()
      };
    }
    if (statSync(path).size > LOCAL_AI_STORE_MAX_BYTES) {
      throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI 配置存储过大");
    }
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI 配置存储无法读取");
    }
    if (!isRecord(value)) throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI 配置存储格式无效");
    assertExactKeys(value, ["version", "systemPrompt", "providers", "models", "updatedAt"], "本地 AI 配置存储");
    if (
      (value.version !== LOCAL_AI_PROVIDER_STORE_VERSION && value.version !== LEGACY_LOCAL_AI_PROVIDER_STORE_VERSION)
      || !Array.isArray(value.providers)
      || value.providers.length > LOCAL_AI_PROVIDER_LIMIT
      || !Array.isArray(value.models)
      || value.models.length > LOCAL_AI_MODEL_LIMIT
    ) throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI 配置存储版本或数量无效");
    const systemPrompt = parseLocalAiSystemPromptInput({ systemPrompt: value.systemPrompt }).systemPrompt;
    const legacyKeychainDocument = value.version === LEGACY_LOCAL_AI_PROVIDER_STORE_VERSION;
    const providers = value.providers.map((item) => (
      legacyKeychainDocument ? this.parseLegacyKeychainProvider(item) : this.parseProvider(item)
    ));
    const models = value.models.map((item) => this.parseModel(item));
    if (new Set(providers.map((provider) => provider.id)).size !== providers.length) {
      throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI 供应商 id 重复");
    }
    if (new Set(models.map((model) => model.id)).size !== models.length) {
      throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI 模型 id 重复");
    }
    const providerIds = new Set(providers.map((provider) => provider.id));
    if (models.some((model) => !providerIds.has(model.providerId))) {
      throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI 模型引用了不存在的供应商");
    }
    if (models.filter((model) => model.imageToolDefault).length > 1) {
      throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI 默认读图模型重复");
    }
    const document: LocalAiProviderDocument = {
      version: LOCAL_AI_PROVIDER_STORE_VERSION,
      systemPrompt,
      providers,
      models,
      updatedAt: assertTimestamp(value.updatedAt, "本地 AI 配置更新时间")
    };
    if (legacyKeychainDocument) {
      const backupPath = join(this.directory, LEGACY_LOCAL_AI_PROVIDER_BACKUP_FILENAME);
      if (!existsSync(backupPath)) writeDesktopJsonAtomically(backupPath, value);
      this.write(document);
    }
    return document;
  }

  private parseLegacyKeychainProvider(value: unknown): StoredLocalAiProvider {
    if (!isRecord(value)) throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "旧版本地 AI 供应商记录无效");
    assertExactKeys(value, [
      "id",
      "name",
      "baseUrl",
      "protocol",
      "maxTokensParameter",
      "thinkingType",
      "concurrencyLimit",
      "rpmLimit",
      "note",
      "status",
      "encryptedApiKey",
      "connectionStatus",
      "lastError",
      "lastSuccessAt",
      "createdAt",
      "updatedAt"
    ], "旧版本地 AI 供应商记录");
    const hadLegacyApiKey = legacyEncryptedApiKeyPresent(value.encryptedApiKey);
    const normalized = parseCreateLocalAiProviderInput({
      name: value.name,
      baseUrl: value.baseUrl,
      apiKey: "",
      protocol: value.protocol,
      maxTokensParameter: value.maxTokensParameter,
      thinkingType: value.thinkingType,
      concurrencyLimit: value.concurrencyLimit,
      rpmLimit: value.rpmLimit,
      note: value.note,
      status: value.status
    });
    if (value.baseUrl !== normalized.baseUrl || (value.lastError !== null && (typeof value.lastError !== "string" || value.lastError.length > 500))) {
      throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "旧版本地 AI 供应商字段无效");
    }
    const { apiKey: _apiKey, ...storedFields } = normalized;
    return {
      id: parseLocalAiProviderId(value.id),
      ...storedFields,
      apiKeyCiphertext: null,
      connectionStatus: hadLegacyApiKey ? "unchecked" : assertConnectionStatus(value.connectionStatus),
      lastError: hadLegacyApiKey ? "API 密钥需要重新填写" : value.lastError,
      lastSuccessAt: hadLegacyApiKey ? null : assertNullableTimestamp(value.lastSuccessAt, "本地 AI 上次连接成功时间"),
      createdAt: assertTimestamp(value.createdAt, "本地 AI 供应商创建时间"),
      updatedAt: assertTimestamp(value.updatedAt, "本地 AI 供应商更新时间")
    };
  }

  private parseProvider(value: unknown): StoredLocalAiProvider {
    if (!isRecord(value)) throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI 供应商记录无效");
    assertExactKeys(value, [
      "id",
      "name",
      "baseUrl",
      "protocol",
      "maxTokensParameter",
      "thinkingType",
      "concurrencyLimit",
      "rpmLimit",
      "analysisTimeoutSeconds",
      "note",
      "status",
      "apiKeyCiphertext",
      "connectionStatus",
      "lastError",
      "lastSuccessAt",
      "createdAt",
      "updatedAt"
    ], "本地 AI 供应商记录");
    const normalized = parseCreateLocalAiProviderInput({
      name: value.name,
      baseUrl: value.baseUrl,
      apiKey: "",
      protocol: value.protocol,
      maxTokensParameter: value.maxTokensParameter,
      thinkingType: value.thinkingType,
      concurrencyLimit: value.concurrencyLimit,
      rpmLimit: value.rpmLimit,
      analysisTimeoutSeconds: value.analysisTimeoutSeconds,
      note: value.note,
      status: value.status
    });
    if (value.baseUrl !== normalized.baseUrl || (value.lastError !== null && (typeof value.lastError !== "string" || value.lastError.length > 500))) {
      throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI 供应商字段无效");
    }
    const { apiKey: _apiKey, ...storedFields } = normalized;
    return {
      id: parseLocalAiProviderId(value.id),
      ...storedFields,
      apiKeyCiphertext: encryptedApiKeyValue(value.apiKeyCiphertext),
      connectionStatus: assertConnectionStatus(value.connectionStatus),
      lastError: value.lastError,
      lastSuccessAt: assertNullableTimestamp(value.lastSuccessAt, "本地 AI 上次连接成功时间"),
      createdAt: assertTimestamp(value.createdAt, "本地 AI 供应商创建时间"),
      updatedAt: assertTimestamp(value.updatedAt, "本地 AI 供应商更新时间")
    };
  }

  private parseModel(value: unknown): StoredLocalAiModel {
    if (!isRecord(value)) throw new LocalAiProviderStoreError("LOCAL_AI_STORE_INVALID", "本地 AI 模型记录无效");
    assertExactKeys(value, [
      "id",
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
      "note",
      "createdAt",
      "updatedAt"
    ], "本地 AI 模型记录");
    return {
      id: parseLocalAiModelId(value.id),
      ...parseCreateLocalAiModelInput({
        providerId: value.providerId,
        displayName: value.displayName,
        modelId: value.modelId,
        purposes: value.purposes,
        contextNote: value.contextNote,
        contextWindow: value.contextWindow,
        outputNote: value.outputNote,
        preset: value.preset,
        thinkingEnabled: value.thinkingEnabled,
        thinkingEffort: value.thinkingEffort,
        multimodalEnabled: value.multimodalEnabled,
        imageToolDefault: value.imageToolDefault,
        enabled: value.enabled,
        note: value.note
      }),
      createdAt: assertTimestamp(value.createdAt, "本地 AI 模型创建时间"),
      updatedAt: assertTimestamp(value.updatedAt, "本地 AI 模型更新时间")
    };
  }

  private requiredProvider(document: LocalAiProviderDocument, providerId: string): StoredLocalAiProvider {
    const provider = document.providers.find((item) => item.id === providerId);
    if (!provider) throw new LocalAiProviderStoreError("LOCAL_AI_PROVIDER_NOT_FOUND", "本地 AI 供应商不存在");
    return provider;
  }

  private requiredModel(document: LocalAiProviderDocument, modelId: string): StoredLocalAiModel {
    const model = document.models.find((item) => item.id === modelId);
    if (!model) throw new LocalAiProviderStoreError("LOCAL_AI_MODEL_NOT_FOUND", "本地 AI 模型不存在");
    return model;
  }

  private clearImageToolDefault(document: LocalAiProviderDocument, exceptModelId = ""): void {
    for (const model of document.models) {
      if (model.id !== exceptModelId) model.imageToolDefault = false;
    }
  }

  private write(document: LocalAiProviderDocument): void {
    writeDesktopJsonAtomically(documentPath(this.directory), document);
  }

  private encryptApiKey(apiKey: string): EncryptedSecret {
    try {
      return this.credentialVault.encrypt(apiKey);
    } catch {
      throw new LocalAiProviderStoreError("LOCAL_AI_API_KEY_ENCRYPT_FAILED", "本地 master.key 未能保存 AI API Key");
    }
  }

}
