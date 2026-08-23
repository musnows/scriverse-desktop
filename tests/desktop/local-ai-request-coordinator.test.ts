import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalAiClient } from "../../src/main/local-ai-client.js";
import { LocalAiProviderStore } from "../../src/main/local-ai-provider-store.js";
import { LocalAiRequestCoordinator } from "../../src/main/local-ai-request-coordinator.js";
import { CredentialVault } from "../../src/main/credential-vault.js";

function credentialVault(): CredentialVault {
  return new CredentialVault("local-ai-coordinator-test-secret-1234567890");
}

function configuredStore(): { store: LocalAiProviderStore; modelId: string } {
  const store = new LocalAiProviderStore(
    join(tmpdir(), `scriverse-local-ai-coordinator-${process.pid}-${crypto.randomUUID()}`),
    credentialVault()
  );
  const provider = store.create({
    name: "本机模型",
    baseUrl: "http://127.0.0.1:13245/v1",
    apiKey: "",
    protocol: "openai-chat-completions",
    maxTokensParameter: "max_tokens",
    thinkingType: "enabled",
    concurrencyLimit: 1,
    rpmLimit: 10,
    analysisTimeoutSeconds: 300,
    note: "",
    status: "enabled"
  });
  const model = store.createModel({
    providerId: provider.id,
    displayName: "Desktop Local Model",
    modelId: "desktop-local-model",
    purposes: ["chat"],
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
  });
  store.updateSystemPrompt({ systemPrompt: "只在本机使用" });
  return { store, modelId: model.id };
}

describe("Desktop 本地 AI 请求协调器", () => {
  it("工作区目录不暴露本地 Prompt、供应商地址或凭据", () => {
    const { store, modelId } = configuredStore();
    const coordinator = new LocalAiRequestCoordinator(store, new LocalAiClient());
    expect(coordinator.catalog()).toEqual({
      models: [expect.objectContaining({ id: modelId, scope: "local", providerName: "本机模型" })],
      updatedAt: expect.any(String)
    });
    expect(coordinator.catalog()).not.toHaveProperty("systemPrompt");
    expect(coordinator.catalog()).not.toHaveProperty("providers");
  });

  it("用请求 id 防止重复调用并支持取消活动请求", async () => {
    const { store, modelId } = configuredStore();
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const coordinator = new LocalAiRequestCoordinator(store, new LocalAiClient(fetchImpl));
    const requestId = "33333333-3333-4333-8333-333333333333";
    const input = {
      requestId,
      modelId,
      taskType: "book-analysis" as const,
      remoteSystemPrompt: "远端规则",
      messages: [{ role: "user" as const, content: "继续" }]
    };
    const active = coordinator.complete(input);
    await expect(coordinator.complete(input)).rejects.toMatchObject({ code: "LOCAL_AI_REQUEST_IN_PROGRESS" });
    expect(coordinator.cancel(requestId)).toBe(true);
    await expect(active).rejects.toMatchObject({ code: "LOCAL_AI_CANCELLED" });
    expect(coordinator.cancel(requestId)).toBe(false);
  });
});
