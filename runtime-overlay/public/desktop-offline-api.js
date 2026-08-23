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
  return {
    ...snapshot,
    ...(typeof snapshot?.content === "string" ? { wordCount: textCount(snapshot.content) } : {}),
    versionNo: Number(entity.snapshot?.versionNo ?? entity.serverVersionNo),
    desktopLocalRevisionNo: Number(entity.localRevisionNo ?? 0),
    desktopSyncConflict: entity.conflict === true,
    desktopReadOnly: entity.locked === true
  };
}

function workAccess(work) {
  const saved = work.permissionsSnapshot && typeof work.permissionsSnapshot === "object" && !Array.isArray(work.permissionsSnapshot)
    ? work.permissionsSnapshot
    : {};
  const modulePermissions = saved.modulePermissions && typeof saved.modulePermissions === "object" && !Array.isArray(saved.modulePermissions)
    ? saved.modulePermissions
    : saved;
  const permissionValues = Object.values(modulePermissions);
  const fallbackRole = permissionValues.length > 0 && permissionValues.every((access) => access === "write")
    ? "editor"
    : permissionValues.some((access) => access === "write") ? "custom" : "viewer";
  return {
    accessRole: typeof saved.accessRole === "string" ? saved.accessRole : fallbackRole,
    modulePermissions: structuredClone(modulePermissions)
  };
}

function textCount(value) {
  return Array.from(String(value ?? "").replace(/\s/gu, "")).length;
}

export class DesktopOfflineApi {
  constructor(controller) {
    this.controller = controller;
    this.store = controller.store;
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
      coverUrl: null,
      ...workAccess(cached),
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
    const allowed = entityType === "chapter"
      ? ["title", "content", "chapterType"]
      : ["title", "category", "content", "tags", "status", "locked", "evidence", "scope", "authorNote"];
    const snapshot = { ...current.snapshot };
    for (const key of allowed) {
      if (body && Object.hasOwn(body, key)) snapshot[key] = structuredClone(body[key]);
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

  unsupported() {
    throw new DesktopOfflineApiError(
      "DESKTOP_OFFLINE_OPERATION_UNSUPPORTED",
      "当前离线副本仅支持修改已下载的正文和设定；其他操作需恢复连接后完成"
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
    if (method === "GET" && /^\/api\/chapters\/[^/]+\/(?:annotation-counts|annotations)$/u.test(pathname)) return [];
    if (method === "GET" && /^\/api\/works\/[^/]+\/chapters\/[^/]+\/foreshadow-reminders$/u.test(pathname)) return [];
    if (method === "GET" && /^\/api\/(?:chapters\/[^/]+\/versions|entity-versions\/[^/]+\/[^/]+)$/u.test(pathname)) return [];
    if (method === "POST" && /^\/api\/works\/[^/]+\/presence$/u.test(pathname)) return { participants: [], recentChanges: [] };
    return this.unsupported();
  }
}

export function createDesktopOfflineApi(controller) {
  return new DesktopOfflineApi(controller);
}
