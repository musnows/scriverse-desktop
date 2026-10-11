import { describe, expect, it } from "vitest";
import { DesktopSyncClient } from "../../runtime-overlay/public/desktop-sync-client.js";
import { buildDesktopOfflineAgentCorpus, executeDesktopOfflineChatTool } from "../../runtime-overlay/public/desktop-local-ai-offline.js";

type CorpusGroup = { entityType: string; records: Record<string, unknown>[] };

function corpusClient(modules: Record<string, string>, entities: Map<string, Record<string, unknown>[]>) {
  const store = {
    async getEntity(_workId: string, entityType: string, entityId: string) {
      return entityType === "offline-package" && entityId === "manifest" ? { snapshot: { id: "manifest", modules } } : null;
    },
    async replaceReadonlyEntities(_workId: string, groups: CorpusGroup[]) {
      for (const group of groups) entities.set(group.entityType, structuredClone(group.records));
    },
    close() {}
  };
  return new DesktopSyncClient({ bridge: {}, profile: {}, user: { userId: "user-1" }, store, pollIntervalMs: 0 });
}

describe("Desktop 离线语料刷新", () => {
  it("保留完整快照中的可编辑实体，避免在线权限裁剪后覆盖本机内容", async () => {
    const types = ["chapter", "setting", "draft", "character", "race", "organization", "timeline-track", "timeline-event", "relationship", "chapter-outline", "foreshadow"];
    const entities = new Map<string, Record<string, unknown>[]>(types.map((type) => [type, [{ id: `${type}-1`, versionNo: 7, name: "完整快照" }]]));
    const original = structuredClone(entities);
    const client = corpusClient(Object.fromEntries(types.map((type) => [type, "ready"])), entities);

    await client.refreshOfflineAgentCorpus("work-1", async (path: string) => {
      if (path.includes("/characters")) {
        throw Object.assign(new Error("Module read denied"), { status: 403, code: "WORK_MODULE_READ_DENIED" });
      }
      if (path.includes("/ai-settings")) return { systemPrompt: "最新语料配置" };
      return [];
    });

    for (const type of types) expect(entities.get(type)).toEqual(original.get(type));
    expect(entities.get("agent-corpus")?.[0]).toMatchObject({ modules: { character: "ready" } });
    expect(entities.get("work-ai-settings")?.[0]).toMatchObject({ systemPrompt: "最新语料配置" });
    const corpus = buildDesktopOfflineAgentCorpus({
      work: { workId: "work-1" },
      entities: [...entities].flatMap(([entityType, records]) => records.map((snapshot) => ({ entityType, snapshot })))
    });
    const search = executeDesktopOfflineChatTool(corpus, "search_story_entities", { query: "完整快照", categories: ["character"] });
    expect(search.data.matches).toMatchObject([{ id: "character-1" }]);
    client.dispose();
  });

  it("继续补充旧版离线包缺少的实体类型", async () => {
    const entities = new Map<string, Record<string, unknown>[]>();
    const client = corpusClient({ chapter: "ready", setting: "ready" }, entities);

    await client.refreshOfflineAgentCorpus("work-1", async (path: string) => (
      path.includes("/characters") ? [{ id: "character-1", name: "林舟", versionNo: 2 }] : []
    ));

    expect(entities.get("character")).toEqual([{ id: "character-1", name: "林舟", versionNo: 2 }]);
    expect(entities.get("agent-corpus")?.[0]).toMatchObject({ modules: { character: "ready" } });
    client.dispose();
  });
});
