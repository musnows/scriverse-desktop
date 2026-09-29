import { describe, expect, it } from "vitest";
import { DesktopOfflineApi } from "../../runtime-overlay/public/desktop-offline-api.js";
import {
  createMemoryAiConversationRepository,
  desktopOfflineConversationWorkKey,
  DesktopOfflineConversations
} from "../../runtime-overlay/public/desktop-offline-conversations.js";
import {
  buildDesktopOfflineAgentBody,
  buildDesktopOfflineAgentCorpus,
  desktopOfflineAssistantTurn,
  desktopOfflineChatToolDefinitions,
  desktopOfflineLocalAiMessages,
  desktopOfflineUserTurn,
  executeDesktopOfflineChatTool,
  parseDesktopOfflineAgentTurn,
  runDesktopOfflineAgentLoop
} from "../../runtime-overlay/public/desktop-local-ai-offline.js";

const corpus = buildDesktopOfflineAgentCorpus({
  work: { workId: "work-1", summary: { id: "work-1", title: "长夜", description: "一部小说" } },
  permissions: { prose: "write", settings: "read", characters: "read", drafts: "read" },
  entities: [
    { entityType: "volume", snapshot: { id: "volume-1", title: "第一卷", sortOrder: 1 } },
    { entityType: "chapter", snapshot: { id: "chapter-1", volumeId: "volume-1", title: "启程", chapterType: "正文", sortOrder: 1, content: "林夏推开了门。\n\n门外是海。" } },
    { entityType: "chapter", snapshot: { id: "chapter-2", volumeId: "volume-1", title: "回声", chapterType: "正文", sortOrder: 2, content: "海面上没有林夏。" } },
    { entityType: "setting", snapshot: { id: "setting-1", title: "潮汐", content: "每晚涨潮。attachment://img-1" } },
    {
      entityType: "character",
      snapshot: {
        id: "character-1",
        name: "林夏",
        gender: "female",
        isDead: false,
        profile: { sections: [{ id: "section-1", title: "出身", summary: "海边", contentMarkdown: "林夏生于港口。" }] }
      }
    },
    { entityType: "draft", snapshot: { id: "draft-1", title: "备选结局", draftType: "prose", content: "也许并不回去。" } },
    { entityType: "agent-corpus", snapshot: { id: "status", modules: { character: "ready", draft: "ready", race: "ready" } } }
  ]
});

describe("offline AI web display records", () => {
  it("keeps reference markup, citations and mention metadata on the user bubble", () => {
    const turn = desktopOfflineUserTurn({
      markup: "续写 <ai_reference kind=\"character\" id=\"character-1\">林夏</ai_reference>",
      text: "续写 林夏",
      citations: [{ chapterId: "chapter-1", chapterTitle: "启程", startLine: 1, endLine: 1, text: "林夏推开了门。" }],
      scope: { characterIds: ["character-1"], includeSettingInfo: true }
    });

    expect(turn.content).toContain("<ai_reference");
    expect(turn.citations).toEqual([
      { chapterId: "chapter-1", chapterTitle: "启程", startLine: 1, endLine: 1, text: "林夏推开了门。" }
    ]);
    expect(turn.metadata).toEqual({
      mentionCharacterIds: ["character-1"],
      mentionContextSettingIds: ["include-setting-info"]
    });
    expect(turn.modelContent).toContain("林夏推开了门。");
    expect(desktopOfflineLocalAiMessages([], turn.modelContent)).toEqual([
      { role: "user", content: turn.modelContent }
    ]);
  });

  it("keeps thinking steps and tool calls for assistant history", () => {
    const turn = desktopOfflineAssistantTurn({
      content: "门外是海。",
      modelDisplayName: "本地模型",
      outputTokens: 4,
      processDurationMs: 1200,
      processSteps: [{ id: "provider-thinking-1", type: "thinking", round: 1, content: "先看目录" }],
      toolCalls: [{ id: "call-1", name: "story_index", status: "completed" }]
    });

    expect(turn.metadata.processSteps[0].content).toBe("先看目录");
    expect(turn.metadata.toolCalls[0].name).toBe("story_index");
    expect(turn.metadata.processDurationMs).toBe(1200);
  });
});

describe("offline chat tools", () => {
  it("offers the same server chat tool names", () => {
    expect(desktopOfflineChatToolDefinitions(corpus).map((tool) => tool.function.name)).toEqual([
      "story_index",
      "read_chapters",
      "grep",
      "search_story_entities",
      "read_character_sections",
      "search_drafts",
      "image",
      "calculate_time"
    ]);
    const searchTool = desktopOfflineChatToolDefinitions(corpus).find((tool) => tool.function.name === "search_story_entities");
    expect(searchTool?.function.parameters.properties.includePhonetic).toMatchObject({ type: "boolean", default: false });
    const enabledSemantic = desktopOfflineChatToolDefinitions({
      ...corpus,
      agentTools: ["story_index", "semantic_search_story"]
    }).map((tool) => tool.function.name);
    expect(enabledSemantic).toContain("semantic_search_story");
    expect(enabledSemantic).not.toContain("grep");
  });

  it("reads chapter order, original text and keyword paragraphs from the offline copy", () => {
    const index = executeDesktopOfflineChatTool(corpus, "story_index", { limit: 10 });
    expect(index.data.work.title).toBe("长夜");
    expect(index.data.chapters.map((chapter) => chapter.title)).toEqual(["启程", "回声"]);
    expect(index.data.latestChaptersByStructure.at(-1).id).toBe("chapter-2");

    const chapter = executeDesktopOfflineChatTool(corpus, "read_chapters", { chapterIds: ["chapter-1"], include: "content" });
    expect(chapter.data.chapters[0].content).toContain("林夏推开了门。");

    const matches = executeDesktopOfflineChatTool(corpus, "grep", { keyword: "林夏" });
    expect(matches.data.matches.length).toBeGreaterThan(0);
    expect(matches.data.latestOccurrences.byStructure.at(-1).chapterId).toBe("chapter-2");
  });

  it("reports timeline tracks and degrades semantic search in the server shape", () => {
    const timed = buildDesktopOfflineAgentCorpus({
      work: { summary: { id: "work-1", title: "长夜" } },
      permissions: { prose: "read", timeline: "read" },
      entities: [
        { entityType: "volume", snapshot: { id: "volume-1", title: "第一卷", sortOrder: 1 } },
        { entityType: "chapter", snapshot: { id: "chapter-1", volumeId: "volume-1", title: "启程", chapterType: "正文", sortOrder: 1, content: "林夏推开了门。" } },
        { entityType: "chapter", snapshot: { id: "chapter-2", volumeId: "volume-1", title: "回声", chapterType: "正文", sortOrder: 2, content: "后来才写到林夏。" } },
        { entityType: "timeline-event", snapshot: { id: "event-1", name: "出门", status: "confirmed", timeSort: 10, trackId: "track-1", chapterIds: ["chapter-1"], timeLabel: "第一日" } },
        { entityType: "timeline-event", snapshot: { id: "event-2", name: "回声", status: "confirmed", timeSort: 4, trackId: "track-1", chapterIds: ["chapter-2"], timeLabel: "倒叙" } }
      ]
    });
    const matches = executeDesktopOfflineChatTool(timed, "grep", { keyword: "林夏" });
    expect(matches.data.latestOccurrences.byStructure.at(-1).chapterId).toBe("chapter-2");
    expect(matches.data.latestOccurrences.byTimelineTrack).toEqual([
      expect.objectContaining({ trackId: "track-1", timeSort: 10, orderEligible: true })
    ]);
    const index = executeDesktopOfflineChatTool(timed, "story_index", { limit: 10 });
    expect(index.data.chapters.find((chapter) => chapter.id === "chapter-1")?.confirmedTimelineEvents[0]).toMatchObject({
      id: "event-1",
      trackId: "track-1",
      timeSort: 10,
      orderEligible: true
    });
    const semantic = executeDesktopOfflineChatTool(timed, "semantic_search_story", { query: "海边的人是谁" });
    expect(semantic.data).toMatchObject({
      query: "海边的人是谁",
      status: "degraded",
      semanticUsed: false,
      degraded: true,
      matches: expect.any(Array)
    });
    expect(semantic.data.reason).toContain("降级");
  });

  it("searches downloaded characters and reports modules missing from the offline copy", () => {
    const found = executeDesktopOfflineChatTool(corpus, "search_story_entities", { query: "林夏", categories: ["character"] });
    expect(found.data.matches[0]).toMatchObject({ id: "character-1", gender: "female", isDead: false, sectionIds: ["section-1"] });

    const section = executeDesktopOfflineChatTool(corpus, "read_character_sections", { sectionIds: ["section-1"] });
    expect(section.data.sections[0].content).toContain("林夏生于港口。");

    const missing = buildDesktopOfflineAgentCorpus({
      work: { summary: { id: "work-1", title: "长夜" } },
      entities: []
    });
    const denied = executeDesktopOfflineChatTool(missing, "search_story_entities", { query: "林夏", categories: ["character"] });
    expect(denied.data.unavailableCategories[0].code).toBe("OFFLINE_CORPUS_MISSING");
  });

  it("does not invent phonetic hits and only reads image bytes that were synced", () => {
    const phonetic = executeDesktopOfflineChatTool(corpus, "search_story_entities", { query: "linxia", includePhonetic: true, categories: ["character"] });
    expect(phonetic.data.matches).toEqual([]);
    expect(phonetic.data.phoneticIndex).toBe("absent");
    expect(phonetic.data.hint).toContain("没有拼音索引");

    const image = executeDesktopOfflineChatTool(corpus, "image", { attachmentId: "img-1" });
    expect(image.error.code).toBe("OFFLINE_IMAGE_BYTES_UNAVAILABLE");

    const withBytes = buildDesktopOfflineAgentCorpus({
      work: { summary: { id: "work-1", title: "长夜" } },
      entities: [
        { entityType: "setting", snapshot: { id: "setting-1", title: "潮汐", content: "attachment://img-1" } },
        { entityType: "setting-attachment", snapshot: { id: "img-1", originalName: "tide.png", mimeType: "image/png", dataBase64: "aGk=", byteStatus: "ready" } }
      ]
    });
    const seen = executeDesktopOfflineChatTool(withBytes, "image", { attachmentId: "img-1" }, { multimodalEnabled: true });
    expect(seen.data).toMatchObject({ attachmentId: "img-1", delivery: "native_multimodal", fileName: "tide.png" });
    expect(seen.nativeImage.dataUrl).toBe("data:image/png;base64,aGk=");
  });

  it("calculates date spans without reading the work", () => {
    const result = executeDesktopOfflineChatTool(corpus, "calculate_time", { startDate: "2024-02-28", endDate: "2024-03-01" });
    expect(result.data.totalDays).toBe(2);
    expect(result.data.leapYears).toEqual([2024]);
  });
});

describe("offline agent loop", () => {
  it("sends tool definitions and keeps thinking plus tool calls for the web stream", async () => {
    const bodies = [];
    const events = [];
    const result = await runDesktopOfflineAgentLoop({
      protocol: "openai-chat-completions",
      modelId: "demo-model",
      tools: desktopOfflineChatToolDefinitions(corpus),
      corpus,
      now: () => "2026-09-29T00:00:00.000Z",
      messages: [{ role: "user", content: "林夏最后出现在哪一章？" }],
      onEvent: (event) => events.push(event),
      completeRound: async (body, onEvent) => {
        bodies.push(body);
        if (bodies.length === 1) {
          onEvent({ type: "reasoning-delta", delta: "先检索正文。" });
          return {
            status: 200,
            body: JSON.stringify({
              choices: [{
                message: {
                  content: null,
                  tool_calls: [{ id: "call-1", type: "function", function: { name: "grep", arguments: "{\"keyword\":\"林夏\"}" } }]
                }
              }]
            })
          };
        }
        return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "林夏最后出现在《回声》。" } }] }) };
      }
    });

    expect(bodies[0].stream).toBeUndefined();
    expect(bodies[0].tools.map((tool) => tool.function.name)).toContain("grep");
    expect(bodies[1].messages.some((message) => message.role === "tool" && message.tool_call_id === "call-1")).toBe(true);
    expect(result.content).toBe("林夏最后出现在《回声》。");
    expect(result.processSteps.map((step) => step.type)).toEqual(["thinking", "tool"]);
    expect(events.map((event) => event.type)).toEqual(["reasoning-delta", "tool-call", "content-delta"]);
  });

  it("parses provider tool calls back into the web tool event shape", () => {
    const turn = parseDesktopOfflineAgentTurn("openai-chat-completions", {
      choices: [{ message: { content: "", tool_calls: [{ id: "call-1", function: { name: "grep", arguments: "{\"keyword\":\"海\"}" } }] } }]
    });
    expect(turn.toolCalls).toEqual([{ id: "call-1", name: "grep", arguments: "{\"keyword\":\"海\"}" }]);
  });

  it("builds anthropic and responses tool requests without enabling stream at parse time", () => {
    const tools = desktopOfflineChatToolDefinitions(corpus).slice(0, 1);
    const messages = [{ role: "user", content: "看目录" }];
    const anthropic = buildDesktopOfflineAgentBody({ protocol: "anthropic-messages", modelId: "claude", messages, tools });
    const responses = buildDesktopOfflineAgentBody({ protocol: "openai-responses", modelId: "gpt", messages, tools });
    expect(anthropic.tools[0].name).toBe("story_index");
    expect(anthropic.stream).toBeUndefined();
    expect(responses.tools[0].name).toBe("story_index");
    expect(responses.input[0].role).toBe("user");
    expect(responses.stream).toBeUndefined();
  });
});

describe("offline conversations stay on the work", () => {
  it("shares one conversation list across chapter ids and keeps it after switching chapters", async () => {
    const backing = new Map();
    const apiFor = () => new DesktopOfflineApi({ store: { listEntities: async () => [] } }, {
      conversations: new DesktopOfflineConversations(createMemoryAiConversationRepository(backing))
    });
    const created = await apiFor().request("/api/works/work-1/ai-conversations", {
      method: "POST",
      body: { taskType: "chat" }
    });
    expect(created.workId).toBe(desktopOfflineConversationWorkKey("work-1"));
    expect(created).not.toHaveProperty("chapterId");
    await apiFor().request(`/api/ai-conversations/${created.id}/messages`, {
      method: "POST",
      body: {
        role: "user",
        content: "续写 <ai_reference kind=\"character\" id=\"character-1\">林夏</ai_reference>",
        citations: [{ chapterId: "chapter-1", chapterTitle: "启程", startLine: 1, endLine: 1, text: "林夏推开了门。" }],
        metadata: { mentionCharacterIds: ["character-1"], processSteps: [], toolCalls: [] }
      }
    });

    const firstChapter = await apiFor().request("/api/works/work-1/ai-conversations?chapterId=chapter-1&page=1&limit=20");
    const secondChapter = await apiFor().request("/api/works/work-1/ai-conversations?chapterId=chapter-2&page=1&limit=20");
    expect(secondChapter.items.map((item) => item.id)).toEqual(firstChapter.items.map((item) => item.id));
    expect(secondChapter.items).toHaveLength(1);

    const reloaded = await apiFor().request(`/api/ai-conversations/${created.id}?page=1&limit=100&chapterId=chapter-2`);
    expect(reloaded.workId).toBe("work-1");
    expect(reloaded.messages[0].content).toContain("<ai_reference");
    expect(reloaded.messages[0].citations[0].chapterId).toBe("chapter-1");
    expect(reloaded.messages[0].metadata.mentionCharacterIds).toEqual(["character-1"]);
    expect(reloaded).not.toHaveProperty("chapterId");
  });
});
