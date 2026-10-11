import { describe, expect, it, vi } from "vitest";
import { DesktopOfflineApi } from "../../runtime-overlay/public/desktop-offline-api.js";
import { buildDesktopOfflineSearchResults, DESKTOP_OFFLINE_SEARCH_TYPES } from "../../runtime-overlay/public/desktop-offline-search.js";

type RecordSource = { entityType: string; snapshot: Record<string, unknown>; workId?: string; deleted?: boolean };

const records: RecordSource[] = [
  { entityType: "character", snapshot: { id: "char-1", name: "林舟", aliases: ["星港旅人"], profile: { sections: [{ id: "section-1", title: "出身", contentMarkdown: "曾在北码头航行" }] }, gender: "male", isDead: false } },
  { entityType: "setting", snapshot: { id: "setting-1", title: "港口", content: "星港有灯塔" } },
  { entityType: "race", snapshot: { id: "race-1", name: "潮裔", settingsMarkdown: "守护星港", isExtinct: false } },
  { entityType: "organization", snapshot: { id: "org-1", name: "港务司", settingsSections: [{ title: "职责", contentMarkdown: "管理星港航线" }], isDissolved: false } },
  { entityType: "timeline-track", snapshot: { id: "track-1", name: "主线", description: "星港纪事" } },
  { entityType: "timeline-event", snapshot: { id: "event-1", name: "启程", location: "星港" } },
  { entityType: "relationship", snapshot: { id: "rel-1", fromCharacterId: "char-1", toCharacterId: "char-2", subtype: "同行", evidence: [{ quote: "星港结盟" }] } },
  { entityType: "chapter-outline", snapshot: { id: "chapter-1", chapterId: "chapter-1", goal: "进入星港", createdAt: "2026-01-01T00:00:00.000Z" } },
  { entityType: "foreshadow", snapshot: { id: "foreshadow-1", title: "旧信", resolutionNote: "星港的回信" } },
  { entityType: "review", snapshot: { id: "review-1", title: "核对港名", suggestion: "统一为星港" } },
  { entityType: "chapter", snapshot: { id: "chapter-1", title: "抵达", content: "雾散了。\n船停在星港。\n开始旅途。" } }
];

function apiFor(sources: RecordSource[] = records, modules: Record<string, string> = {}) {
  const entities = sources.map((item) => ({
    ...item, workId: item.workId ?? "work-1", entityId: String(item.snapshot.id),
    serverVersionNo: 1, localRevisionNo: 0, conflict: false, locked: false
  }));
  const store = {
    listWorks: vi.fn(async () => [{ workId: "work-1" }, { workId: "work-2" }]),
    listEntities: vi.fn(async (workId: string, type: string) => {
      if (type === "offline-package") return [{ snapshot: { id: "manifest", modules }, serverVersionNo: 1 }];
      return structuredClone(entities.filter((item) => item.workId === workId && item.entityType === type && !item.deleted));
    }),
    getEntity: vi.fn(async (workId: string, type: string, id: string) => (
      structuredClone(entities.find((item) => item.workId === workId && item.entityType === type && item.entityId === id && !item.deleted) ?? null)
    )),
    saveLocalEntity: vi.fn()
  };
  return { api: new DesktopOfflineApi({ store }), store, entities };
}

describe("Desktop offline global search", () => {
  it("searches prose, every settings-library type, and local Agent history", async () => {
    const { api, store } = apiFor();
    const conversation = await api.request("/api/works/work-1/ai-conversations", { method: "POST", body: { title: "航行" } });
    await api.request(`/api/ai-conversations/${conversation.id}/messages`, { method: "POST", body: { role: "user", content: "星港在哪里" } });
    const results = await api.request("/api/works/work-1/search?q=星港");
    expect(new Set(results.map((item) => item.type))).toEqual(new Set([...DESKTOP_OFFLINE_SEARCH_TYPES, "agent-history"]));
    expect(results.at(-1)).toMatchObject({ type: "chapter", id: "chapter-1", startLine: 2, endLine: 2 });
    expect(store.saveLocalEntity).not.toHaveBeenCalled();
  });

  it.each(DESKTOP_OFFLINE_SEARCH_TYPES)("filters results to %s", async (type) => {
    const { api } = apiFor();
    const results = await api.request(`/api/works/work-1/search?q=星港&type=${type}`);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type, matchKinds: ["exact"] });
  });

  it("finds nested character profiles and names relationships and outlines", async () => {
    const { api } = apiFor();
    const character = await api.request("/api/works/work-1/search?q=北码头&type=character");
    expect(character[0]).toMatchObject({ id: "char-1", title: "林舟", snippet: expect.stringContaining("北码头"), gender: "male", isDead: false });
    const relationship = await api.request("/api/works/work-1/search?q=林舟&type=relationship");
    expect(relationship[0]).toMatchObject({ id: "rel-1", title: "林舟 · 同行" });
    const outline = await api.request("/api/works/work-1/search?q=抵达&type=chapter-outline");
    expect(outline[0]).toMatchObject({ id: "chapter-1", title: "抵达" });
  });

  it("shows a late chapter match in the snippet and preserves multiline navigation", async () => {
    const { api } = apiFor([{ entityType: "chapter", snapshot: { id: "long-1", title: "远航", content: `${"海".repeat(400)}\n停在星港\r\n继续航行` } }]);
    const results = await api.request("/api/works/work-1/search?q=星港&type=chapter");
    expect(results[0]).toMatchObject({ snippet: expect.stringContaining("星港"), startLine: 2, endLine: 2 });
    const exact = await api.request("/api/works/work-1/search?q=星港%0D%0A继续&type=chapter");
    expect(exact[0]).toMatchObject({ snippet: expect.stringContaining("星港"), startLine: 2, endLine: 3 });
  });

  it("normalizes full-width text and case without changing the stored snapshot", async () => {
    const sources = [{ entityType: "setting", snapshot: { id: "ascii-1", title: "港口", content: "ＡＢＣ Harbor" } }];
    const original = structuredClone(sources);
    const { api } = apiFor(sources);
    expect((await api.request("/api/works/work-1/search?q=abc%20harbor&type=setting"))[0].id).toBe("ascii-1");
    expect(sources).toEqual(original);
  });

  it("uses current local edits and excludes another work, merged characters, and deleted records", async () => {
    const { api, entities } = apiFor([
      ...records,
      { entityType: "character", snapshot: { id: "merged-1", name: "星港旧名", mergedIntoCharacterId: "char-1" } },
      { entityType: "setting", snapshot: { id: "other-1", title: "星港保密资料" }, workId: "work-2" },
      { entityType: "setting", snapshot: { id: "deleted-1", title: "星港已删资料" }, deleted: true }
    ]);
    const edited = entities.find((item) => item.entityId === "char-1");
    if (!edited) throw new Error("Character fixture is missing");
    edited.snapshot.aliases = ["本机新称号"];
    edited.localRevisionNo = 2;
    expect((await api.request("/api/works/work-1/search?q=本机新称号"))[0].id).toBe("char-1");
    const results = await api.request("/api/works/work-1/search?q=星港");
    for (const id of ["merged-1", "other-1", "deleted-1"]) expect(results.some((item) => item.id === id)).toBe(false);
  });

  it("ignores unavailable modules and denied dependencies while preserving downloaded content", async () => {
    const { api } = apiFor(records, { character: "denied", "timeline-event": "denied" });
    const results = await api.request("/api/works/work-1/search?q=星港");
    expect(results.some((item) => item.type === "character" || item.type === "timeline-event")).toBe(false);
    expect(results.some((item) => item.type === "setting")).toBe(true);
    expect(await api.request("/api/works/work-1/search?q=林舟&type=relationship")).toEqual([]);
    expect(await apiFor([]).api.request("/api/works/work-1/search?q=星港&type=character")).toEqual([]);
  });

  it("keeps settings-library results ahead of prose when applying the limit", async () => {
    const chapters = Array.from({ length: 60 }, (_, index) => ({ entityType: "chapter", snapshot: { id: `chapter-${index}`, title: "星港", content: "星港" } }));
    const { api } = apiFor([...chapters, { entityType: "character", snapshot: { id: "char-1", name: "星港旅人" } }]);
    const results = await api.request("/api/works/work-1/search?q=星港&limit=2");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ type: "character", id: "char-1" });
  });

  it.each([
    ["", "SEARCH_QUERY_INVALID"], ["q=%20", "SEARCH_QUERY_INVALID"],
    [`q=${"a".repeat(101)}`, "SEARCH_QUERY_INVALID"],
    ["q=星港&type=unknown", "SEARCH_TYPE_INVALID"],
    ...["0", "101", "1.5", "NaN", ""].map((limit) => [`q=星港&limit=${limit}`, "SEARCH_LIMIT_INVALID"])
  ])("rejects invalid search parameters %s", async (query, code) => {
    await expect(apiFor().api.request(`/api/works/work-1/search?${query}`)).rejects.toMatchObject({ code });
  });

  it.each([
    ["timeline-track", "track-1", "/api/timeline-tracks/track-1"],
    ["timeline-event", "event-1", "/api/timeline/event-1"],
    ["relationship", "rel-1", "/api/relationships/rel-1"],
    ["chapter-outline", "chapter-1", "/api/chapters/chapter-1/outline"],
    ["foreshadow", "foreshadow-1", "/api/foreshadows/foreshadow-1"],
    ["review", "review-1", "/api/reviews/review-1"]
  ])("opens the detail request used by a %s search result", async (type, id, path) => {
    const { api } = apiFor();
    const results = await api.request(`/api/works/work-1/search?q=星港&type=${type}`);
    const detail = await api.request(path);
    expect(results[0].id).toBe(id);
    expect(detail.id).toBe(id);
  });

  it("does not match internal record IDs or field names", () => {
    const sources = { character: [{ id: "secret-key", name: "林舟", profile: { sections: [{ id: "secret-key", contentMarkdown: "海边" }] } }] };
    expect(buildDesktopOfflineSearchResults(sources, "secret-key")).toEqual([]);
    expect(buildDesktopOfflineSearchResults(sources, "contentMarkdown")).toEqual([]);
  });
});
