import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LEGACY_LOCAL_AI_PROVIDER_BACKUP_FILENAME,
  LocalAiProviderStore,
  type LocalAiModelCredential
} from "../../src/main/local-ai-provider-store.js";
import { CredentialVault } from "../../src/main/credential-vault.js";
import type { LocalAiModelInput, LocalAiProviderInput } from "../../src/shared/local-ai-contract.js";

function testDirectory(): string {
  return join(tmpdir(), `scriverse-local-ai-${process.pid}-${crypto.randomUUID()}`);
}

function credentialVault(): CredentialVault {
  return new CredentialVault("local-ai-test-master-secret-1234567890");
}

function providerInput(apiKey = "local-secret-key"): LocalAiProviderInput {
  return {
    name: "本机 Ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKey,
    protocol: "openai-chat-completions",
    maxTokensParameter: "max_tokens",
    thinkingType: "enabled",
    concurrencyLimit: 10,
    rpmLimit: 10,
    analysisTimeoutSeconds: 300,
    note: "本机模型",
    status: "enabled"
  };
}

function modelInput(providerId: string): LocalAiModelInput {
  return {
    providerId,
    displayName: "Qwen 3 8B",
    modelId: "qwen3:8b",
    modelKind: "chat",
    purposes: ["chat", "continue"],
    contextNote: "",
    contextWindow: 128_000,
    outputNote: "",
    preset: { temperature: 0.7, max_tokens: 4096 },
    thinkingEnabled: true,
    thinkingEffort: "default",
    multimodalEnabled: false,
    imageToolDefault: false,
    enabled: true,
    note: ""
  };
}

describe("Desktop 本地 AI 供应商存储", () => {
  it("在设备级配置中保存供应商、模型与 Prompt，并只把系统密文写入本机", () => {
    const directory = testDirectory();
    const store = new LocalAiProviderStore(directory, credentialVault());
    const provider = store.create(providerInput());
    const model = store.createModel(modelInput(provider.id));
    store.updateSystemPrompt({ systemPrompt: "仅使用简体中文" });
    expect(store.configuration()).toMatchObject({
      systemPrompt: "仅使用简体中文",
      providers: [{ id: provider.id, scope: "local", name: "local/本机 Ollama", hasApiKey: true, analysisTimeoutSeconds: 300 }],
      models: [{ id: model.id, providerId: provider.id, providerName: "local/本机 Ollama", scope: "local" }]
    });
    const credential: LocalAiModelCredential = store.credential(model.id);
    expect(credential.provider.apiKey).toBe("local-secret-key");
    expect(credential.model.modelId).toBe("qwen3:8b");
    const path = join(directory, "config.json");
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("local-secret-key");
    expect(JSON.parse(source).providers[0].name).toBe("本机 Ollama");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("无 API Key 的局域网端点不写入伪加密字段", () => {
    const store = new LocalAiProviderStore(testDirectory(), credentialVault());
    const provider = store.create({ ...providerInput(""), baseUrl: "http://192.168.1.20:12345/v1" });
    const model = store.createModel(modelInput(provider.id));
    expect(store.credential(model.id).provider.apiKey).toBe("");
    expect(store.remove(provider.id)).toBe(provider.id);
    expect(store.configuration()).toMatchObject({ providers: [], models: [] });
  });

  it("供应商连接状态与模型启用状态保留在本机", () => {
    const store = new LocalAiProviderStore(testDirectory(), credentialVault());
    const provider = store.create(providerInput());
    const model = store.createModel(modelInput(provider.id));
    expect(store.markConnection(provider.id, { ok: true })).toMatchObject({ connectionStatus: "success" });
    expect(store.update({ ...providerInput(), name: "local/本机 Ollama", providerId: provider.id, replaceApiKey: false })).toMatchObject({
      name: "local/本机 Ollama"
    });
    expect(store.updateModel({ ...modelInput(provider.id), localModelId: model.id, enabled: false })).toMatchObject({ enabled: false });
  });

  it("保存 embedding 与 rerank 专用模型类型", () => {
    const store = new LocalAiProviderStore(testDirectory(), credentialVault());
    const provider = store.create({ ...providerInput(), protocol: "openai-responses" });
    const embedding = store.createModel({
      ...modelInput(provider.id),
      displayName: "Embedding",
      modelId: "embedding-local",
      modelKind: "embedding",
      purposes: [],
      thinkingEnabled: false
    });
    const rerank = store.createModel({
      ...modelInput(provider.id),
      displayName: "Rerank",
      modelId: "rerank-local",
      modelKind: "rerank",
      purposes: [],
      thinkingEnabled: false
    });
    expect(store.configuration().models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: embedding.id, modelKind: "embedding", purposes: [] }),
      expect.objectContaining({ id: rerank.id, modelKind: "rerank", purposes: [] })
    ]));
  });

  it("无 Keychain 地迁移 v2 配置并保留供应商与模型", () => {
    const directory = testDirectory();
    const providerId = "11111111-1111-4111-8111-111111111111";
    const modelId = "22222222-2222-4222-8222-222222222222";
    const timestamp = "2026-08-23T12:16:15.692Z";
    const { modelKind: _modelKind, ...legacyModel } = modelInput(providerId);
    mkdirSync(directory, { recursive: true });
    const legacy = {
      version: 2,
      systemPrompt: "旧本地规则",
      providers: [{
        id: providerId,
        name: "LM-Studio",
        baseUrl: "http://127.0.0.1:12345/v1",
        protocol: "openai-chat-completions",
        maxTokensParameter: "max_tokens",
        thinkingType: "enabled",
        concurrencyLimit: 10,
        rpmLimit: 10,
        note: "旧配置",
        status: "enabled",
        encryptedApiKey: "bGVnYWN5LWtleQ==",
        connectionStatus: "success",
        lastError: null,
        lastSuccessAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp
      }],
      models: [{ id: modelId, ...legacyModel, createdAt: timestamp, updatedAt: timestamp }],
      updatedAt: timestamp
    };
    writeFileSync(join(directory, "config.json"), `${JSON.stringify(legacy, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

    const store = new LocalAiProviderStore(directory, credentialVault());
    expect(store.configuration()).toMatchObject({
      systemPrompt: "旧本地规则",
      providers: [{ id: providerId, name: "local/LM-Studio", hasApiKey: false, analysisTimeoutSeconds: 300, lastError: "API 密钥需要重新填写" }],
      models: [{ id: modelId, providerId, providerName: "local/LM-Studio" }]
    });
    expect(store.credential(modelId).provider.apiKey).toBe("");

    const migrated = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
    expect(migrated).toMatchObject({
      version: 4,
      providers: [{ id: providerId, apiKeyCiphertext: null }],
      models: [{ id: modelId, modelKind: "chat" }]
    });
    expect(migrated.providers[0]).not.toHaveProperty("encryptedApiKey");
    const backupPath = join(directory, LEGACY_LOCAL_AI_PROVIDER_BACKUP_FILENAME);
    expect(existsSync(backupPath)).toBe(true);
    expect(JSON.parse(readFileSync(backupPath, "utf8"))).toMatchObject({
      version: 2,
      providers: [{ id: providerId, encryptedApiKey: "bGVnYWN5LWtleQ==" }]
    });
  });
});
