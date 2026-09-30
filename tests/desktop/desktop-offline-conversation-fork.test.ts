import { describe, expect, it } from "vitest";
import { DesktopOfflineApi } from "../../runtime-overlay/public/desktop-offline-api.js";
import { createMemoryAiConversationRepository, DesktopOfflineConversations } from "../../runtime-overlay/public/desktop-offline-conversations.js";

describe("offline conversation forks", () => {
  it("copies only the selected prefix with new message ids and preserves the source", async () => {
    const conversations = new DesktopOfflineConversations(createMemoryAiConversationRepository());
    const api = new DesktopOfflineApi({ store: {} }, { conversations });
    const source = await conversations.create("work-1", { title: "长夜", taskType: "roleplay" });
    await conversations.setContextScope(source.id, { scope: { type: "entities", characterIds: ["character-1"] } });
    const user = await conversations.addMessage(source.id, { role: "user", content: "启程", metadata: { modelId: "local-model" } });
    const selected = await conversations.addMessage(source.id, { role: "assistant", content: "回声", metadata: { processSteps: [{ type: "thinking", content: "思考" }] } });
    await conversations.addMessage(source.id, { role: "user", content: "不应复制" });
    const fork = await api.request(`/api/ai-conversations/${source.id}/fork`, { method: "POST", body: { messageId: selected.id, requestId: "retry-key" } });
    expect(fork.messages.map((message) => message.content)).toEqual(["启程", "回声"]);
    expect(fork.messages[0].id).not.toBe(user.id);
    expect(fork.messages[0].metadata).not.toHaveProperty("modelId");
    expect(fork.messages[1].metadata.processSteps[0].content).toBe("思考");
    expect(fork).toMatchObject({ workId: "work-1", taskType: "roleplay", title: "长夜 · 分支", contextScope: { characterIds: ["character-1"] } });
    expect((await conversations.require(source.id)).messages).toHaveLength(3);
    expect((await conversations.fork(source.id, { messageId: selected.id, requestId: "retry-key" })).id).toBe(fork.id);
    await expect(conversations.fork(source.id, { messageId: user.id, requestId: "retry-key" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(conversations.fork(source.id, { messageId: "another-conversation-message" })).rejects.toMatchObject({ code: "AI_CONVERSATION_MESSAGE_NOT_FOUND" });
  });

  it("rejects inaccessible conversations in a different local repository", async () => {
    const first = new DesktopOfflineConversations(createMemoryAiConversationRepository());
    const second = new DesktopOfflineConversations(createMemoryAiConversationRepository());
    const source = await first.create("work-1");
    await expect(second.fork(source.id, { messageId: "message" })).rejects.toMatchObject({ code: "AI_CONVERSATION_NOT_FOUND" });
  });
});
