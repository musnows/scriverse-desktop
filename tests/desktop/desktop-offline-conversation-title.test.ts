import { describe, expect, it } from "vitest";
import { DesktopOfflineApi } from "../../runtime-overlay/public/desktop-offline-api.js";
import { createMemoryAiConversationRepository, DesktopOfflineConversations } from "../../runtime-overlay/public/desktop-offline-conversations.js";

const model = { id: "local-model", modelId: "test-model", scope: "local", enabled: true, providerProtocol: "openai-chat-completions", purposes: ["chat"], contextWindow: 4096 };

async function fixture(complete?: (input: Record<string, unknown>) => Promise<unknown>) {
  const conversations = new DesktopOfflineConversations(createMemoryAiConversationRepository());
  const source = await conversations.create("work-1");
  const calls: Record<string, unknown>[] = [];
  const api = new DesktopOfflineApi({ store: {} }, { conversations, aiBridge: {
    catalog: async () => ({ ok: true, data: { models: [model] } }),
    completeAgentRound: async (input: Record<string, unknown>) => {
      calls.push(input);
      return complete ? complete(input) : { ok: true, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: '标题：“林夏的夜航”' } }] }) } };
    }
  } });
  return { conversations, source, calls, api };
}

describe("offline AI conversation titles", () => {
  it("generates a readable title with the local model after the first completed turn", async () => {
    const { conversations, source, api, calls } = await fixture();
    await conversations.addMessage(source.id, { role: "user", content: '<user_message>介绍 <ai_reference kind="character" id="character-1">林夏</ai_reference></user_message>', metadata: { modelId: model.id } });
    await api.request(`/api/ai-conversations/${source.id}/title`);
    expect(calls).toHaveLength(0);
    await conversations.addMessage(source.id, { role: "assistant", content: "林夏在海边启程。" });
    expect(await api.request(`/api/ai-conversations/${source.id}/title`)).toMatchObject({ title: "林夏的夜航" });
    expect(calls[0]).toMatchObject({ modelId: model.id, purpose: "tool-context-compaction", body: { max_tokens: 256, thinking: { type: "disabled" } } });
    expect(calls[0].body).not.toHaveProperty("tools");
    expect(JSON.stringify(calls[0].body)).toContain("介绍 林夏");
    expect(JSON.stringify(calls[0].body)).not.toContain("ai_reference");
    await api.request(`/api/ai-conversations/${source.id}/title`);
    expect(calls).toHaveLength(1);
  });

  it("preserves a manual rename and new messages during background title generation", async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const { conversations, source, api, calls } = await fixture(async () => {
      entered?.();
      await wait;
      return { ok: true, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: "AI 标题" } }] }) } };
    });
    await conversations.addMessage(source.id, { role: "user", content: "作者指令" });
    await conversations.addMessage(source.id, { role: "assistant", content: "助手回答" });
    const pending = api.request(`/api/ai-conversations/${source.id}/title`);
    await reached;
    const duplicate = api.request(`/api/ai-conversations/${source.id}/title`);
    await conversations.setTitle(source.id, { title: "作者指令" });
    await conversations.addMessage(source.id, { role: "user", content: "新的消息" });
    release?.();
    expect(await pending).toMatchObject({ title: "作者指令" });
    await duplicate;
    expect(calls).toHaveLength(1);
    expect((await conversations.require(source.id)).messages).toHaveLength(3);
  });

  it("retains the provisional title on provider failure and never rewrites fork names", async () => {
    const { conversations, source, api, calls } = await fixture(async () => ({ ok: false, error: { code: "LOCAL_AI_FAILED", message: "Provider unavailable" } }));
    await conversations.addMessage(source.id, { role: "user", content: "海边的新故事" });
    const assistant = await conversations.addMessage(source.id, { role: "assistant", content: "助手回答" });
    expect(await api.request(`/api/ai-conversations/${source.id}/title`)).toMatchObject({ title: "海边的新故事" });
    expect((await conversations.require(source.id)).titleGenerated).toBe(false);
    const fork = await conversations.fork(source.id, { messageId: assistant.id });
    expect(await api.request(`/api/ai-conversations/${fork.id}/title`)).toMatchObject({ title: "海边的新故事 · 分支" });
    expect(calls).toHaveLength(1);
  });
});
