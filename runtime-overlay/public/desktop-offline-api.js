import {
  conversationRepositoryFromSyncStore,
  createMemoryAiConversationRepository,
  DesktopOfflineConversations
} from "./desktop-offline-conversations.js?v=20260930-desktop-offline-history-v6";
import { DesktopOfflineConversationAi } from "./desktop-offline-conversation-ai.js?v=20260930-desktop-offline-context-v3";

export class DesktopOfflineApiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DesktopOfflineApiError";
    this.code = code;
  }
}

function page(items, url) {
  const requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 30));
  const start = (requestedPage - 1) * limit;
  const selected = items.slice(start, start + limit);
  return {
    items: selected,
    page: requestedPage,
    limit,
    total: items.length,
    hasMore: start + selected.length < items.length,
    nextPage: start + selected.length < items.length ? requestedPage + 1 : null
  };
}

function sortDirectory(items) {
  return [...items].sort((left, right) => (
    Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0)
    || String(left.title ?? left.name ?? left.id).localeCompare(String(right.title ?? right.name ?? right.id), "zh-CN")
  ));
}

function snapshotRecord(entity) {
  const snapshot = structuredClone(entity.snapshot);
  const content = typeof snapshot?.content === "string" ? snapshot.content : null;
  return {
    ...snapshot,
    ...(content === null ? {} : {
      wordCount: textCount(content),
      ...(typeof snapshot.contentPreview === "string" ? {} : {
        contentPreview: content.replace(/\s+/gu, " ").trim().slice(0, 320)
      })
    }),
    versionNo: Number(entity.snapshot?.versionNo ?? entity.serverVersionNo),
    desktopLocalRevisionNo: Number(entity.localRevisionNo ?? 0),
    desktopSyncConflict: entity.conflict === true,
    desktopReadOnly: entity.locked === true
  };
}

const OUTLINE_PREVIEW_LENGTH = 600;

function clipPreview(value) {
  const text = String(value ?? "");
  return { text: text.slice(0, OUTLINE_PREVIEW_LENGTH), truncated: text.length > OUTLINE_PREVIEW_LENGTH };
}

function foreshadowSummaries(foreshadows) {
  const byChapter = new Map();
  const attach = (chapterId, summary, role, plannedPayoff) => {
    const key = String(chapterId ?? "");
    if (!key || !summary.id) return;
    const grouped = byChapter.get(key) ?? new Map();
    const current = grouped.get(summary.id) ?? { ...summary, roles: [], plannedPayoff: false };
    if (role) current.roles.push(role);
    if (plannedPayoff) current.plannedPayoff = true;
    grouped.set(summary.id, current);
    byChapter.set(key, grouped);
  };
  for (const foreshadow of foreshadows) {
    const summary = {
      id: String(foreshadow.id ?? ""),
      title: String(foreshadow.title ?? ""),
      status: String(foreshadow.status ?? ""),
      importance: String(foreshadow.importance ?? "")
    };
    for (const occurrence of Array.isArray(foreshadow.occurrences) ? foreshadow.occurrences : []) {
      attach(occurrence.chapterId, summary, occurrence.role, false);
    }
    if (foreshadow.plannedPayoffChapterId) attach(foreshadow.plannedPayoffChapterId, summary, null, true);
  }
  return byChapter;
}

export function buildOfflineOutlineBoard({
  chapters = [],
  volumes = [],
  outlines = [],
  foreshadows = [],
  query = "",
  volumeId = "",
  outlineStatus = "all",
  foreshadowStatus = "all",
  sort = "tree",
  page: requestedPage = 1,
  limit: requestedLimit = 30
} = {}) {
  const outlineByChapter = new Map();
  for (const outline of outlines) {
    const chapterId = String(outline.chapterId ?? outline.id ?? "");
    if (chapterId && outline.createdAt) outlineByChapter.set(chapterId, outline);
  }
  const foreshadowsByChapter = foreshadowSummaries(foreshadows);
  const volumeById = new Map(volumes.map((volume) => [String(volume.id), volume]));
  const needle = String(query ?? "").trim().toLocaleLowerCase("zh-CN");
  const chapterRecords = chapters.flatMap((chapter) => {
    const volume = volumeById.get(String(chapter.volumeId ?? ""));
    if (!volume) return [];
    const associated = [...(foreshadowsByChapter.get(String(chapter.id))?.values() ?? [])].map((item) => ({
      ...item,
      roles: [...new Set(item.roles)]
    }));
    return [{ chapter, volume, outline: outlineByChapter.get(String(chapter.id)) ?? null, foreshadows: associated }];
  });
  const matches = chapterRecords.filter((item) => {
    if (volumeId && String(item.chapter.volumeId) !== String(volumeId)) return false;
    if (outlineStatus === "empty" && item.outline) return false;
    if (!["all", "empty"].includes(outlineStatus) && String(item.outline?.status ?? "") !== outlineStatus) return false;
    const statuses = item.foreshadows.map((foreshadow) => foreshadow.status);
    if (foreshadowStatus === "none" && item.foreshadows.length > 0) return false;
    if (foreshadowStatus === "unresolved" && !statuses.some((status) => status === "planned" || status === "planted")) return false;
    if (foreshadowStatus === "resolved" && !statuses.includes("resolved")) return false;
    if (foreshadowStatus === "abandoned" && !statuses.includes("abandoned")) return false;
    if (!needle) return true;
    const haystack = [
      item.chapter.title,
      item.chapter.chapterType,
      item.outline?.goal,
      item.outline?.conflict,
      item.outline?.turningPoint,
      item.outline?.notes,
      ...item.foreshadows.map((foreshadow) => foreshadow.title)
    ].join("\n").toLocaleLowerCase("zh-CN");
    return haystack.includes(needle);
  });
  const unresolvedCount = (item) => item.foreshadows.filter((foreshadow) => foreshadow.status === "planned" || foreshadow.status === "planted").length;
  const statusRank = { draft: 1, ready: 2, completed: 3 };
  const sorted = [...matches].sort((left, right) => {
    const volumeOrder = Number(left.volume.sortOrder ?? 0) - Number(right.volume.sortOrder ?? 0);
    if (volumeOrder !== 0) return volumeOrder;
    if (sort === "title") return String(left.chapter.title ?? "").localeCompare(String(right.chapter.title ?? ""), "zh-CN");
    if (sort === "status") {
      const rank = (statusRank[left.outline?.status] ?? 0) - (statusRank[right.outline?.status] ?? 0);
      if (rank !== 0) return rank;
    }
    if (sort === "foreshadows") {
      const delta = unresolvedCount(right) - unresolvedCount(left);
      if (delta !== 0) return delta;
    }
    return Number(left.chapter.sortOrder ?? 0) - Number(right.chapter.sortOrder ?? 0)
      || String(left.chapter.id).localeCompare(String(right.chapter.id));
  });
  const limit = Math.max(1, Math.min(100, Number(requestedLimit) || 30));
  const pageNumber = Math.max(1, Number(requestedPage) || 1);
  const start = (pageNumber - 1) * limit;
  const pageItems = sorted.slice(start, start + limit);
  const volumeOptions = [...volumes]
    .sort((left, right) => Number(left.sortOrder ?? 0) - Number(right.sortOrder ?? 0) || String(left.id).localeCompare(String(right.id)))
    .map((volume) => ({
      id: volume.id,
      title: volume.title,
      sortOrder: Number(volume.sortOrder ?? 0),
      chapterCount: chapters.filter((chapter) => String(chapter.volumeId) === String(volume.id)).length,
      filteredChapterCount: sorted.filter((item) => String(item.chapter.volumeId) === String(volume.id)).length
    }));
  const grouped = new Map();
  for (const item of pageItems) {
    const key = String(item.volume.id);
    const option = volumeOptions.find((candidate) => String(candidate.id) === key);
    const volume = grouped.get(key) ?? {
      id: item.volume.id,
      title: item.volume.title,
      sortOrder: Number(item.volume.sortOrder ?? 0),
      chapterCount: option?.chapterCount ?? 0,
      filteredChapterCount: option?.filteredChapterCount ?? 0,
      chapters: []
    };
    const goal = clipPreview(item.outline?.goal);
    const conflict = clipPreview(item.outline?.conflict);
    const turningPoint = clipPreview(item.outline?.turningPoint);
    const notes = clipPreview(item.outline?.notes);
    volume.chapters.push({
      id: item.chapter.id,
      title: item.chapter.title,
      chapterType: item.chapter.chapterType || "正文",
      sortOrder: Number(item.chapter.sortOrder ?? 0),
      outline: item.outline ? {
        goal: goal.text,
        conflict: conflict.text,
        turningPoint: turningPoint.text,
        notes: notes.text,
        status: item.outline.status ?? "draft",
        truncated: goal.truncated || conflict.truncated || turningPoint.truncated || notes.truncated,
        updatedAt: item.outline.updatedAt ?? null,
        versionNo: item.outline.versionNo
      } : null,
      foreshadows: item.foreshadows
    });
    grouped.set(key, volume);
  }
  const filtersActive = Boolean(needle || outlineStatus !== "all" || foreshadowStatus !== "all");
  if (pageNumber === 1) {
    for (const option of volumeOptions) {
      if (option.chapterCount !== 0 || grouped.has(String(option.id))) continue;
      if (volumeId && String(option.id) !== String(volumeId)) continue;
      if (filtersActive && String(volumeId) !== String(option.id)) continue;
      grouped.set(String(option.id), { ...option, chapters: [] });
    }
  }
  return {
    volumes: [...grouped.values()],
    volumeOptions,
    filters: { query: String(query ?? "").trim(), volumeId: String(volumeId ?? ""), outlineStatus, foreshadowStatus, sort },
    page: pageNumber,
    limit,
    itemCount: pageItems.length,
    total: sorted.length,
    pageCount: Math.max(1, Math.ceil(sorted.length / limit)),
    hasMore: start + pageItems.length < sorted.length,
    nextPage: start + pageItems.length < sorted.length ? pageNumber + 1 : null,
    stats: {
      chapterCount: chapterRecords.length,
      outlinedChapterCount: chapterRecords.filter((item) => item.outline).length,
      foreshadowCount: foreshadows.length,
      unresolvedForeshadowCount: foreshadows.filter((item) => item.status === "planned" || item.status === "planted").length
    }
  };
}

const OFFLINE_EDITABLE_ENTITY_TYPES = new Set([
  "chapter",
  "setting",
  "draft",
  "character",
  "race",
  "organization",
  "timeline-track",
  "timeline-event",
  "relationship",
  "chapter-outline",
  "foreshadow"
]);

const OFFLINE_MODULE_IDS = [
  "prose",
  "comments",
  "todos",
  "drafts",
  "settings",
  "characters",
  "races",
  "organizations",
  "timeline",
  "relationships",
  "outlines",
  "reviews",
  "ai-chat",
  "ai-analysis",
  "ai-settings"
];

function workAccess() {
  // 离线界面不按权限隐藏或锁模块。上传时由 Server 按写权限接受或拒绝。
  return {
    accessRole: "owner",
    modulePermissions: Object.fromEntries(OFFLINE_MODULE_IDS.map((module) => [module, "write"]))
  };
}

function textCount(value) {
  return Array.from(String(value ?? "").replace(/\s/gu, "")).length;
}

function filterForeshadows(records, status) {
  if (status === "unresolved") return records.filter((item) => item.status === "planned" || item.status === "planted");
  if (status === "resolved") return records.filter((item) => item.status === "resolved" || item.status === "abandoned");
  return records;
}

export class DesktopOfflineApi {
  constructor(controller, { conversations = null, aiBridge = globalThis.scriverseDesktopWorkspace?.localAi ?? globalThis.scriverseDesktopLocalAi, estimateTokens, titleSource } = {}) {
    this.controller = controller;
    this.store = controller?.store;
    const repository = conversations
      ? null
      : conversationRepositoryFromSyncStore(this.store) ?? createMemoryAiConversationRepository();
    this.conversations = conversations ?? new DesktopOfflineConversations(repository);
    this.ai = new DesktopOfflineConversationAi({ conversations: this.conversations, bridge: aiBridge, estimateTokens, titleSource });
  }

  async snapshots(workId, entityType) {
    if (typeof this.store?.listEntities !== "function") return [];
    try {
      return sortDirectory(await this.store.listEntities(workId, entityType)).map(snapshotRecord);
    } catch {
      return [];
    }
  }

  async moduleState(workId, entityType, records = null) {
    const manifest = (await this.snapshots(workId, "offline-package")).find((item) => item.id === "manifest");
    const state = manifest?.modules?.[entityType];
    if (state === "ready" || state === "denied") return state;
    const stored = records ?? await this.snapshots(workId, entityType);
    return stored.length > 0 ? "ready" : "missing";
  }

  async moduleRecords(workId, entityType) {
    const records = await this.snapshots(workId, entityType);
    if (await this.moduleState(workId, entityType, records) === "missing") {
      throw new DesktopOfflineApiError("OFFLINE_PACKAGE_MISSING", "离线包不存在");
    }
    return records;
  }

  async moduleList(workId, entityType, url, prepare = (records) => records) {
    const records = prepare(await this.moduleRecords(workId, entityType));
    const paged = url.searchParams.has("page") || url.searchParams.has("limit");
    return paged ? page(records, url) : records;
  }

  async singleton(workId, entityType, id, fallback = undefined) {
    const records = await this.moduleRecords(workId, entityType);
    const found = records.find((item) => String(item.id) === id);
    if (found) return found;
    if (fallback !== undefined) return fallback;
    throw new DesktopOfflineApiError("OFFLINE_PACKAGE_MISSING", "离线包不存在");
  }

  async platformRecords(entityType) {
    const records = [];
    const seen = new Set();
    let packaged = false;
    for (const work of await this.store.listWorks()) {
      const stored = await this.snapshots(work.workId, entityType);
      if (await this.moduleState(work.workId, entityType, stored) !== "missing") packaged = true;
      for (const record of stored) {
        if (seen.has(String(record.id))) continue;
        seen.add(String(record.id));
        records.push(record);
      }
    }
    if (!packaged && records.length === 0) throw new DesktopOfflineApiError("OFFLINE_PACKAGE_MISSING", "离线包不存在");
    return records;
  }

  async work(workId, { includeVolumes = false } = {}) {
    const cached = await this.store.getWork(workId);
    if (!cached) throw new DesktopOfflineApiError("SYNC_WORK_NOT_FOUND", "离线副本中不存在该作品");
    const volumeEntities = sortDirectory((await this.store.listEntities(workId, "volume")).map(snapshotRecord));
    const chapterEntities = await this.store.listEntities(workId, "chapter");
    const chaptersByVolume = new Map();
    for (const entity of chapterEntities) {
      const chapter = snapshotRecord(entity);
      const volumeId = String(chapter.volumeId ?? "");
      const records = chaptersByVolume.get(volumeId) ?? [];
      records.push(chapter);
      chaptersByVolume.set(volumeId, records);
    }
    const volumes = volumeEntities.map((volume) => {
      const chapters = sortDirectory(chaptersByVolume.get(String(volume.id)) ?? []);
      return { ...volume, chapterCount: chapters.length, chapters: includeVolumes ? chapters : [] };
    });
    const summary = structuredClone(cached.summary ?? {});
    return {
      ...summary,
      id: String(summary.id ?? cached.workId),
      title: String(summary.title ?? cached.title ?? "未命名作品"),
      coverUrl: typeof summary.coverUrl === "string" ? summary.coverUrl : null,
      ...workAccess(),
      offlineAccessEnabled: true,
      wordCount: chapterEntities.reduce((total, entity) => total + textCount(entity.snapshot?.content), 0),
      chapterCount: chapterEntities.length,
      volumes
    };
  }

  async works(url) {
    const cached = await this.store.listWorks();
    const works = [];
    for (const work of cached) works.push(await this.work(work.workId));
    return page(works, url);
  }

  async volumeChapters(volumeId, url) {
    const works = await this.store.listWorks();
    for (const work of works) {
      const chapters = sortDirectory((await this.store.listEntities(work.workId, "chapter")).map(snapshotRecord))
        .filter((chapter) => String(chapter.volumeId) === volumeId);
      if (chapters.length > 0 || (await this.store.listEntities(work.workId, "volume")).some((entity) => String(entity.entityId) === volumeId)) {
        return page(chapters, url);
      }
    }
    throw new DesktopOfflineApiError("SYNC_VOLUME_NOT_FOUND", "离线副本中不存在该分卷");
  }

  async entity(entityType, entityId) {
    for (const work of await this.store.listWorks()) {
      const entity = await this.store.getEntity(work.workId, entityType, entityId);
      if (entity) return { workId: work.workId, entity, snapshot: snapshotRecord(entity) };
    }
    throw new DesktopOfflineApiError("SYNC_ENTITY_NOT_FOUND", "离线副本中不存在该记录");
  }

  async settings(workId, url, contextOnly = false) {
    const records = sortDirectory(await this.store.listEntities(workId, "setting")).map(snapshotRecord);
    if (contextOnly) return records.filter((setting) => setting.locked === true);
    return page(records, url);
  }

  async saveEntity(entityType, entityId, body) {
    const current = await this.entity(entityType, entityId);
    if (current.entity.locked || current.entity.conflict) {
      throw new DesktopOfflineApiError("SYNC_ENTITY_READ_ONLY", "该记录存在冲突或已锁定为只读，请先在同步中心处理");
    }
    if (!OFFLINE_EDITABLE_ENTITY_TYPES.has(entityType)) {
      throw new DesktopOfflineApiError(
        "DESKTOP_OFFLINE_OPERATION_UNSUPPORTED",
        "当前离线副本不能修改这类记录"
      );
    }
    const reserved = new Set([
      "expectedVersionNo",
      "changeNote",
      "id",
      "workId",
      "versionNo",
      "desktopLocalRevisionNo",
      "desktopSyncConflict",
      "desktopReadOnly",
      "wordCount",
      "contentPreview"
    ]);
    const snapshot = { ...current.snapshot };
    for (const [key, value] of Object.entries(body ?? {})) {
      if (reserved.has(key)) continue;
      snapshot[key] = structuredClone(value);
    }
    const saved = await this.store.saveLocalEntity(current.workId, entityType, entityId, snapshot);
    await this.controller.client.emitStatus("saved", current.workId);
    return {
      ...snapshot,
      versionNo: Number(current.entity.serverVersionNo),
      desktopLocalRevisionNo: Number(saved.localRevisionNo),
      updatedAt: saved.savedAt
    };
  }

  async search(workId, url) {
    const type = String(url.searchParams.get("type") ?? "");
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    const query = String(url.searchParams.get("q") ?? "");
    const hits = [];
    if (!type || type === "agent-history") {
      hits.push(...await this.conversations.searchHistory(workId, query, limit));
    }
    if (type === "chapter" || type === "setting" || !type) {
      const needle = query.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
      const kinds = type === "chapter" || type === "setting" ? [type] : ["chapter", "setting"];
      for (const kind of kinds) {
        for (const record of await this.snapshots(workId, kind)) {
          const title = String(record.title ?? "");
          const content = String(record.content ?? "");
          if (!needle || !`${title}\n${content}`.normalize("NFKC").toLocaleLowerCase("zh-CN").includes(needle)) continue;
          if (!record.id) continue;
          hits.push({
            type: kind,
            id: String(record.id),
            title: title || "未命名",
            snippet: (content || title).slice(0, 180),
            matchKind: "exact"
          });
        }
      }
    }
    return hits.slice(0, limit);
  }

  async races(workId, url) {
    const records = await this.moduleRecords(workId, "race");
    const childCounts = new Map();
    for (const race of records) {
      const parentId = String(race.parentRaceId ?? "");
      if (parentId) childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
    }
    const races = records.map((race) => ({
      ...race,
      childCount: Number.isInteger(race.childCount) ? race.childCount : (childCounts.get(String(race.id)) ?? 0),
      memberIds: Array.isArray(race.memberIds) ? race.memberIds : [],
      members: Array.isArray(race.members) ? race.members : []
    }));
    const scope = url.searchParams.get("scope");
    if (scope === "roots") return { items: races.filter((race) => !race.parentRaceId), total: races.length };
    if (scope === "descendants") return races.filter((race) => race.parentRaceId);
    return url.searchParams.has("page") || url.searchParams.has("limit") ? page(races, url) : races;
  }

  async outlineBoard(workId, url) {
    const [chapters, volumes, outlines, foreshadows] = await Promise.all([
      this.moduleRecords(workId, "chapter"),
      this.moduleRecords(workId, "volume"),
      this.moduleRecords(workId, "chapter-outline"),
      this.moduleRecords(workId, "foreshadow")
    ]);
    return {
      workId,
      ...buildOfflineOutlineBoard({
        chapters,
        volumes,
        outlines,
        foreshadows,
        query: url.searchParams.get("q") ?? "",
        volumeId: url.searchParams.get("volumeId") ?? "",
        outlineStatus: url.searchParams.get("outlineStatus") ?? "all",
        foreshadowStatus: url.searchParams.get("foreshadowStatus") ?? "all",
        sort: url.searchParams.get("sort") ?? "tree",
        page: url.searchParams.get("page"),
        limit: url.searchParams.get("limit")
      })
    };
  }

  async chapterOutline(chapterId) {
    const works = await this.store.listWorks();
    for (const work of works) {
      const outlines = await this.snapshots(work.workId, "chapter-outline");
      const found = outlines.find((item) => String(item.chapterId ?? item.id) === chapterId);
      if (found) return found;
      if (await this.moduleState(work.workId, "chapter-outline", outlines) !== "missing") return null;
    }
    throw new DesktopOfflineApiError("OFFLINE_PACKAGE_MISSING", "离线包不存在");
  }

  async chapterAnnotations(workId, url) {
    const records = await this.moduleRecords(workId, "chapter-annotation");
    const chapterId = url.searchParams.get("chapterId") ?? "";
    const query = String(url.searchParams.get("q") ?? "").trim().toLocaleLowerCase("zh-CN");
    const filtered = records.filter((item) => {
      if (chapterId && String(item.chapterId ?? "") !== chapterId) return false;
      if (!query) return true;
      return [item.note, item.quote, item.chapterTitle, item.volumeTitle].join("\n").toLocaleLowerCase("zh-CN").includes(query);
    });
    const seen = new Set();
    const chapterOptions = [];
    for (const item of records) {
      const id = String(item.chapterId ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      chapterOptions.push({ id, title: String(item.chapterTitle ?? ""), volumeTitle: String(item.volumeTitle ?? "") });
    }
    return { ...page(filtered, url), chapterOptions };
  }

  async tasks(workId, url) {
    const records = [...await this.moduleRecords(workId, "analysis-task")].sort((left, right) => (
      String(right.createdAt ?? "").localeCompare(String(left.createdAt ?? "")) || String(right.id).localeCompare(String(left.id))
    ));
    const running = records.filter((item) => item.status === "running");
    return {
      ...page(records, url),
      stats: {
        total: records.length,
        pendingCount: records.filter((item) => item.status === "pending").length,
        runningCount: running.length,
        runningProgress: running.length
          ? running.reduce((total, item) => total + Number(item.progress ?? 0), 0) / running.length
          : 0
      }
    };
  }

  unsupported() {
    throw new DesktopOfflineApiError(
      "DESKTOP_OFFLINE_OPERATION_UNSUPPORTED",
      "当前离线副本不能完成这个操作；已有内容可以修改，新建、删除和部分管理操作需要恢复连接"
    );
  }

  async request(path, options = {}) {
    const method = String(options.method ?? "GET").toUpperCase();
    const url = new URL(path, globalThis.location?.origin ?? "https://desktop.invalid");
    const pathname = url.pathname;
    if (method === "GET" && pathname === "/api/works") return this.works(url);
    const workMatch = pathname.match(/^\/api\/works\/([^/]+)$/u);
    if (method === "GET" && workMatch) return this.work(decodeURIComponent(workMatch[1]), { includeVolumes: url.searchParams.get("directory") !== "volumes" });
    const volumeChaptersMatch = pathname.match(/^\/api\/volumes\/([^/]+)\/chapters$/u);
    if (method === "GET" && volumeChaptersMatch) return this.volumeChapters(decodeURIComponent(volumeChaptersMatch[1]), url);
    const chapterMatch = pathname.match(/^\/api\/chapters\/([^/]+)$/u);
    if (chapterMatch && method === "GET") return (await this.entity("chapter", decodeURIComponent(chapterMatch[1]))).snapshot;
    if (chapterMatch && method === "PATCH") return this.saveEntity("chapter", decodeURIComponent(chapterMatch[1]), options.body);
    const settingMatch = pathname.match(/^\/api\/settings\/([^/]+)$/u);
    if (settingMatch && method === "GET") return (await this.entity("setting", decodeURIComponent(settingMatch[1]))).snapshot;
    if (settingMatch && method === "PATCH") return this.saveEntity("setting", decodeURIComponent(settingMatch[1]), options.body);
    const workSettingsMatch = pathname.match(/^\/api\/works\/([^/]+)\/settings(?:\/context)?$/u);
    if (method === "GET" && workSettingsMatch) {
      return this.settings(
        decodeURIComponent(workSettingsMatch[1]),
        url,
        pathname.endsWith("/context")
      );
    }
    const packagedList = (workId, entityType, prepare) => this.moduleList(workId, entityType, url, prepare);
    const workDrafts = pathname.match(/^\/api\/works\/([^/]+)\/drafts$/u);
    if (method === "GET" && workDrafts) {
      const draftType = url.searchParams.get("draftType");
      return packagedList(decodeURIComponent(workDrafts[1]), "draft", (records) => (
        draftType === "prose" || draftType === "setting" ? records.filter((item) => item.draftType === draftType) : records
      ));
    }
    const draftMatch = pathname.match(/^\/api\/drafts\/([^/]+)$/u);
    if (draftMatch && method === "GET") return (await this.entity("draft", decodeURIComponent(draftMatch[1]))).snapshot;
    const workCharacters = pathname.match(/^\/api\/works\/([^/]+)\/characters$/u);
    if (method === "GET" && workCharacters) {
      const includeMerged = url.searchParams.get("includeMerged") === "1";
      return packagedList(decodeURIComponent(workCharacters[1]), "character", (records) => (
        includeMerged ? records : records.filter((item) => !item.mergedIntoCharacterId)
      ));
    }
    const characterMatch = pathname.match(/^\/api\/characters\/([^/]+)$/u);
    if (characterMatch && method === "GET") return (await this.entity("character", decodeURIComponent(characterMatch[1]))).snapshot;
    const workRaces = pathname.match(/^\/api\/works\/([^/]+)\/races$/u);
    if (method === "GET" && workRaces) return this.races(decodeURIComponent(workRaces[1]), url);
    const raceMatch = pathname.match(/^\/api\/races\/([^/]+)$/u);
    if (raceMatch && method === "GET") return (await this.entity("race", decodeURIComponent(raceMatch[1]))).snapshot;
    const workOrganizations = pathname.match(/^\/api\/works\/([^/]+)\/organizations$/u);
    if (method === "GET" && workOrganizations) return packagedList(decodeURIComponent(workOrganizations[1]), "organization");
    const organizationMatch = pathname.match(/^\/api\/organizations\/([^/]+)$/u);
    if (organizationMatch && method === "GET") return (await this.entity("organization", decodeURIComponent(organizationMatch[1]))).snapshot;
    const workTimeline = pathname.match(/^\/api\/works\/([^/]+)\/timeline$/u);
    if (method === "GET" && workTimeline) return packagedList(decodeURIComponent(workTimeline[1]), "timeline-event");
    const workTimelineTracks = pathname.match(/^\/api\/works\/([^/]+)\/timeline-tracks$/u);
    if (method === "GET" && workTimelineTracks) return packagedList(decodeURIComponent(workTimelineTracks[1]), "timeline-track");
    const workRelationships = pathname.match(/^\/api\/works\/([^/]+)\/relationships$/u);
    if (method === "GET" && workRelationships) return packagedList(decodeURIComponent(workRelationships[1]), "relationship");
    const workForeshadows = pathname.match(/^\/api\/works\/([^/]+)\/foreshadows$/u);
    if (method === "GET" && workForeshadows) {
      const status = url.searchParams.get("status") ?? "all";
      return packagedList(decodeURIComponent(workForeshadows[1]), "foreshadow", (records) => filterForeshadows(records, status));
    }
    const workOutlines = pathname.match(/^\/api\/works\/([^/]+)\/outlines$/u);
    if (method === "GET" && workOutlines) return packagedList(decodeURIComponent(workOutlines[1]), "chapter-outline");
    const outlineBoard = pathname.match(/^\/api\/works\/([^/]+)\/outline-board$/u);
    if (method === "GET" && outlineBoard) return this.outlineBoard(decodeURIComponent(outlineBoard[1]), url);
    const chapterOutline = pathname.match(/^\/api\/chapters\/([^/]+)\/outline$/u);
    if (chapterOutline && method === "GET") return this.chapterOutline(decodeURIComponent(chapterOutline[1]));
    if (chapterOutline && (method === "PUT" || method === "PATCH")) {
      return this.saveEntity("chapter-outline", decodeURIComponent(chapterOutline[1]), options.body);
    }
    const editableRoutes = [
      [/^\/api\/drafts\/([^/]+)$/u, "draft"],
      [/^\/api\/characters\/([^/]+)$/u, "character"],
      [/^\/api\/races\/([^/]+)$/u, "race"],
      [/^\/api\/organizations\/([^/]+)$/u, "organization"],
      [/^\/api\/timeline-tracks\/([^/]+)$/u, "timeline-track"],
      [/^\/api\/timeline\/([^/]+)$/u, "timeline-event"],
      [/^\/api\/relationships\/([^/]+)$/u, "relationship"],
      [/^\/api\/foreshadows\/([^/]+)$/u, "foreshadow"]
    ];
    if (method === "PATCH" || method === "PUT") {
      for (const [pattern, entityType] of editableRoutes) {
        const match = pathname.match(pattern);
        if (match) return this.saveEntity(entityType, decodeURIComponent(match[1]), options.body);
      }
    }
    const workReviews = pathname.match(/^\/api\/works\/([^/]+)\/reviews$/u);
    if (method === "GET" && workReviews) return packagedList(decodeURIComponent(workReviews[1]), "review");
    const workAnnotations = pathname.match(/^\/api\/works\/([^/]+)\/chapter-annotations$/u);
    if (method === "GET" && workAnnotations) return this.chapterAnnotations(decodeURIComponent(workAnnotations[1]), url);
    const workTasks = pathname.match(/^\/api\/works\/([^/]+)\/tasks$/u);
    if (method === "GET" && workTasks) return this.tasks(decodeURIComponent(workTasks[1]), url);
    const workAiSettings = pathname.match(/^\/api\/works\/([^/]+)\/ai-settings$/u);
    if (method === "GET" && workAiSettings) return this.singleton(decodeURIComponent(workAiSettings[1]), "work-ai-settings", "settings");
    const workModels = pathname.match(/^\/api\/works\/([^/]+)\/models$/u);
    if (method === "GET" && workModels) return packagedList(decodeURIComponent(workModels[1]), "work-model");
    const workSemanticModels = pathname.match(/^\/api\/works\/([^/]+)\/semantic-models$/u);
    if (method === "GET" && workSemanticModels) return packagedList(decodeURIComponent(workSemanticModels[1]), "semantic-model");
    const workTaskDefaults = pathname.match(/^\/api\/works\/([^/]+)\/task-defaults$/u);
    if (method === "GET" && workTaskDefaults) return packagedList(decodeURIComponent(workTaskDefaults[1]), "task-default");
    const relationshipIndex = pathname.match(/^\/api\/works\/([^/]+)\/ai-settings\/relationship-search-index$/u);
    if (method === "GET" && relationshipIndex) {
      return this.singleton(decodeURIComponent(relationshipIndex[1]), "relationship-search-index", "status", { status: "unknown", queuedSources: [] });
    }
    const semanticIndex = pathname.match(/^\/api\/works\/([^/]+)\/ai-settings\/semantic-search-index$/u);
    if (method === "GET" && semanticIndex) {
      return this.singleton(decodeURIComponent(semanticIndex[1]), "semantic-search-index", "status", { status: "unknown" });
    }
    const workUsage = pathname.match(/^\/api\/works\/([^/]+)\/ai-settings\/usage$/u);
    if (method === "GET" && workUsage) return this.singleton(decodeURIComponent(workUsage[1]), "work-token-usage", "usage", { summary: {}, quota: {} });
    const workMcp = pathname.match(/^\/api\/works\/([^/]+)\/ai-settings\/mcp-servers$/u);
    if (method === "GET" && workMcp) {
      return this.singleton(decodeURIComponent(workMcp[1]), "work-mcp-settings", "settings", {
        config: { mcpServers: {} },
        servers: [],
        totalToolCount: 0,
        updatedAt: null
      });
    }
    const workTools = pathname.match(/^\/api\/works\/([^/]+)\/ai\/tools$/u);
    if (method === "GET" && workTools) return this.singleton(decodeURIComponent(workTools[1]), "ai-write-tools", "tools", { tools: {}, labels: {}, descriptions: {}, maxOperations: null });
    if (method === "GET" && pathname === "/api/platform/ai/providers") return this.platformRecords("ai-provider");
    if (method === "GET" && pathname === "/api/platform/ai/protocols") return this.platformRecords("ai-protocol");
    const workSearch = pathname.match(/^\/api\/works\/([^/]+)\/search$/u);
    if (workSearch && method === "GET") return this.search(decodeURIComponent(workSearch[1]), url);
    const workConversations = pathname.match(/^\/api\/works\/([^/]+)\/ai-conversations$/u);
    if (workConversations && method === "GET") return this.conversations.list(decodeURIComponent(workConversations[1]), url);
    if (workConversations && method === "POST") {
      const workId = decodeURIComponent(workConversations[1]);
      const settings = (await this.snapshots(workId, "work-ai-settings")).find((item) => item.id === "settings");
      const body = options.body && typeof options.body === "object" ? { ...options.body } : {};
      if (!Array.isArray(body.agentTools) && Array.isArray(settings?.agentTools)) body.agentTools = settings.agentTools;
      return this.conversations.create(workId, body);
    }
    const conversationTitle = pathname.match(/^\/api\/ai-conversations\/([^/]+)\/title$/u);
    const conversationFork = pathname.match(/^\/api\/ai-conversations\/([^/]+)\/fork$/u);
    if (conversationFork && method === "POST") return this.conversations.fork(decodeURIComponent(conversationFork[1]), options.body);
    const conversationExport = pathname.match(/^\/api\/ai-conversations\/([^/]+)\/export$/u);
    if (conversationExport && method === "GET") return this.conversations.exportMarkdown(decodeURIComponent(conversationExport[1]));
    const conversationCompact = pathname.match(/^\/api\/ai-conversations\/([^/]+)\/compact$/u);
    if (conversationCompact && method === "POST") return this.ai.compact(decodeURIComponent(conversationCompact[1]), options.body);
    const conversationContext = pathname.match(/^\/api\/ai-conversations\/([^/]+)\/context$/u);
    if (conversationContext && method === "POST") return this.ai.context(decodeURIComponent(conversationContext[1]), options.body);
    if (conversationTitle && method === "GET") {
      const conversationId = decodeURIComponent(conversationTitle[1]);
      await this.ai.generateTitle(conversationId).catch(() => undefined);
      return this.conversations.title(conversationId);
    }
    if (conversationTitle && method === "PATCH") return this.conversations.setTitle(decodeURIComponent(conversationTitle[1]), options.body);
    const conversationFavorite = pathname.match(/^\/api\/ai-conversations\/([^/]+)\/favorite$/u);
    if (conversationFavorite && method === "PATCH") return this.conversations.setFavorite(decodeURIComponent(conversationFavorite[1]), options.body);
    const conversationTask = pathname.match(/^\/api\/ai-conversations\/([^/]+)\/task-type$/u);
    if (conversationTask && method === "PATCH") return this.conversations.setTaskType(decodeURIComponent(conversationTask[1]), options.body);
    const conversationScope = pathname.match(/^\/api\/ai-conversations\/([^/]+)\/context-scope$/u);
    if (conversationScope && method === "PATCH") return this.conversations.setContextScope(decodeURIComponent(conversationScope[1]), options.body);
    const conversationRoleplay = pathname.match(/^\/api\/ai-conversations\/([^/]+)\/roleplay$/u);
    if (conversationRoleplay && method === "PATCH") {
      const conversation = await this.conversations.require(decodeURIComponent(conversationRoleplay[1]));
      const characters = await this.snapshots(conversation.workId, "character");
      return this.conversations.setRoleplay(conversation.id, options.body, characters);
    }
    const conversationMessages = pathname.match(/^\/api\/ai-conversations\/([^/]+)\/messages$/u);
    if (conversationMessages && method === "POST") return this.conversations.addMessage(decodeURIComponent(conversationMessages[1]), options.body);
    const conversationMemories = pathname.match(/^\/api\/ai-conversations\/([^/]+)\/local-roleplay-memories$/u);
    if (conversationMemories && method === "PUT") return this.conversations.saveRoleplayMemories(decodeURIComponent(conversationMemories[1]), options.body?.memories);
    const conversationItem = pathname.match(/^\/api\/ai-conversations\/([^/]+)$/u);
    if (conversationItem && method === "GET") return this.conversations.get(decodeURIComponent(conversationItem[1]), url);
    if (conversationItem && method === "DELETE") return this.conversations.remove(decodeURIComponent(conversationItem[1]));
    if (method === "GET" && /^\/api\/chapters\/[^/]+\/(?:annotation-counts|annotations)$/u.test(pathname)) return [];
    if (method === "GET" && /^\/api\/works\/[^/]+\/chapters\/[^/]+\/foreshadow-reminders$/u.test(pathname)) return [];
    if (method === "GET" && /^\/api\/(?:chapters\/[^/]+\/versions|entity-versions\/[^/]+\/[^/]+)$/u.test(pathname)) return [];
    if (method === "POST" && /^\/api\/works\/[^/]+\/presence$/u.test(pathname)) return { participants: [], recentChanges: [] };
    return this.unsupported();
  }
}

export function createDesktopOfflineApi(controller, options) {
  return new DesktopOfflineApi(controller, options);
}
