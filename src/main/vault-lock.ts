import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

export type LocalVaultLock = {
  bootId: string;
  release: () => void;
};

type LockDocument = {
  version: 1;
  desktopId: string;
  bootId: string;
  pid: number;
  startedAt: string;
};

export class LocalVaultLockError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalVaultLockError";
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function readLock(path: string): LockDocument {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<LockDocument>;
    if (
      value.version !== 1
      || !isUuid(value.desktopId)
      || !isUuid(value.bootId)
      || !Number.isInteger(value.pid)
      || Number(value.pid) < 1
      || typeof value.startedAt !== "string"
      || !Number.isFinite(Date.parse(value.startedAt))
    ) throw new Error("invalid lock document");
    return value as LockDocument;
  } catch {
    throw new LocalVaultLockError("LOCAL_VAULT_LOCK_INVALID", "本地工作区锁文件损坏，已拒绝自动接管");
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function assertDatabaseIsUnlocked(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE; ROLLBACK;");
  } catch {
    throw new LocalVaultLockError("LOCAL_VAULT_DATABASE_BUSY", "本地数据库仍被其他进程占用，已拒绝接管");
  } finally {
    database?.close();
  }
}

function archiveLock(path: string, suffix: string): void {
  const archivedPath = `${path}.${suffix}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
  renameSync(path, archivedPath);
  chmodSync(archivedPath, 0o600);
}

export function acquireLocalVaultLock(options: {
  lockPath: string;
  databasePath: string;
  desktopId: string;
  pid?: number;
}): LocalVaultLock {
  if (!isUuid(options.desktopId)) throw new LocalVaultLockError("LOCAL_VAULT_ID_INVALID", "Desktop 实例标识无效");
  const pid = options.pid ?? process.pid;
  mkdirSync(dirname(options.lockPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(options.lockPath), 0o700);
  if (existsSync(options.lockPath)) {
    const existing = readLock(options.lockPath);
    if (processIsAlive(existing.pid)) {
      throw new LocalVaultLockError("LOCAL_VAULT_BUSY", "本地工作区已由另一个 Desktop 进程打开");
    }
    assertDatabaseIsUnlocked(options.databasePath);
    archiveLock(options.lockPath, "stale");
  }
  const descriptor = openSync(options.lockPath, "wx", 0o600);
  const document: LockDocument = {
    version: 1,
    desktopId: options.desktopId,
    bootId: randomUUID(),
    pid,
    startedAt: new Date().toISOString()
  };
  try {
    writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    chmodSync(options.lockPath, 0o600);
  } catch (error) {
    closeSync(descriptor);
    if (existsSync(options.lockPath)) archiveLock(options.lockPath, "failed");
    throw error;
  }
  let released = false;
  return {
    bootId: document.bootId,
    release: () => {
      if (released) return;
      released = true;
      closeSync(descriptor);
      if (!existsSync(options.lockPath)) return;
      const current = readLock(options.lockPath);
      if (current.bootId !== document.bootId) {
        throw new LocalVaultLockError("LOCAL_VAULT_LOCK_REPLACED", "本地工作区锁已被替换，拒绝释放其他进程的锁");
      }
      archiveLock(options.lockPath, "released");
    }
  };
}
