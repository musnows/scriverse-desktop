const DATABASE_VERSION = 1;
const SCHEMA_VERSION = 1;
const SYNC_PROTOCOL = 1;
const EDITABLE_ENTITY_TYPES = new Set(["chapter", "setting"]);
const OUTBOX_STATUSES = new Set(["pending", "syncing", "conflict", "rejected"]);
const INITIAL_OFFLINE_DOWNLOAD_KEY = "initial-offline-download";

export class DesktopSyncStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DesktopSyncStoreError";
    this.code = code;
  }
}

function assertUuid(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new DesktopSyncStoreError("SYNC_ID_INVALID", `${label} 无效`);
  }
  return value;
}

function assertEntityType(value) {
  if (!EDITABLE_ENTITY_TYPES.has(value)) throw new DesktopSyncStoreError("SYNC_ENTITY_TYPE_UNSUPPORTED", "该类型暂不支持离线编辑");
  return value;
}

function requestValue(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), { once: true });
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), { once: true });
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new DesktopSyncStoreError("SYNC_KEY_INVALID", "Desktop 返回的离线密钥无效");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32 || bytesToBase64(bytes) !== value) {
    throw new DesktopSyncStoreError("SYNC_KEY_INVALID", "Desktop 返回的离线密钥无效");
  }
  return bytes;
}

function cipherAad(context) {
  return new TextEncoder().encode(stableSyncJson(context));
}

async function importDataKey(keyBase64, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new DesktopSyncStoreError("SYNC_CRYPTO_UNAVAILABLE", "当前环境不支持离线数据加密");
  return cryptoImpl.subtle.importKey("raw", base64ToBytes(keyBase64), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function stableSyncJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableSyncJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSyncJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function desktopSyncDatabaseName(profileId, userId) {
  return `scriverse-desktop-sync-${assertUuid(profileId, "profile id")}-${assertUuid(userId, "user id")}`;
}

export function normalizeInitialOfflineDownloadState(value) {
  if (
    !value
    || value.key !== INITIAL_OFFLINE_DOWNLOAD_KEY
    || (value.decision !== "accepted" && value.decision !== "declined")
    || typeof value.completed !== "boolean"
    || typeof value.updatedAt !== "string"
    || !Number.isFinite(Date.parse(value.updatedAt))
  ) return null;
  return {
    decision: value.decision,
    completed: value.completed,
    updatedAt: value.updatedAt
  };
}

export async function encryptSyncSnapshot(snapshot, keyBase64, context, cryptoImpl = globalThis.crypto) {
  const key = await importDataKey(keyBase64, cryptoImpl);
  const iv = cryptoImpl.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(stableSyncJson(snapshot));
  const ciphertext = await cryptoImpl.subtle.encrypt({ name: "AES-GCM", iv, additionalData: cipherAad(context) }, key, plaintext);
  return { version: 1, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}

export async function decryptSyncSnapshot(cipher, keyBase64, context, cryptoImpl = globalThis.crypto) {
  if (
    !cipher
    || cipher.version !== 1
    || typeof cipher.iv !== "string"
    || typeof cipher.ciphertext !== "string"
  ) throw new DesktopSyncStoreError("SYNC_CIPHER_INVALID", "离线数据密文格式无效");
  const key = await importDataKey(keyBase64, cryptoImpl);
  try {
    const plaintext = await cryptoImpl.subtle.decrypt({
      name: "AES-GCM",
      iv: Uint8Array.from(atob(cipher.iv), (character) => character.charCodeAt(0)),
      additionalData: cipherAad(context)
    }, key, Uint8Array.from(atob(cipher.ciphertext), (character) => character.charCodeAt(0)));
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new DesktopSyncStoreError("SYNC_DECRYPT_FAILED", "离线数据无法解密，已停止继续读写");
  }
}

async function requestHash(value, cryptoImpl = globalThis.crypto) {
  const digest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(stableSyncJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function entityKey(workId, entityType, entityId) {
  return [workId, entityType, entityId];
}

function cipherContext(profileId, userId, workId, entityType, entityId, slot) {
  return { profileId, userId, workId, entityType, entityId, slot, schemaVersion: SCHEMA_VERSION };
}

function openDatabase(indexedDBImpl, name) {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(name, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta", { keyPath: "key" });
      if (!database.objectStoreNames.contains("works")) database.createObjectStore("works", { keyPath: "workId" });
      if (!database.objectStoreNames.contains("entities")) {
        const entities = database.createObjectStore("entities", { keyPath: ["workId", "entityType", "entityId"] });
        entities.createIndex("by-work", "workId", { unique: false });
        entities.createIndex("by-work-dirty", ["workId", "dirtyFlag"], { unique: false });
      }
      if (!database.objectStoreNames.contains("outbox")) {
        const outbox = database.createObjectStore("outbox", { keyPath: "mutationId" });
        outbox.createIndex("by-work", "workId", { unique: false });
        outbox.createIndex("by-work-status", ["workId", "status"], { unique: false });
        outbox.createIndex("by-entity-status", ["workId", "entityType", "entityId", "status"], { unique: false });
        outbox.createIndex("by-created", ["workId", "createdAt", "mutationId"], { unique: false });
      }
      if (!database.objectStoreNames.contains("conflicts")) {
        const conflicts = database.createObjectStore("conflicts", { keyPath: "mutationId" });
        conflicts.createIndex("by-work", "workId", { unique: false });
      }
    });
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB open failed")), { once: true });
    request.addEventListener("blocked", () => reject(new DesktopSyncStoreError("SYNC_DATABASE_BLOCKED", "离线数据库升级被其他窗口阻止")), { once: true });
  });
}

export function pullChangeDisposition(entity, change) {
  if (!entity || entity.deleted) return "apply";
  if (!entity.dirty) return "apply";
  if (Number(change.versionNo) === Number(entity.serverVersionNo)) return "keep-local";
  return "conflict";
}

function summaryWorkStatus(workStore, workId, status) {
  const request = workStore.get(workId);
  request.addEventListener("success", () => {
    if (request.result) workStore.put({ ...request.result, status, updatedAt: new Date().toISOString() });
  }, { once: true });
}

export class DesktopSyncStore {
  constructor({ profileId, userId, keyBase64, indexedDBImpl = globalThis.indexedDB, cryptoImpl = globalThis.crypto }) {
    this.profileId = assertUuid(profileId, "profile id");
    this.userId = assertUuid(userId, "user id");
    base64ToBytes(keyBase64);
    if (!indexedDBImpl) throw new DesktopSyncStoreError("SYNC_DATABASE_UNAVAILABLE", "当前环境不支持 IndexedDB");
    this.keyBase64 = keyBase64;
    this.indexedDB = indexedDBImpl;
    this.crypto = cryptoImpl;
    this.databasePromise = null;
  }

  async open() {
    if (!this.databasePromise) {
      this.databasePromise = openDatabase(this.indexedDB, desktopSyncDatabaseName(this.profileId, this.userId))
        .then(async (database) => {
          const transaction = database.transaction(["meta"], "readwrite");
          const store = transaction.objectStore("meta");
          const existing = await requestValue(store.get("identity"));
          if (existing && (
            existing.profileId !== this.profileId
            || existing.userId !== this.userId
            || existing.schemaVersion !== SCHEMA_VERSION
          )) {
            transaction.abort();
            throw new DesktopSyncStoreError("SYNC_DATABASE_IDENTITY_MISMATCH", "离线数据库与当前 profile 或用户不匹配");
          }
          if (!existing) {
            store.put({
              key: "identity",
              profileId: this.profileId,
              userId: this.userId,
              schemaVersion: SCHEMA_VERSION,
              syncProtocol: SYNC_PROTOCOL,
              clientId: crypto.randomUUID(),
              createdAt: new Date().toISOString(),
              lastSuccessfulSyncAt: null
            });
          }
          await transactionDone(transaction);
          return database;
        });
    }
    return this.databasePromise;
  }

  async identity() {
    const database = await this.open();
    const transaction = database.transaction(["meta"], "readonly");
    const identity = await requestValue(transaction.objectStore("meta").get("identity"));
    await transactionDone(transaction);
    return structuredClone(identity);
  }

  async getInitialOfflineDownloadState() {
    const database = await this.open();
    const transaction = database.transaction(["meta"], "readonly");
    const value = await requestValue(transaction.objectStore("meta").get(INITIAL_OFFLINE_DOWNLOAD_KEY));
    await transactionDone(transaction);
    return normalizeInitialOfflineDownloadState(value);
  }

  async setInitialOfflineDownloadState({ decision, completed }) {
    if (decision !== "accepted" && decision !== "declined") {
      throw new DesktopSyncStoreError("SYNC_INITIAL_DOWNLOAD_STATE_INVALID", "首次离线下载选择无效");
    }
    if (typeof completed !== "boolean" || (decision === "declined" && completed !== true)) {
      throw new DesktopSyncStoreError("SYNC_INITIAL_DOWNLOAD_STATE_INVALID", "首次离线下载完成状态无效");
    }
    const value = {
      key: INITIAL_OFFLINE_DOWNLOAD_KEY,
      decision,
      completed,
      updatedAt: new Date().toISOString()
    };
    const database = await this.open();
    const transaction = database.transaction(["meta"], "readwrite");
    transaction.objectStore("meta").put(value);
    await transactionDone(transaction);
    return normalizeInitialOfflineDownloadState(value);
  }

  async replaceSnapshot({ workId, cutoffCursor, items, permissionsSnapshot = null }) {
    if (typeof workId !== "string" || workId.length === 0 || !Array.isArray(items)) {
      throw new DesktopSyncStoreError("SYNC_SNAPSHOT_INVALID", "同步快照无效");
    }
    const currentStatus = await this.statusSummary(workId);
    if (currentStatus.pending > 0 || currentStatus.syncing > 0 || currentStatus.conflicts > 0 || currentStatus.rejected > 0) {
      throw new DesktopSyncStoreError("SYNC_SNAPSHOT_DIRTY", "作品仍有未处理的本地变更，不能覆盖离线副本");
    }
    const workItem = items.find((item) => item.entityType === "work");
    if (!workItem?.data || String(workItem.entityId) !== workId) {
      throw new DesktopSyncStoreError("SYNC_SNAPSHOT_INVALID", "同步快照缺少作品摘要");
    }
    const encryptedEntities = [];
    for (const item of items) {
      if (item.entityType === "work") continue;
      if (!item.data || typeof item.data !== "object") throw new DesktopSyncStoreError("SYNC_SNAPSHOT_INVALID", "同步快照实体无效");
      const context = cipherContext(this.profileId, this.userId, workId, item.entityType, String(item.entityId), "server");
      const serverCipher = await encryptSyncSnapshot(item.data, this.keyBase64, context, this.crypto);
      encryptedEntities.push({
        workId,
        entityType: item.entityType,
        entityId: String(item.entityId),
        serverVersionNo: Number(item.versionNo),
        baseCipher: serverCipher,
        serverCipher,
        localCipher: serverCipher,
        localRevisionNo: 0,
        dirty: false,
        dirtyFlag: 0,
        deleted: false,
        locked: false,
        updatedAt: new Date().toISOString()
      });
    }
    const database = await this.open();
    const transaction = database.transaction(["works", "entities"], "readwrite");
    const entityStore = transaction.objectStore("entities");
    const existingKeys = await requestValue(entityStore.index("by-work").getAllKeys(workId));
    for (const key of existingKeys) entityStore.delete(key);
    for (const entity of encryptedEntities) entityStore.put(entity);
    transaction.objectStore("works").put({
      workId,
      title: String(workItem.data.title ?? "未命名作品"),
      summary: structuredClone(workItem.data),
      cursor: Number(cutoffCursor),
      permissionsSnapshot: structuredClone(permissionsSnapshot),
      status: "ready",
      enabledAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await transactionDone(transaction);
    return { workId, cursor: Number(cutoffCursor), entityCount: encryptedEntities.length };
  }

  async listWorks() {
    const database = await this.open();
    const transaction = database.transaction(["works"], "readonly");
    const works = await requestValue(transaction.objectStore("works").getAll());
    await transactionDone(transaction);
    return works.map((work) => structuredClone(work));
  }

  async getEntity(workId, entityType, entityId) {
    const database = await this.open();
    const transaction = database.transaction(["entities"], "readonly");
    const entity = await requestValue(transaction.objectStore("entities").get(entityKey(workId, entityType, entityId)));
    await transactionDone(transaction);
    if (!entity || entity.deleted) return null;
    const slot = entity.dirty ? "local" : "server";
    const snapshot = await decryptSyncSnapshot(
      entity.dirty ? entity.localCipher : entity.serverCipher,
      this.keyBase64,
      cipherContext(this.profileId, this.userId, workId, entityType, entityId, slot),
      this.crypto
    );
    return { ...structuredClone(entity), snapshot };
  }

  async listEntities(workId, entityType) {
    const database = await this.open();
    const transaction = database.transaction(["entities"], "readonly");
    const entities = await requestValue(transaction.objectStore("entities").index("by-work").getAll(workId));
    await transactionDone(transaction);
    const selected = entityType ? entities.filter((entity) => entity.entityType === entityType) : entities;
    const result = [];
    for (const entity of selected) {
      if (entity.deleted) continue;
      result.push(await this.getEntity(workId, entity.entityType, entity.entityId));
    }
    return result.filter(Boolean);
  }

  async saveLocalEntity(workId, entityTypeValue, entityId, localSnapshot, changeNote = "Desktop 离线修改") {
    const entityType = assertEntityType(entityTypeValue);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.getEntity(workId, entityType, entityId);
      if (!current) throw new DesktopSyncStoreError("SYNC_ENTITY_NOT_FOUND", "离线副本中不存在该记录");
      if (current.locked) throw new DesktopSyncStoreError("SYNC_ENTITY_READ_ONLY", "该记录已因权限或同步失败锁定为只读");
      const database = await this.open();
      const lookup = database.transaction(["outbox"], "readonly");
      const pending = (await requestValue(lookup.objectStore("outbox").index("by-entity-status").getAll([
        workId,
        entityType,
        entityId,
        "pending"
      ])))[0] ?? null;
      await transactionDone(lookup);
      const mutationId = pending?.mutationId ?? crypto.randomUUID();
      const baseVersionNo = Number(pending?.baseVersionNo ?? current.serverVersionNo);
      const localCipher = await encryptSyncSnapshot(
        localSnapshot,
        this.keyBase64,
        cipherContext(this.profileId, this.userId, workId, entityType, entityId, "local"),
        this.crypto
      );
      const mutation = {
        mutationId,
        entityType,
        entityId,
        operation: "update",
        baseVersionNo,
        localSnapshot,
        changeNote: String(changeNote).trim().slice(0, 500) || "Desktop 离线修改"
      };
      const hash = await requestHash(mutation, this.crypto);
      const transaction = database.transaction(["entities", "outbox"], "readwrite");
      const entityStore = transaction.objectStore("entities");
      const outboxStore = transaction.objectStore("outbox");
      const lockedEntity = await requestValue(entityStore.get(entityKey(workId, entityType, entityId)));
      const lockedPending = pending ? await requestValue(outboxStore.get(pending.mutationId)) : null;
      if (
        !lockedEntity
        || Number(lockedEntity.localRevisionNo) !== Number(current.localRevisionNo)
        || (pending && lockedPending?.status !== "pending")
      ) {
        transaction.abort();
        await transactionDone(transaction).catch(() => undefined);
        continue;
      }
      const timestamp = new Date().toISOString();
      entityStore.put({
        ...lockedEntity,
        localCipher,
        localRevisionNo: Number(lockedEntity.localRevisionNo) + 1,
        dirty: true,
        dirtyFlag: 1,
        updatedAt: timestamp
      });
      outboxStore.put({
        mutationId,
        workId,
        entityType,
        entityId,
        operation: "update",
        baseVersionNo,
        localSnapshotCipher: localCipher,
        changeNote: mutation.changeNote,
        requestHash: hash,
        localRevisionNo: Number(lockedEntity.localRevisionNo) + 1,
        status: "pending",
        attempts: Number(pending?.attempts ?? 0),
        nextAttemptAt: null,
        createdAt: pending?.createdAt ?? timestamp,
        updatedAt: timestamp
      });
      await transactionDone(transaction);
      return { mutationId, localRevisionNo: Number(lockedEntity.localRevisionNo) + 1, savedAt: timestamp };
    }
    throw new DesktopSyncStoreError("SYNC_LOCAL_SAVE_BUSY", "离线记录被其他窗口持续修改，请重试");
  }

  async listOutbox(workId, statuses = ["pending", "syncing", "conflict", "rejected"]) {
    if (!Array.isArray(statuses) || statuses.some((status) => !OUTBOX_STATUSES.has(status))) {
      throw new DesktopSyncStoreError("SYNC_OUTBOX_STATUS_INVALID", "outbox 状态无效");
    }
    const database = await this.open();
    const transaction = database.transaction(["outbox"], "readonly");
    const rows = [];
    for (const status of statuses) {
      rows.push(...await requestValue(transaction.objectStore("outbox").index("by-work-status").getAll([workId, status])));
    }
    await transactionDone(transaction);
    rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.mutationId.localeCompare(right.mutationId));
    const result = [];
    for (const row of rows) {
      const localSnapshot = await decryptSyncSnapshot(
        row.localSnapshotCipher,
        this.keyBase64,
        cipherContext(this.profileId, this.userId, row.workId, row.entityType, row.entityId, "local"),
        this.crypto
      );
      result.push({ ...structuredClone(row), localSnapshot });
    }
    return result;
  }

  async getWork(workId) {
    const database = await this.open();
    const transaction = database.transaction(["works"], "readonly");
    const work = await requestValue(transaction.objectStore("works").get(workId));
    await transactionDone(transaction);
    return work ? structuredClone(work) : null;
  }

  async setWorkStatus(workId, status, reason = null) {
    if (!["ready", "syncing", "offline", "read-only", "error"].includes(status)) {
      throw new DesktopSyncStoreError("SYNC_WORK_STATUS_INVALID", "离线作品状态无效");
    }
    const database = await this.open();
    const transaction = database.transaction(["works"], "readwrite");
    const store = transaction.objectStore("works");
    const work = await requestValue(store.get(workId));
    if (!work) {
      transaction.abort();
      throw new DesktopSyncStoreError("SYNC_WORK_NOT_FOUND", "离线作品不存在");
    }
    store.put({ ...work, status, statusReason: reason, updatedAt: new Date().toISOString() });
    await transactionDone(transaction);
  }

  async applyRemoteChanges(workId, changes, nextCursor) {
    if (!Array.isArray(changes) || !Number.isInteger(nextCursor) || nextCursor < 0) {
      throw new DesktopSyncStoreError("SYNC_CHANGES_INVALID", "Server 增量变更无效");
    }
    const summary = { applied: 0, keptLocal: 0, conflicts: 0 };
    for (const change of changes) {
      const disposition = await this.applyRemoteChange(workId, change);
      if (disposition === "apply") summary.applied += 1;
      if (disposition === "keep-local") summary.keptLocal += 1;
      if (disposition === "conflict") summary.conflicts += 1;
    }
    const database = await this.open();
    const transaction = database.transaction(["works", "meta"], "readwrite");
    const workStore = transaction.objectStore("works");
    const work = await requestValue(workStore.get(workId));
    if (!work) {
      transaction.abort();
      throw new DesktopSyncStoreError("SYNC_WORK_NOT_FOUND", "离线作品不存在");
    }
    const timestamp = new Date().toISOString();
    workStore.put({ ...work, cursor: Math.max(Number(work.cursor), nextCursor), updatedAt: timestamp });
    const metaStore = transaction.objectStore("meta");
    const identity = await requestValue(metaStore.get("identity"));
    metaStore.put({ ...identity, lastSuccessfulSyncAt: timestamp });
    await transactionDone(transaction);
    return summary;
  }

  async applyRemoteChange(workId, change) {
    if (
      !change
      || (change.entityType !== "chapter" && change.entityType !== "setting")
      || typeof change.entityId !== "string"
      || (change.operation !== "upsert" && change.operation !== "delete")
      || !Number.isInteger(change.versionNo)
      || change.versionNo < 1
    ) throw new DesktopSyncStoreError("SYNC_CHANGE_INVALID", "Server 增量变更字段无效");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.rawEntity(workId, change.entityType, change.entityId);
      const disposition = pullChangeDisposition(current, change);
      if (disposition === "keep-local") return disposition;
      const serverSnapshot = change.operation === "delete"
        ? { id: change.entityId, workId, versionNo: change.versionNo, deleted: true }
        : change.data;
      if (!serverSnapshot || typeof serverSnapshot !== "object") {
        throw new DesktopSyncStoreError("SYNC_CHANGE_INVALID", "Server upsert 缺少实体快照");
      }
      const serverCipher = await encryptSyncSnapshot(
        serverSnapshot,
        this.keyBase64,
        cipherContext(this.profileId, this.userId, workId, change.entityType, change.entityId, "server"),
        this.crypto
      );
      let conflictRecord = null;
      let relatedMutationIds = [];
      if (disposition === "conflict") {
        const baseSnapshot = await decryptSyncSnapshot(
          current.baseCipher,
          this.keyBase64,
          cipherContext(this.profileId, this.userId, workId, change.entityType, change.entityId, "server"),
          this.crypto
        );
        const localSnapshot = await decryptSyncSnapshot(
          current.localCipher,
          this.keyBase64,
          cipherContext(this.profileId, this.userId, workId, change.entityType, change.entityId, "local"),
          this.crypto
        );
        const outbox = await this.rawOutboxForEntity(workId, change.entityType, change.entityId);
        const active = outbox.filter((record) => record.status === "pending" || record.status === "syncing");
        if (active.length === 0) throw new DesktopSyncStoreError("SYNC_STORE_INVARIANT", "本地 dirty 实体缺少 outbox 记录");
        relatedMutationIds = active.map((record) => record.mutationId);
        const mutationId = relatedMutationIds[0];
        conflictRecord = {
          mutationId,
          relatedMutationIds,
          workId,
          entityType: change.entityType,
          entityId: change.entityId,
          baseVersionNo: Number(current.serverVersionNo),
          currentServerVersionNo: Number(change.versionNo),
          baseSnapshotCipher: await encryptSyncSnapshot(
            baseSnapshot,
            this.keyBase64,
            cipherContext(this.profileId, this.userId, workId, change.entityType, change.entityId, "conflict-base"),
            this.crypto
          ),
          localSnapshotCipher: await encryptSyncSnapshot(
            localSnapshot,
            this.keyBase64,
            cipherContext(this.profileId, this.userId, workId, change.entityType, change.entityId, "conflict-local"),
            this.crypto
          ),
          serverSnapshotCipher: await encryptSyncSnapshot(
            serverSnapshot,
            this.keyBase64,
            cipherContext(this.profileId, this.userId, workId, change.entityType, change.entityId, "conflict-server"),
            this.crypto
          ),
          mergeDraftCipher: await encryptSyncSnapshot(
            localSnapshot,
            this.keyBase64,
            cipherContext(this.profileId, this.userId, workId, change.entityType, change.entityId, "conflict-merge"),
            this.crypto
          ),
          unresolvedBlockCount: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
      }
      const database = await this.open();
      const transaction = database.transaction(["entities", "outbox", "conflicts"], "readwrite");
      const entityStore = transaction.objectStore("entities");
      const locked = await requestValue(entityStore.get(entityKey(workId, change.entityType, change.entityId)));
      if (
        (current && (!locked
          || Number(locked.localRevisionNo) !== Number(current.localRevisionNo)
          || Number(locked.serverVersionNo) !== Number(current.serverVersionNo)))
        || (!current && locked)
      ) {
        transaction.abort();
        await transactionDone(transaction).catch(() => undefined);
        continue;
      }
      if (disposition === "conflict") {
        entityStore.put({
          ...locked,
          serverVersionNo: Number(change.versionNo),
          serverCipher,
          conflict: true,
          updatedAt: new Date().toISOString()
        });
        const outboxStore = transaction.objectStore("outbox");
        for (const mutationId of relatedMutationIds) {
          const record = await requestValue(outboxStore.get(mutationId));
          if (record) outboxStore.put({ ...record, status: "conflict", updatedAt: new Date().toISOString() });
        }
        transaction.objectStore("conflicts").put(conflictRecord);
      } else if (change.operation === "delete") {
        entityStore.put({
          ...(locked ?? {
            workId,
            entityType: change.entityType,
            entityId: change.entityId,
            localRevisionNo: 0
          }),
          serverVersionNo: Number(change.versionNo),
          baseCipher: serverCipher,
          serverCipher,
          localCipher: serverCipher,
          dirty: false,
          dirtyFlag: 0,
          deleted: true,
          locked: true,
          conflict: false,
          updatedAt: new Date().toISOString()
        });
      } else {
        entityStore.put({
          workId,
          entityType: change.entityType,
          entityId: change.entityId,
          serverVersionNo: Number(change.versionNo),
          baseCipher: serverCipher,
          serverCipher,
          localCipher: serverCipher,
          localRevisionNo: Number(locked?.localRevisionNo ?? 0),
          dirty: false,
          dirtyFlag: 0,
          deleted: false,
          locked: false,
          conflict: false,
          updatedAt: new Date().toISOString()
        });
      }
      await transactionDone(transaction);
      return disposition;
    }
    throw new DesktopSyncStoreError("SYNC_LOCAL_SAVE_BUSY", "离线记录在拉取期间持续变化，请重试");
  }

  async preparePushBatch(workId, limit = 20) {
    const identity = await this.identity();
    const pending = (await this.listOutbox(workId, ["pending"]))
      .filter((record) => !record.nextAttemptAt || Date.parse(record.nextAttemptAt) <= Date.now())
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 20)));
    if (pending.length === 0) return { clientId: identity.clientId, mutations: [], mutationIds: [] };
    const mutations = pending.map((record) => ({
      mutationId: record.mutationId,
      entityType: record.entityType,
      entityId: record.entityId,
      operation: "update",
      baseVersionNo: Number(record.baseVersionNo),
      localSnapshot: record.localSnapshot,
      changeNote: record.changeNote
    }));
    const hashes = await Promise.all(mutations.map((mutation) => requestHash(mutation, this.crypto)));
    const database = await this.open();
    const transaction = database.transaction(["outbox"], "readwrite");
    const store = transaction.objectStore("outbox");
    const claimed = [];
    for (let index = 0; index < pending.length; index += 1) {
      const source = pending[index];
      const record = await requestValue(store.get(source.mutationId));
      if (!record || record.status !== "pending" || Number(record.localRevisionNo) !== Number(source.localRevisionNo)) continue;
      store.put({
        ...record,
        requestHash: hashes[index],
        status: "syncing",
        attempts: Number(record.attempts) + 1,
        updatedAt: new Date().toISOString()
      });
      claimed.push(index);
    }
    await transactionDone(transaction);
    return {
      clientId: identity.clientId,
      mutations: claimed.map((index) => mutations[index]),
      mutationIds: claimed.map((index) => pending[index].mutationId)
    };
  }

  async applyPushResults(workId, results) {
    if (!Array.isArray(results)) throw new DesktopSyncStoreError("SYNC_PUSH_RESULT_INVALID", "Server push 结果无效");
    const summary = { applied: 0, conflicts: 0, rejected: 0 };
    for (const result of results) {
      const disposition = await this.applyPushResult(workId, result);
      summary[disposition] += 1;
    }
    return summary;
  }

  async applyPushResult(workId, result) {
    if (!result || !OUTBOX_STATUSES.has(result.status === "applied" ? "syncing" : result.status)) {
      throw new DesktopSyncStoreError("SYNC_PUSH_RESULT_INVALID", "Server push 结果字段无效");
    }
    const database = await this.open();
    const read = database.transaction(["outbox"], "readonly");
    const outbox = await requestValue(read.objectStore("outbox").get(result.mutationId));
    await transactionDone(read);
    if (!outbox || outbox.workId !== workId) return result.status === "applied" ? "applied" : result.status === "conflict" ? "conflicts" : "rejected";
    let serverCipher = null;
    let conflictRecord = null;
    if (result.serverSnapshot) {
      serverCipher = await encryptSyncSnapshot(
        result.serverSnapshot,
        this.keyBase64,
        cipherContext(this.profileId, this.userId, workId, outbox.entityType, outbox.entityId, "server"),
        this.crypto
      );
    }
    if (result.status === "conflict") {
      if (!result.baseSnapshot || !result.localSnapshot || !result.serverSnapshot) {
        throw new DesktopSyncStoreError("SYNC_PUSH_RESULT_INVALID", "Server 冲突结果缺少三方快照");
      }
      conflictRecord = {
        mutationId: result.mutationId,
        relatedMutationIds: [result.mutationId],
        workId,
        entityType: outbox.entityType,
        entityId: outbox.entityId,
        baseVersionNo: Number(result.baseVersionNo),
        currentServerVersionNo: Number(result.conflictVersionNo),
        baseSnapshotCipher: await encryptSyncSnapshot(
          result.baseSnapshot,
          this.keyBase64,
          cipherContext(this.profileId, this.userId, workId, outbox.entityType, outbox.entityId, "conflict-base"),
          this.crypto
        ),
        localSnapshotCipher: await encryptSyncSnapshot(
          result.localSnapshot,
          this.keyBase64,
          cipherContext(this.profileId, this.userId, workId, outbox.entityType, outbox.entityId, "conflict-local"),
          this.crypto
        ),
        serverSnapshotCipher: await encryptSyncSnapshot(
          result.serverSnapshot,
          this.keyBase64,
          cipherContext(this.profileId, this.userId, workId, outbox.entityType, outbox.entityId, "conflict-server"),
          this.crypto
        ),
        mergeDraftCipher: await encryptSyncSnapshot(
          result.localSnapshot,
          this.keyBase64,
          cipherContext(this.profileId, this.userId, workId, outbox.entityType, outbox.entityId, "conflict-merge"),
          this.crypto
        ),
        unresolvedBlockCount: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }
    const transaction = database.transaction(["entities", "outbox", "conflicts", "works"], "readwrite");
    const entityStore = transaction.objectStore("entities");
    const outboxStore = transaction.objectStore("outbox");
    const conflictStore = transaction.objectStore("conflicts");
    const workStore = transaction.objectStore("works");
    const entity = await requestValue(entityStore.get(entityKey(workId, outbox.entityType, outbox.entityId)));
    const currentOutbox = await requestValue(outboxStore.get(result.mutationId));
    if (!entity || !currentOutbox) {
      transaction.abort();
      throw new DesktopSyncStoreError("SYNC_STORE_INVARIANT", "push 结果找不到本地实体或 outbox");
    }
    if (result.status === "applied") {
      if (!serverCipher || !Number.isInteger(result.appliedVersionNo)) {
        transaction.abort();
        throw new DesktopSyncStoreError("SYNC_PUSH_RESULT_INVALID", "Server applied 结果缺少权威快照");
      }
      const allOutbox = await requestValue(outboxStore.index("by-work").getAll(workId));
      const successors = allOutbox.filter((record) => (
        record.mutationId !== result.mutationId
        && record.entityType === outbox.entityType
        && record.entityId === outbox.entityId
        && (record.status === "pending" || record.status === "syncing")
      ));
      const hasNewerLocal = Number(entity.localRevisionNo) > Number(outbox.localRevisionNo) || successors.length > 0;
      entityStore.put({
        ...entity,
        serverVersionNo: Number(result.appliedVersionNo),
        baseCipher: serverCipher,
        serverCipher,
        ...(hasNewerLocal ? {} : { localCipher: serverCipher }),
        dirty: hasNewerLocal,
        dirtyFlag: hasNewerLocal ? 1 : 0,
        deleted: false,
        locked: false,
        conflict: false,
        updatedAt: new Date().toISOString()
      });
      for (const successor of successors) {
        outboxStore.put({
          ...successor,
          baseVersionNo: Number(result.appliedVersionNo),
          requestHash: null,
          status: "pending",
          updatedAt: new Date().toISOString()
        });
      }
      outboxStore.delete(result.mutationId);
      conflictStore.delete(result.mutationId);
      summaryWorkStatus(workStore, workId, "ready");
      await transactionDone(transaction);
      return "applied";
    }
    if (result.status === "conflict") {
      entityStore.put({
        ...entity,
        serverVersionNo: Number(result.conflictVersionNo),
        ...(serverCipher ? { serverCipher } : {}),
        dirty: true,
        dirtyFlag: 1,
        conflict: true,
        updatedAt: new Date().toISOString()
      });
      outboxStore.put({ ...currentOutbox, status: "conflict", updatedAt: new Date().toISOString() });
      conflictStore.put(conflictRecord);
      await transactionDone(transaction);
      return "conflicts";
    }
    entityStore.put({ ...entity, locked: true, updatedAt: new Date().toISOString() });
    outboxStore.put({
      ...currentOutbox,
      status: "rejected",
      errorCode: result.errorCode ?? "SYNC_MUTATION_REJECTED",
      updatedAt: new Date().toISOString()
    });
    summaryWorkStatus(workStore, workId, "read-only");
    await transactionDone(transaction);
    return "rejected";
  }

  async returnSyncingToPending(mutationIds, nextAttemptAt = null) {
    const database = await this.open();
    const transaction = database.transaction(["outbox"], "readwrite");
    const store = transaction.objectStore("outbox");
    for (const mutationId of new Set(mutationIds)) {
      const record = await requestValue(store.get(mutationId));
      if (record?.status === "syncing") {
        store.put({ ...record, status: "pending", nextAttemptAt, updatedAt: new Date().toISOString() });
      }
    }
    await transactionDone(transaction);
  }

  async listConflicts(workId) {
    const database = await this.open();
    const transaction = database.transaction(["conflicts"], "readonly");
    const records = await requestValue(transaction.objectStore("conflicts").index("by-work").getAll(workId));
    await transactionDone(transaction);
    const result = [];
    for (const record of records) {
      const context = (slot) => cipherContext(this.profileId, this.userId, workId, record.entityType, record.entityId, slot);
      result.push({
        ...structuredClone(record),
        baseSnapshot: await decryptSyncSnapshot(record.baseSnapshotCipher, this.keyBase64, context("conflict-base"), this.crypto),
        localSnapshot: await decryptSyncSnapshot(record.localSnapshotCipher, this.keyBase64, context("conflict-local"), this.crypto),
        serverSnapshot: await decryptSyncSnapshot(record.serverSnapshotCipher, this.keyBase64, context("conflict-server"), this.crypto),
        mergeDraft: await decryptSyncSnapshot(record.mergeDraftCipher, this.keyBase64, context("conflict-merge"), this.crypto)
      });
    }
    return result;
  }

  async saveMergeDraft(mutationId, mergeDraft, unresolvedBlockCount) {
    const database = await this.open();
    const read = database.transaction(["conflicts"], "readonly");
    const conflict = await requestValue(read.objectStore("conflicts").get(mutationId));
    await transactionDone(read);
    if (!conflict) throw new DesktopSyncStoreError("SYNC_CONFLICT_NOT_FOUND", "同步冲突不存在");
    const cipher = await encryptSyncSnapshot(
      mergeDraft,
      this.keyBase64,
      cipherContext(this.profileId, this.userId, conflict.workId, conflict.entityType, conflict.entityId, "conflict-merge"),
      this.crypto
    );
    const transaction = database.transaction(["conflicts"], "readwrite");
    const store = transaction.objectStore("conflicts");
    const locked = await requestValue(store.get(mutationId));
    if (!locked) {
      transaction.abort();
      throw new DesktopSyncStoreError("SYNC_CONFLICT_NOT_FOUND", "同步冲突不存在");
    }
    store.put({
      ...locked,
      mergeDraftCipher: cipher,
      unresolvedBlockCount: Math.max(0, Number(unresolvedBlockCount) || 0),
      updatedAt: new Date().toISOString()
    });
    await transactionDone(transaction);
  }

  async resolveConflict(mutationId, finalSnapshot, changeNote = "Desktop 冲突合并") {
    const conflicts = await this.listConflictsForMutation(mutationId);
    const conflict = conflicts[0];
    if (!conflict) throw new DesktopSyncStoreError("SYNC_CONFLICT_NOT_FOUND", "同步冲突不存在");
    const newMutationId = crypto.randomUUID();
    const localCipher = await encryptSyncSnapshot(
      finalSnapshot,
      this.keyBase64,
      cipherContext(this.profileId, this.userId, conflict.workId, conflict.entityType, conflict.entityId, "local"),
      this.crypto
    );
    const mutation = {
      mutationId: newMutationId,
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      operation: "update",
      baseVersionNo: Number(conflict.currentServerVersionNo),
      localSnapshot: finalSnapshot,
      changeNote: String(changeNote).trim().slice(0, 500) || "Desktop 冲突合并"
    };
    const hash = await requestHash(mutation, this.crypto);
    const database = await this.open();
    const transaction = database.transaction(["entities", "outbox", "conflicts"], "readwrite");
    const entityStore = transaction.objectStore("entities");
    const entity = await requestValue(entityStore.get(entityKey(conflict.workId, conflict.entityType, conflict.entityId)));
    if (!entity) {
      transaction.abort();
      throw new DesktopSyncStoreError("SYNC_ENTITY_NOT_FOUND", "冲突实体不存在");
    }
    entityStore.put({
      ...entity,
      localCipher,
      localRevisionNo: Number(entity.localRevisionNo) + 1,
      dirty: true,
      dirtyFlag: 1,
      locked: false,
      conflict: false,
      updatedAt: new Date().toISOString()
    });
    const outboxStore = transaction.objectStore("outbox");
    for (const relatedMutationId of conflict.relatedMutationIds ?? [mutationId]) outboxStore.delete(relatedMutationId);
    outboxStore.put({
      mutationId: newMutationId,
      workId: conflict.workId,
      entityType: conflict.entityType,
      entityId: conflict.entityId,
      operation: "update",
      baseVersionNo: Number(conflict.currentServerVersionNo),
      localSnapshotCipher: localCipher,
      localRevisionNo: Number(entity.localRevisionNo) + 1,
      changeNote: mutation.changeNote,
      requestHash: hash,
      status: "pending",
      attempts: 0,
      nextAttemptAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    transaction.objectStore("conflicts").delete(mutationId);
    await transactionDone(transaction);
    return { mutationId: newMutationId };
  }

  async acquireSyncLease(workId, leaseId = crypto.randomUUID(), ttlMs = 30_000) {
    const database = await this.open();
    const transaction = database.transaction(["meta"], "readwrite");
    const store = transaction.objectStore("meta");
    const key = `sync-lease:${workId}`;
    const current = await requestValue(store.get(key));
    const timestamp = Date.now();
    if (current && current.leaseId !== leaseId && Number(current.expiresAtMs) > timestamp) {
      await transactionDone(transaction);
      return null;
    }
    store.put({ key, leaseId, workId, expiresAtMs: timestamp + Math.max(5_000, Number(ttlMs) || 30_000) });
    await transactionDone(transaction);
    return { leaseId, expiresAtMs: timestamp + Math.max(5_000, Number(ttlMs) || 30_000) };
  }

  async releaseSyncLease(workId, leaseId) {
    const database = await this.open();
    const transaction = database.transaction(["meta"], "readwrite");
    const store = transaction.objectStore("meta");
    const key = `sync-lease:${workId}`;
    const current = await requestValue(store.get(key));
    if (current?.leaseId === leaseId) store.delete(key);
    await transactionDone(transaction);
  }

  async rawEntity(workId, entityType, entityId) {
    const database = await this.open();
    const transaction = database.transaction(["entities"], "readonly");
    const entity = await requestValue(transaction.objectStore("entities").get(entityKey(workId, entityType, entityId)));
    await transactionDone(transaction);
    return entity ?? null;
  }

  async rawOutboxForEntity(workId, entityType, entityId) {
    const database = await this.open();
    const transaction = database.transaction(["outbox"], "readonly");
    const records = await requestValue(transaction.objectStore("outbox").index("by-work").getAll(workId));
    await transactionDone(transaction);
    return records
      .filter((record) => record.entityType === entityType && record.entityId === entityId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async listConflictsForMutation(mutationId) {
    const database = await this.open();
    const transaction = database.transaction(["conflicts"], "readonly");
    const record = await requestValue(transaction.objectStore("conflicts").get(mutationId));
    await transactionDone(transaction);
    if (!record) return [];
    return this.listConflicts(record.workId).then((conflicts) => conflicts.filter((conflict) => conflict.mutationId === mutationId));
  }

  async markSyncing(mutationIds) {
    const ids = [...new Set(mutationIds)];
    const database = await this.open();
    const transaction = database.transaction(["outbox"], "readwrite");
    const store = transaction.objectStore("outbox");
    const claimed = [];
    for (const mutationId of ids) {
      const record = await requestValue(store.get(mutationId));
      if (!record || record.status !== "pending") continue;
      const updated = {
        ...record,
        status: "syncing",
        attempts: Number(record.attempts) + 1,
        updatedAt: new Date().toISOString()
      };
      store.put(updated);
      claimed.push(updated);
    }
    await transactionDone(transaction);
    return claimed.map((record) => structuredClone(record));
  }

  async recoverSyncing() {
    const database = await this.open();
    const transaction = database.transaction(["outbox"], "readwrite");
    const store = transaction.objectStore("outbox");
    const records = await requestValue(store.getAll());
    let recovered = 0;
    for (const record of records) {
      if (record.status !== "syncing") continue;
      store.put({ ...record, status: "pending", updatedAt: new Date().toISOString() });
      recovered += 1;
    }
    await transactionDone(transaction);
    return recovered;
  }

  async statusSummary(workId) {
    const database = await this.open();
    const transaction = database.transaction(["outbox", "conflicts"], "readonly");
    const outbox = transaction.objectStore("outbox");
    const counts = {};
    for (const status of OUTBOX_STATUSES) {
      counts[status] = await requestValue(outbox.index("by-work-status").count([workId, status]));
    }
    const conflicts = await requestValue(transaction.objectStore("conflicts").index("by-work").count(workId));
    await transactionDone(transaction);
    return {
      pending: Number(counts.pending ?? 0),
      syncing: Number(counts.syncing ?? 0),
      conflicts: Number(conflicts),
      rejected: Number(counts.rejected ?? 0)
    };
  }

  async createRescueBundle(workId) {
    const work = (await this.listWorks()).find((candidate) => candidate.workId === workId);
    if (!work) throw new DesktopSyncStoreError("SYNC_WORK_NOT_FOUND", "离线副本中不存在该作品");
    const [identity, outbox, conflicts] = await Promise.all([
      this.identity(),
      this.listOutbox(workId),
      this.listConflicts(workId)
    ]);
    if (outbox.length === 0 && conflicts.length === 0) {
      throw new DesktopSyncStoreError("SYNC_RESCUE_NOT_REQUIRED", "该作品没有需要导出的本机修改");
    }
    return {
      format: "scriverse-desktop-rescue",
      version: 1,
      generatedAt: new Date().toISOString(),
      profileId: this.profileId,
      userId: this.userId,
      clientId: String(identity.clientId),
      work: {
        workId: work.workId,
        title: work.title,
        cursor: Number(work.cursor),
        status: work.status,
        updatedAt: work.updatedAt
      },
      outbox: outbox.map((record) => ({
        mutationId: record.mutationId,
        entityType: record.entityType,
        entityId: record.entityId,
        operation: record.operation,
        baseVersionNo: Number(record.baseVersionNo),
        status: record.status,
        changeNote: record.changeNote,
        localSnapshot: record.localSnapshot,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      })),
      conflicts: conflicts.map((conflict) => ({
        mutationId: conflict.mutationId,
        relatedMutationIds: conflict.relatedMutationIds,
        entityType: conflict.entityType,
        entityId: conflict.entityId,
        baseVersionNo: Number(conflict.baseVersionNo),
        currentServerVersionNo: Number(conflict.currentServerVersionNo),
        baseSnapshot: conflict.baseSnapshot,
        localSnapshot: conflict.localSnapshot,
        serverSnapshot: conflict.serverSnapshot,
        mergeDraft: conflict.mergeDraft,
        unresolvedBlockCount: conflict.unresolvedBlockCount,
        createdAt: conflict.createdAt,
        updatedAt: conflict.updatedAt
      }))
    };
  }

  close() {
    void this.databasePromise?.then((database) => database.close());
    this.databasePromise = null;
  }
}
