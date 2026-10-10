import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DesktopOfflineApi } from "../../runtime-overlay/public/desktop-offline-api.js";
import { syncMutationSnapshot } from "../../runtime-overlay/public/desktop-sync-client.js";

type StoredRecord = {
  entityType: string;
  snapshot: Record<string, unknown>;
};

function entity(record: StoredRecord) {
  return {
    entityType: record.entityType,
    entityId: String(record.snapshot.id),
    snapshot: record.snapshot,
    serverVersionNo: Number(record.snapshot.versionNo ?? 1),
    localRevisionNo: 0,
    conflict: false,
    locked: false,
    deleted: false
  };
}

function storeFor(records: StoredRecord[]) {
  const entities = records.map(entity);
  return {
    async listWorks() {
      return [{ workId: "work-1" }];
    },
    async getWork() {
      return { workId: "work-1", title: "界门", summary: { id: "work-1", title: "界门" }, permissionsSnapshot: null };
    },
    async listEntities(_workId: string, entityType?: string) {
      return entities
        .filter((item) => !entityType || item.entityType === entityType)
        .map((item) => ({ ...item, snapshot: structuredClone(item.snapshot) }));
    },
    async getEntity(_workId: string, entityType: string, entityId: string) {
      const found = entities.find((item) => item.entityType === entityType && item.entityId === entityId);
      return found ? { ...found, snapshot: structuredClone(found.snapshot) } : null;
    }
  };
}

function manifest(modules: Record<string, "ready" | "denied">): StoredRecord {
  return { entityType: "offline-package", snapshot: { id: "manifest", modules } };
}

describe("offline work tabs", () => {
  it("resolves characters, ideas and sibling tabs after the offline package is synced", async () => {
    const api = new DesktopOfflineApi({
      store: storeFor([
        manifest({
          character: "ready",
          draft: "ready",
          race: "ready",
          organization: "ready",
          "timeline-event": "ready",
          "timeline-track": "ready",
          relationship: "ready",
          foreshadow: "ready",
          "chapter-outline": "ready",
          chapter: "ready",
          volume: "ready",
          review: "ready",
          "chapter-annotation": "ready",
          "analysis-task": "ready"
        }),
        { entityType: "character", snapshot: { id: "char-1", name: "林舟", aliases: ["舟"], lockedFields: [], organizations: [], currentState: {}, gender: "male" } },
        { entityType: "draft", snapshot: { id: "draft-1", title: "潮门", draftType: "prose", content: "也许从北港开始" } },
        { entityType: "race", snapshot: { id: "race-root", name: "海族", parentRaceId: null, memberIds: [], members: [] } },
        { entityType: "race", snapshot: { id: "race-child", name: "潮裔", parentRaceId: "race-root", memberIds: [], members: [] } },
        { entityType: "organization", snapshot: { id: "org-1", name: "港务司", memberIds: ["char-1"], members: [] } },
        { entityType: "timeline-track", snapshot: { id: "track-1", name: "主线", sortOrder: 0 } },
        { entityType: "timeline-event", snapshot: { id: "event-1", name: "抵达", trackId: "track-1" } },
        { entityType: "relationship", snapshot: { id: "rel-1", fromCharacterId: "char-1", title: "同行" } },
        { entityType: "volume", snapshot: { id: "vol-1", title: "第一卷", sortOrder: 0 } },
        { entityType: "chapter", snapshot: { id: "ch-1", title: "第一章", volumeId: "vol-1", sortOrder: 0, chapterType: "正文" } },
        { entityType: "chapter-outline", snapshot: { id: "ch-1", chapterId: "ch-1", goal: "进入潮门", status: "ready", createdAt: "2026-01-01T00:00:00.000Z", conflict: "", turningPoint: "", notes: "" } },
        { entityType: "foreshadow", snapshot: { id: "fs-1", title: "旧信", status: "planted", importance: "high", occurrences: [{ chapterId: "ch-1", role: "setup" }] } },
        { entityType: "review", snapshot: { id: "review-1", title: "核对港名", status: "pending" } },
        { entityType: "chapter-annotation", snapshot: { id: "note-1", chapterId: "ch-1", chapterTitle: "第一章", volumeTitle: "第一卷", note: "再核对", quote: "" } },
        { entityType: "analysis-task", snapshot: { id: "task-1", status: "pending", progress: 0, createdAt: "2026-01-02T00:00:00.000Z" } }
      ])
    });

    const characters = await api.request("/api/works/work-1/characters?page=1&limit=30");
    expect(characters.items.map((item: { name: string }) => item.name)).toEqual(["林舟"]);
    const drafts = await api.request("/api/works/work-1/drafts?page=1&limit=30");
    expect(drafts.items[0]).toMatchObject({ title: "潮门", contentPreview: "也许从北港开始" });
    expect(await api.request("/api/drafts/draft-1")).toMatchObject({ id: "draft-1", content: "也许从北港开始" });
    const roots = await api.request("/api/works/work-1/races?scope=roots");
    expect(roots).toMatchObject({ total: 2, items: [{ name: "海族", childCount: 1 }] });
    expect(await api.request("/api/works/work-1/races?scope=descendants")).toMatchObject([{ name: "潮裔" }]);
    expect((await api.request("/api/works/work-1/organizations?page=1&limit=30")).items[0].name).toBe("港务司");
    expect((await api.request("/api/works/work-1/timeline?page=1&limit=30")).items[0].name).toBe("抵达");
    expect((await api.request("/api/works/work-1/timeline-tracks?page=1&limit=30")).items[0].name).toBe("主线");
    expect((await api.request("/api/works/work-1/relationships?page=1&limit=30")).items[0].title).toBe("同行");
    const board = await api.request("/api/works/work-1/outline-board?page=1&limit=30");
    expect(board.stats).toMatchObject({ chapterCount: 1, outlinedChapterCount: 1, unresolvedForeshadowCount: 1 });
    expect(board.volumes[0].chapters[0]).toMatchObject({
      id: "ch-1",
      outline: { status: "ready", goal: "进入潮门" },
      foreshadows: [expect.objectContaining({ title: "旧信", roles: ["setup"] })]
    });
    expect((await api.request("/api/works/work-1/reviews?page=1&limit=30")).items[0].title).toBe("核对港名");
    const notes = await api.request("/api/works/work-1/chapter-annotations?page=1&limit=30");
    expect(notes.items[0].note).toBe("再核对");
    expect(notes.chapterOptions).toEqual([{ id: "ch-1", title: "第一章", volumeTitle: "第一卷" }]);
    const tasks = await api.request("/api/works/work-1/tasks?page=1&limit=30");
    expect(tasks.items[0].id).toBe("task-1");
    expect(tasks.stats.pendingCount).toBe(1);
  });

  it("keeps the missing-package error for characters, ideas and sibling tabs that were not synced", async () => {
    const api = new DesktopOfflineApi({ store: storeFor([]) });
    const paths = [
      "/api/works/work-1/characters?page=1&limit=30",
      "/api/works/work-1/drafts?page=1&limit=30",
      "/api/works/work-1/races?scope=roots",
      "/api/works/work-1/organizations?page=1&limit=30",
      "/api/works/work-1/timeline?page=1&limit=30",
      "/api/works/work-1/relationships?page=1&limit=30",
      "/api/works/work-1/foreshadows?status=all&page=1&limit=30"
    ];
    for (const path of paths) {
      await expect(api.request(path)).rejects.toMatchObject({
        code: "OFFLINE_PACKAGE_MISSING",
        message: "离线包不存在"
      });
    }
  });

  it("does not apply permission filtering in the offline work payload", async () => {
    const api = new DesktopOfflineApi({
      store: {
        async getWork() {
          return {
            workId: "work-1",
            title: "界门",
            summary: { id: "work-1", title: "界门" },
            permissionsSnapshot: {
              accessRole: "viewer",
              modulePermissions: { characters: "none", drafts: "none", settings: "read", prose: "none" }
            }
          };
        },
        async listEntities() {
          return [];
        }
      }
    });
    const work = await api.request("/api/works/work-1?directory=volumes");
    expect(work.accessRole).toBe("owner");
    expect(work.modulePermissions).toMatchObject({
      characters: "write",
      drafts: "write",
      settings: "write",
      prose: "write",
      races: "write",
      outlines: "write"
    });
    const overlay = readFileSync(new URL("../../runtime-overlay/web.patch", import.meta.url), "utf8");
    expect(overlay).not.toContain("当前模块未包含在离线副本中");
    expect(overlay).not.toContain("离线时只能修改已下载的正文和设定");
  });

  it("saves an offline edit for a module other than chapters and settings", async () => {
    const saved = [];
    const character = {
      entityType: "character",
      entityId: "char-1",
      snapshot: { id: "char-1", name: "林舟", aliases: [], lockedFields: [], versionNo: 1 },
      serverVersionNo: 1,
      localRevisionNo: 0,
      conflict: false,
      locked: false,
      deleted: false
    };
    const api = new DesktopOfflineApi({
      store: {
        async listWorks() {
          return [{ workId: "work-1" }];
        },
        async getEntity() {
          return { ...character, snapshot: structuredClone(character.snapshot) };
        },
        async saveLocalEntity(_workId, entityType, entityId, snapshot) {
          saved.push({ entityType, entityId, snapshot });
          return { localRevisionNo: 1, savedAt: "2026-10-09T00:00:00.000Z" };
        }
      },
      client: { async emitStatus() {} }
    });
    const updated = await api.request("/api/characters/char-1", { method: "PATCH", body: { name: "林舟改" } });
    expect(updated.name).toBe("林舟改");
    expect(saved[0]).toMatchObject({ entityType: "character", entityId: "char-1" });
    expect(syncMutationSnapshot("character", saved[0].snapshot)).toMatchObject({ name: "林舟改" });
    expect(syncMutationSnapshot("draft", { title: "潮门", content: "正文", ignored: true })).toEqual({
      title: "潮门",
      content: "正文"
    });
  });

  it("returns an empty list when the synced package includes a module with no records", async () => {
    const api = new DesktopOfflineApi({
      store: storeFor([manifest({ character: "ready", draft: "ready", race: "ready" })])
    });
    await expect(api.request("/api/works/work-1/characters?page=1&limit=30")).resolves.toMatchObject({ items: [], total: 0 });
    await expect(api.request("/api/works/work-1/drafts?page=1&limit=30")).resolves.toMatchObject({ items: [], total: 0 });
    await expect(api.request("/api/works/work-1/races?scope=roots")).resolves.toMatchObject({ items: [], total: 0 });
  });
});
