import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export const STORAGE_MANIFEST_FILENAME = "storage-manifest.json";
export const STORAGE_MANIFEST_VERSION = 1;
export const DESKTOP_ROOT_STORAGE_KIND = "scriverse-desktop-root";
export const DESKTOP_LOCAL_VAULT_STORAGE_KIND = "scriverse-desktop-local-vault";
export const SERVER_STORAGE_KIND = "scriverse-server-data";

export type DesktopRootManifest = {
  kind: typeof DESKTOP_ROOT_STORAGE_KIND;
  storageVersion: typeof STORAGE_MANIFEST_VERSION;
  desktopId: string;
  createdAt: string;
};

export type DesktopLocalVaultManifest = {
  kind: typeof DESKTOP_LOCAL_VAULT_STORAGE_KIND;
  storageVersion: typeof STORAGE_MANIFEST_VERSION;
  desktopId: string;
  createdAt: string;
};

type DesktopStorageManifest = DesktopRootManifest | DesktopLocalVaultManifest;

export class DesktopStorageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DesktopStorageError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new DesktopStorageError("STORAGE_MANIFEST_INVALID", `存储清单的 ${field} 无效`);
  }
  return value;
}

function assertCreatedAt(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new DesktopStorageError("STORAGE_MANIFEST_INVALID", "存储清单的 createdAt 无效");
  }
  return value;
}

function parseManifest(value: unknown): DesktopStorageManifest {
  if (!isRecord(value)) throw new DesktopStorageError("STORAGE_MANIFEST_INVALID", "存储清单格式无效");
  if (value.kind !== DESKTOP_ROOT_STORAGE_KIND && value.kind !== DESKTOP_LOCAL_VAULT_STORAGE_KIND) {
    throw new DesktopStorageError("STORAGE_KIND_MISMATCH", "该目录不属于 Scriverse Desktop，已拒绝打开");
  }
  if (value.storageVersion !== STORAGE_MANIFEST_VERSION) {
    throw new DesktopStorageError("STORAGE_VERSION_UNSUPPORTED", "该存储目录版本暂不受当前 Scriverse Desktop 支持");
  }
  return {
    kind: value.kind,
    storageVersion: STORAGE_MANIFEST_VERSION,
    desktopId: assertUuid(value.desktopId, "desktopId"),
    createdAt: assertCreatedAt(value.createdAt)
  };
}

function readManifest(directory: string): DesktopStorageManifest | null {
  const path = join(directory, STORAGE_MANIFEST_FILENAME);
  if (!existsSync(path)) return null;
  try {
    return parseManifest(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof DesktopStorageError) throw error;
    throw new DesktopStorageError("STORAGE_MANIFEST_INVALID", "存储清单无法读取或不是有效 JSON");
  }
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function writeDesktopJsonAtomically(path: string, value: unknown): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
  chmodSync(path, 0o600);
  syncDirectory(directory);
}

function assertEmptyUnclaimedDirectory(directory: string): void {
  const entries = readdirSync(directory).filter((entry) => !entry.startsWith(`${STORAGE_MANIFEST_FILENAME}.tmp-`));
  if (entries.length > 0) {
    throw new DesktopStorageError("STORAGE_DIRECTORY_UNCLAIMED", "非空目录缺少 Scriverse Desktop 存储清单，已拒绝打开");
  }
}

export function initializeDesktopStorageRoot(directory: string): DesktopRootManifest {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const existing = readManifest(directory);
  if (existing) {
    if (existing.kind !== DESKTOP_ROOT_STORAGE_KIND) {
      throw new DesktopStorageError("STORAGE_KIND_MISMATCH", "该目录不是 Scriverse Desktop 根目录，已拒绝打开");
    }
    return existing;
  }
  assertEmptyUnclaimedDirectory(directory);
  const manifest: DesktopRootManifest = {
    kind: DESKTOP_ROOT_STORAGE_KIND,
    storageVersion: STORAGE_MANIFEST_VERSION,
    desktopId: randomUUID(),
    createdAt: new Date().toISOString()
  };
  writeDesktopJsonAtomically(join(directory, STORAGE_MANIFEST_FILENAME), manifest);
  return manifest;
}

export function initializeDesktopLocalVault(directory: string, desktopId: string): DesktopLocalVaultManifest {
  assertUuid(desktopId, "desktopId");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const existing = readManifest(directory);
  if (existing) {
    if (existing.kind !== DESKTOP_LOCAL_VAULT_STORAGE_KIND || existing.desktopId !== desktopId) {
      throw new DesktopStorageError("STORAGE_KIND_MISMATCH", "该目录不是当前 Scriverse Desktop 的本地工作区，已拒绝打开");
    }
    return existing;
  }
  assertEmptyUnclaimedDirectory(directory);
  const manifest: DesktopLocalVaultManifest = {
    kind: DESKTOP_LOCAL_VAULT_STORAGE_KIND,
    storageVersion: STORAGE_MANIFEST_VERSION,
    desktopId,
    createdAt: new Date().toISOString()
  };
  writeDesktopJsonAtomically(join(directory, STORAGE_MANIFEST_FILENAME), manifest);
  return manifest;
}
