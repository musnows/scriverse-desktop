import { describe, expect, it } from "vitest";
import { DesktopOfflineApi } from "../../runtime-overlay/public/desktop-offline-api.js";
import { createMemoryAiConversationRepository, DesktopOfflineConversations } from "../../runtime-overlay/public/desktop-offline-conversations.js";

describe("offline conversation export", () => {
  it("exports the complete local transcript without a Server request", async () => {
    const conversations = new DesktopOfflineConversations(createMemoryAiConversationRepository());
    const api = new DesktopOfflineApi({ store: {} }, { conversations });
    const source = await conversations.create("work-1", { title: "长夜\n# 标题" });
    await conversations.addMessage(source.id, { role: "user", content: "<ai_reference>林夏</ai_reference>\n\n请续写。" });
    await conversations.addMessage(source.id, { role: "assistant", content: "**海风**吹来。" });
    const markdown = await api.request(`/api/ai-conversations/${source.id}/export`);
    expect(markdown).toContain("# 长夜 \\# 标题");
    expect(markdown).toContain("- 消息数：2");
    expect(markdown).toContain("<ai_reference>林夏</ai_reference>\n\n请续写。");
    expect(markdown).toContain("**海风**吹来。");
    expect(markdown.indexOf("请续写")).toBeLessThan(markdown.indexOf("海风"));
    await expect(api.request("/api/ai-conversations/other-user/export")).rejects.toMatchObject({ code: "AI_CONVERSATION_NOT_FOUND" });
    expect((await conversations.require(source.id)).messages).toHaveLength(2);
  });
});
