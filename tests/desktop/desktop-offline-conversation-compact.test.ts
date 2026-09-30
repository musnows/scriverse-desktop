import { describe, expect, it } from "vitest";
import { DesktopOfflineApi } from "../../runtime-overlay/public/desktop-offline-api.js";
import { createMemoryAiConversationRepository, DesktopOfflineConversations } from "../../runtime-overlay/public/desktop-offline-conversations.js";

const model = { id: "local-model", modelId: "test-model", scope: "local", enabled: true, providerProtocol: "openai-chat-completions", purposes: ["chat"], contextWindow: 4096 };
const memory = { authorGoals: [{ text: "继续创作林夏的故事", sourceMessageIds: [] }], confirmedDecisions: [], storyFacts: [], constraints: [], unresolvedQuestions: [], importantReferences: [] };

async function fixture(complete?: (input: Record<string, unknown>) => Promise<unknown>) {
  const conversations = new DesktopOfflineConversations(createMemoryAiConversationRepository());
  const source = await conversations.create("work-1", { title: "长夜" });
  for (let index = 0; index < 12; index += 1) await conversations.addMessage(source.id, { role: index % 2 ? "assistant" : "user", content: `林夏的第 ${index + 1} 条消息。` });
  const calls: Record<string, unknown>[] = [];
  const api = new DesktopOfflineApi({ store: {} }, {
    conversations,
    estimateTokens: (value: string) => Math.max(1, Math.ceil(value.length / 2)),
    aiBridge: {
      catalog: async () => ({ ok: true, data: { models: [model] } }),
      completeAgentRound: async (input: Record<string, unknown>) => {
        calls.push(input);
        if (complete) return complete(input);
        return { ok: true, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(memory) } }] }) } };
      }
    }
  });
  return { conversations, source, api, calls };
}

describe("offline context compaction", () => {
  it("uses a local model and retains the complete transcript for export and forks", async () => {
    const { api, conversations, source, calls } = await fixture();
    const original = structuredClone(await conversations.require(source.id));
    const result = await api.request(`/api/ai-conversations/${source.id}/compact`, { method: "POST", body: { modelId: model.id } });
    expect(result).toMatchObject({ changed: true, compactedMessageCount: 4, retainedMessageCount: 8 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ modelId: model.id, purpose: "tool-context-compaction", body: { model: "test-model" } });
    expect(calls[0].body).not.toHaveProperty("tools");
    expect((await conversations.require(source.id)).messages).toEqual(original.messages);
    const context = await api.request(`/api/ai-conversations/${source.id}/context`, { method: "POST", body: { modelId: model.id } });
    expect(context.messages).toHaveLength(8);
    expect(context.messages[0].content).toContain("第 5 条");
    expect(context.summary).toContain("继续创作林夏");
    expect(await conversations.exportMarkdown(source.id)).toContain("- 消息数：12");
    const early = await conversations.fork(source.id, { messageId: original.messages[1].id });
    expect(early.hasCompactedSummary).toBe(false);
    const later = await conversations.fork(source.id, { messageId: original.messages[5].id });
    expect(later).toMatchObject({ compactedMessageCount: 4, hasCompactedSummary: true });
  });

  it("leaves both history and memory unchanged when the provider returns invalid memory", async () => {
    const { api, conversations, source } = await fixture(async () => ({ ok: true, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: "{}" } }] }) } }));
    const original = structuredClone(await conversations.require(source.id));
    await expect(api.ai.compact(source.id, { modelId: model.id })).rejects.toMatchObject({ code: "AI_EMPTY_MEMORY" });
    expect(await conversations.require(source.id)).toEqual(original);
    await expect(api.ai.compact(source.id, { modelId: "server-model" })).rejects.toMatchObject({ code: "LOCAL_AI_MODEL_UNAVAILABLE" });
  });

  it("preserves a rename and appended messages made while compaction is running", async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const { api, conversations, source, calls } = await fixture(async () => {
      entered?.();
      await wait;
      return { ok: true, data: { status: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(memory) } }] }) } };
    });
    const pending = api.ai.compact(source.id, { modelId: model.id });
    await reached;
    const duplicate = api.ai.compact(source.id, { modelId: model.id });
    await conversations.setTitle(source.id, { title: "作者的新标题" });
    await conversations.addMessage(source.id, { role: "user", content: "压缩期间的追加消息" });
    release?.();
    await Promise.all([pending, duplicate]);
    expect(calls).toHaveLength(1);
    const current = await conversations.require(source.id);
    expect(current.title).toBe("作者的新标题");
    expect(current.messages).toHaveLength(13);
    expect(current.messages.at(-1).content).toBe("压缩期间的追加消息");
  });

  it("keeps histories longer than 400 messages instead of silently truncating them", async () => {
    const conversations = new DesktopOfflineConversations(createMemoryAiConversationRepository());
    const source = await conversations.create("work-1");
    for (let index = 0; index < 401; index += 1) await conversations.addMessage(source.id, { role: "user", content: String(index) });
    expect((await conversations.require(source.id)).messages).toHaveLength(401);
    expect(await conversations.exportMarkdown(source.id)).toContain("- 消息数：401");
  });
});
