const TASK_TYPES = new Set(["chat", "roleplay"]);
const MESSAGE_ROLES = new Set(["user", "assistant"]);

export class DesktopOfflineConversationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DesktopOfflineConversationError";
    this.code = code;
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function displayText(content) {
  return String(content ?? "")
    .replace(/<[^>]+>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function conversationTitleFromMessage(content) {
  const normalized = displayText(content);
  return Array.from(normalized).slice(0, 15).join("") || "新对话";
}

function emptyScope() {
  return { type: "none" };
}

function emptyScenePin() {
  return { location: "", time: "", participants: "" };
}

export function desktopOfflineConversationWorkKey(workId) {
  const normalized = String(workId ?? "").trim();
  if (!normalized) throw new DesktopOfflineConversationError("AI_CONVERSATION_WORK_REQUIRED", "请先选择作品");
  return normalized;
}

export function createMemoryAiConversationRepository(backing = new Map()) {
  return {
    async list(workId) {
      return [...backing.values()]
        .filter((record) => record.workId === workId)
        .map((record) => clone(record));
    },
    async get(conversationId) {
      const record = backing.get(conversationId);
      return record ? clone(record) : null;
    },
    async put(record) {
      backing.set(record.id, clone(record));
      return clone(record);
    },
    async delete(conversationId) {
      backing.delete(conversationId);
    }
  };
}

export function conversationRepositoryFromSyncStore(store) {
  if (typeof store?.listAiConversationRecords !== "function") return null;
  return {
    list: (workId) => store.listAiConversationRecords(workId),
    get: (conversationId) => store.getAiConversationRecord(conversationId),
    put: (record) => store.putAiConversationRecord(record),
    delete: (conversationId) => store.deleteAiConversationRecord(conversationId)
  };
}

function pageItems(items, url, fallbackLimit = 20) {
  const requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || fallbackLimit));
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

function messageHasImages(message) {
  return Array.isArray(message?.metadata?.chatImageAttachmentIds)
    && message.metadata.chatImageAttachmentIds.some((attachmentId) => String(attachmentId ?? "").trim().length > 0);
}

function summaryOf(record, { includeMessages = false, messages = null, messagesPage = null } = {}) {
  const storedMessages = Array.isArray(record.messages) ? record.messages : [];
  const visibleMessages = messages ?? storedMessages;
  const lastMessage = storedMessages.at(-1);
  const lockedModelId = storedMessages.find((message) => typeof message?.metadata?.modelId === "string")?.metadata.modelId ?? null;
  const hasImageAttachments = storedMessages.some(messageHasImages);
  return {
    id: record.id,
    workId: record.workId,
    title: record.title,
    isFavorite: record.isFavorite === true,
    messageCount: storedMessages.length,
    preview: displayText(lastMessage?.content ?? "").slice(0, 280),
    compactedMessageCount: 0,
    hasCompactedSummary: false,
    contextWarningPending: false,
    taskType: record.taskType ?? "chat",
    ...(lockedModelId ? { modelId: lockedModelId } : {}),
    ...(hasImageAttachments ? { hasImageAttachments: true, modelLockedByImage: true } : {}),
    contextScope: clone(record.contextScope ?? emptyScope()),
    scenePin: clone(record.scenePin ?? emptyScenePin()),
    roleplayCharacter: clone(record.roleplayCharacter ?? null),
    roleplayUserCharacter: clone(record.roleplayUserCharacter ?? null),
    agentTools: Array.isArray(record.agentTools) ? [...record.agentTools] : null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(includeMessages ? {
      messages: visibleMessages.map(publicMessage),
      ...(messagesPage ? { messagesPage } : {}),
      roleplayMemories: clone(record.roleplayMemories ?? [])
    } : {})
  };
}

function publicMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    citations: clone(message.citations ?? []),
    metadata: clone(message.metadata ?? {}),
    ...(message.requestId ? { requestId: message.requestId } : {}),
    createdAt: message.createdAt
  };
}

function sortConversations(records) {
  return [...records].sort((left, right) => {
    const favoriteDelta = Number(right.isFavorite === true) - Number(left.isFavorite === true);
    if (favoriteDelta !== 0) return favoriteDelta;
    return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
  });
}

function assertObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DesktopOfflineConversationError("AI_CONVERSATION_INVALID", "对话请求无效");
  }
  return body;
}

export class DesktopOfflineConversations {
  constructor(repository) {
    if (!repository) throw new DesktopOfflineConversationError("AI_CONVERSATION_STORE_UNAVAILABLE", "离线对话存储不可用");
    this.repository = repository;
  }

  async list(workId, url) {
    const records = sortConversations(await this.repository.list(desktopOfflineConversationWorkKey(workId)));
    const paged = pageItems(records, url, 20);
    return { ...paged, items: paged.items.map((record) => summaryOf(record)) };
  }

  async create(workId, body = {}) {
    const input = assertObject(body ?? {});
    const taskType = input.taskType === undefined || input.taskType === null ? "chat" : String(input.taskType);
    if (!TASK_TYPES.has(taskType)) {
      throw new DesktopOfflineConversationError("AI_CONVERSATION_TASK_INVALID", "对话模式无效");
    }
    const title = String(input.title ?? "新对话").trim().slice(0, 200) || "新对话";
    const timestamp = nowIso();
    const record = {
      id: newId(),
      workId: desktopOfflineConversationWorkKey(workId),
      title,
      isFavorite: false,
      taskType,
      contextScope: emptyScope(),
      scenePin: emptyScenePin(),
      roleplayCharacter: null,
      roleplayUserCharacter: null,
      agentTools: Array.isArray(input.agentTools) ? input.agentTools.filter((toolId) => typeof toolId === "string") : null,
      messages: [],
      roleplayMemories: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.repository.put(record);
    return summaryOf(record, { includeMessages: true, messages: [] });
  }

  async get(conversationId, url) {
    const record = await this.require(conversationId);
    const stored = [...(record.messages ?? [])].reverse();
    const focusId = url.searchParams.get("messageId");
    let requestedPage = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit")) || 100));
    if (focusId) {
      const newestIndex = stored.findIndex((message) => message.id === focusId);
      if (newestIndex >= 0) requestedPage = Math.floor(newestIndex / limit) + 1;
    }
    const start = (requestedPage - 1) * limit;
    const selected = stored.slice(start, start + limit).reverse();
    const messagesPage = {
      items: selected.map(publicMessage),
      page: requestedPage,
      limit,
      total: stored.length,
      hasMore: start + selected.length < stored.length,
      nextPage: start + selected.length < stored.length ? requestedPage + 1 : null
    };
    return summaryOf(record, { includeMessages: true, messages: selected, messagesPage });
  }

  async setFavorite(conversationId, body) {
    const input = assertObject(body);
    if (typeof input.isFavorite !== "boolean") {
      throw new DesktopOfflineConversationError("AI_CONVERSATION_INVALID", "收藏状态无效");
    }
    const record = await this.require(conversationId);
    record.isFavorite = input.isFavorite;
    record.updatedAt = nowIso();
    await this.repository.put(record);
    return summaryOf(record);
  }

  async setTitle(conversationId, body) {
    const input = assertObject(body);
    const title = String(input.title ?? "").trim();
    if (!title || title.length > 200) throw new DesktopOfflineConversationError("AI_CONVERSATION_INVALID", "对话名称无效");
    const record = await this.require(conversationId);
    record.title = title;
    record.updatedAt = nowIso();
    await this.repository.put(record);
    return summaryOf(record);
  }

  async title(conversationId) {
    const record = await this.require(conversationId);
    return { id: record.id, title: record.title, updatedAt: record.updatedAt };
  }

  async remove(conversationId) {
    await this.require(conversationId);
    await this.repository.delete(conversationId);
    return { deleted: true };
  }

  async setTaskType(conversationId, body) {
    const input = assertObject(body);
    const taskType = String(input.taskType ?? "");
    if (!TASK_TYPES.has(taskType)) throw new DesktopOfflineConversationError("AI_CONVERSATION_TASK_INVALID", "对话模式无效");
    const record = await this.require(conversationId);
    if ((record.messages ?? []).some((message) => message.role === "user") && record.taskType !== taskType) {
      throw new DesktopOfflineConversationError("AI_CONVERSATION_LOCKED", "对话已经开始，不能再改模式");
    }
    record.taskType = taskType;
    if (taskType !== "roleplay") {
      record.roleplayCharacter = null;
      record.roleplayUserCharacter = null;
    }
    record.updatedAt = nowIso();
    await this.repository.put(record);
    return summaryOf(record);
  }

  async setContextScope(conversationId, body) {
    const input = assertObject(body);
    if (!input.scope || typeof input.scope !== "object" || Array.isArray(input.scope)) {
      throw new DesktopOfflineConversationError("AI_CONVERSATION_INVALID", "上下文范围无效");
    }
    const record = await this.require(conversationId);
    record.contextScope = clone(input.scope);
    record.updatedAt = nowIso();
    await this.repository.put(record);
    return summaryOf(record);
  }

  async setRoleplay(conversationId, body, characters = []) {
    const input = assertObject(body);
    const record = await this.require(conversationId);
    const characterId = input.characterId === null || input.characterId === undefined ? null : String(input.characterId);
    const userCharacterId = input.userCharacterId === null || input.userCharacterId === undefined ? null : String(input.userCharacterId);
    const character = characterId ? characters.find((item) => String(item.id) === characterId) ?? null : null;
    if (characterId && !character) throw new DesktopOfflineConversationError("ROLEPLAY_CHARACTER_NOT_FOUND", "离线副本中不存在该角色");
    const userCharacter = userCharacterId ? characters.find((item) => String(item.id) === userCharacterId) ?? null : null;
    if (userCharacterId && !userCharacter) throw new DesktopOfflineConversationError("ROLEPLAY_CHARACTER_NOT_FOUND", "离线副本中不存在该用户角色");
    record.taskType = character ? "roleplay" : record.taskType === "roleplay" ? "chat" : record.taskType;
    record.roleplayCharacter = character ? { id: String(character.id), name: String(character.name ?? ""), code: String(character.code ?? "") } : null;
    record.roleplayUserCharacter = character && userCharacter
      ? { id: String(userCharacter.id), name: String(userCharacter.name ?? ""), code: String(userCharacter.code ?? "") }
      : null;
    record.updatedAt = nowIso();
    await this.repository.put(record);
    return summaryOf(record);
  }

  async addMessage(conversationId, body) {
    const input = assertObject(body);
    const role = String(input.role ?? "");
    const content = String(input.content ?? "");
    if (!MESSAGE_ROLES.has(role) || !content.trim() || content.length > 200_000) {
      throw new DesktopOfflineConversationError("AI_CONVERSATION_MESSAGE_INVALID", "对话消息无效");
    }
    const record = await this.require(conversationId);
    const timestamp = nowIso();
    const message = {
      id: newId(),
      conversationId: record.id,
      role,
      content,
      citations: Array.isArray(input.citations) ? clone(input.citations).slice(0, 100) : [],
      metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? clone(input.metadata) : {},
      ...(typeof input.requestId === "string" ? { requestId: input.requestId } : {}),
      createdAt: timestamp
    };
    record.messages = [...(record.messages ?? []), message].slice(-400);
    if (record.title === "新对话" && role === "user") record.title = conversationTitleFromMessage(content);
    record.updatedAt = timestamp;
    await this.repository.put(record);
    return publicMessage(message);
  }

  async saveRoleplayMemories(conversationId, memories) {
    const record = await this.require(conversationId);
    record.roleplayMemories = Array.isArray(memories) ? clone(memories).slice(0, 80) : [];
    record.updatedAt = nowIso();
    await this.repository.put(record);
    return { id: record.id, roleplayMemories: record.roleplayMemories };
  }

  async require(conversationId) {
    const record = await this.repository.get(String(conversationId ?? ""));
    if (!record || record.chapterId !== undefined || record.settingId !== undefined) {
      throw new DesktopOfflineConversationError("AI_CONVERSATION_NOT_FOUND", "AI 对话不存在");
    }
    return record;
  }
}
