import { readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
    note: "本机模型",
    status: "enabled"
  };
}

function modelInput(providerId: string): LocalAiModelInput {
  return {
    providerId,
    displayName: "Qwen 3 8B",
    modelId: "qwen3:8b",
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
      providers: [{ id: provider.id, scope: "local", hasApiKey: true }],
      models: [{ id: model.id, providerId: provider.id, scope: "local" }]
    });
    const credential: LocalAiModelCredential = store.credential(model.id);
    expect(credential.provider.apiKey).toBe("local-secret-key");
    expect(credential.model.modelId).toBe("qwen3:8b");
    const path = join(directory, "config.json");
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain("local-secret-key");
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
    expect(store.updateModel({ ...modelInput(provider.id), localModelId: model.id, enabled: false })).toMatchObject({ enabled: false });
  });
});
