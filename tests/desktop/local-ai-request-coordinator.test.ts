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
      models: [expect.objectContaining({ id: modelId, scope: "local", providerName: "local/本机模型" })],
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

  it("原样转发 Server Agent 的 tools 并把本地 Prompt 追加到系统提示词", async () => {
    const { store, modelId } = configuredStore();
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("desktop-local-model");
      expect(body.tool_choice).toBe("auto");
      expect(body.tools).toEqual([expect.objectContaining({ function: expect.objectContaining({ name: "story_index" }) })]);
      expect(JSON.stringify(body.messages)).toContain("远端规则");
      expect(JSON.stringify(body.messages)).toContain("<desktop_local_ai_prompt>");
      expect(JSON.stringify(body.messages)).toContain("只在本机使用");
      return new Response(JSON.stringify({
        choices: [{
          finish_reason: "tool_calls",
          message: {
            content: null,
            tool_calls: [{ id: "call-1", type: "function", function: { name: "story_index", arguments: "{}" } }]
          }
        }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const coordinator = new LocalAiRequestCoordinator(store, new LocalAiClient(fetchImpl));
    const result = await coordinator.completeAgentRound({
      requestId: "desktop-local-ai-completion_1234567890abcdef",
      modelId,
      taskType: "chat",
      purpose: "generation",
      body: {
        model: "desktop-local-model",
        messages: [{ role: "system", content: "远端规则" }, { role: "user", content: "查询作品" }],
        tools: [{ type: "function", function: { name: "story_index", parameters: { type: "object", properties: {} } } }],
        tool_choice: "auto",
        max_tokens: 4096,
        stream: false
      },
      timeoutMs: 180_000
    });
    expect(result.status).toBe(200);
    expect(result.retryAfter).toBeNull();
    expect(JSON.parse(result.body)).toMatchObject({
      choices: [{ message: { tool_calls: [{ function: { name: "story_index" } }] } }]
    });
  });
});
