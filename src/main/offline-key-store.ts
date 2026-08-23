import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RemoteWorkspaceProfile } from "../shared/contracts.js";
import { writeDesktopJsonAtomically } from "../shared/storage-manifest.js";
import type { DesktopSecretStorage } from "./remote-auth-store.js";

export const OFFLINE_KEY_STORE_VERSION = 1;

export type OfflineDataKey = {
  algorithm: "AES-GCM";
  schemaVersion: 1;
  profileId: string;
  userId: string;
  keyBase64: string;
};

export class OfflineKeyStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OfflineKeyStoreError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new OfflineKeyStoreError("OFFLINE_KEY_INPUT_INVALID", `${label} 无效`);
  }
}

function keyPath(directory: string, profileId: string, userId: string): string {
  assertUuid(profileId, "profile id");
  assertUuid(userId, "user id");
  return join(directory, profileId, `${userId}.json`);
}

export class OfflineKeyStore {
  constructor(
    private readonly directory: string,
    private readonly secretStorage: DesktopSecretStorage
  ) {}

  getOrCreate(profile: RemoteWorkspaceProfile, userId: string): OfflineDataKey {
    this.assertAvailable();
    const path = keyPath(this.directory, profile.id, userId);
    if (existsSync(path)) return this.read(profile, userId, path);
    const rawKey = randomBytes(32);
    let encryptedKey: Buffer;
    try {
      encryptedKey = this.secretStorage.encryptString(rawKey.toString("base64"));
    } catch {
      throw new OfflineKeyStoreError("OFFLINE_KEY_ENCRYPT_FAILED", "系统安全存储未能保存离线数据密钥");
    }
    if (!Buffer.isBuffer(encryptedKey) || encryptedKey.byteLength === 0 || encryptedKey.byteLength > 6_144) {
      throw new OfflineKeyStoreError("OFFLINE_KEY_ENCRYPT_FAILED", "系统安全存储返回了无效离线密钥密文");
    }
    writeDesktopJsonAtomically(path, {
      version: OFFLINE_KEY_STORE_VERSION,
      profileId: profile.id,
      origin: profile.origin,
      userId,
      algorithm: "AES-GCM",
      encryptedKey: encryptedKey.toString("base64"),
      createdAt: new Date().toISOString()
    });
    return {
      algorithm: "AES-GCM",
      schemaVersion: 1,
      profileId: profile.id,
      userId,
      keyBase64: rawKey.toString("base64")
    };
  }

  has(profile: RemoteWorkspaceProfile, userId: string): boolean {
    const path = keyPath(this.directory, profile.id, userId);
    if (!existsSync(path)) return false;
    try {
      const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
      return isRecord(value) && value.state !== "cleared";
    } catch {
      return false;
    }
  }

  load(profile: RemoteWorkspaceProfile, userId: string): OfflineDataKey {
    this.assertAvailable();
    const path = keyPath(this.directory, profile.id, userId);
    if (!existsSync(path)) {
      throw new OfflineKeyStoreError("OFFLINE_KEY_NOT_FOUND", "当前用户尚未下载可离线使用的作品");
    }
    return this.read(profile, userId, path);
  }

  private read(profile: RemoteWorkspaceProfile, userId: string, path: string): OfflineDataKey {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw new OfflineKeyStoreError("OFFLINE_KEY_STORE_INVALID", "离线数据密钥文件无法读取");
    }
    if (!isRecord(value)) throw new OfflineKeyStoreError("OFFLINE_KEY_STORE_INVALID", "离线数据密钥格式无效");
    if (value.state === "cleared") {
      throw new OfflineKeyStoreError("OFFLINE_KEY_NOT_FOUND", "当前用户尚未下载可离线使用的作品");
    }
    const allowed = new Set(["version", "profileId", "origin", "userId", "algorithm", "encryptedKey", "createdAt"]);
    if (
      Object.keys(value).some((key) => !allowed.has(key))
      || value.version !== OFFLINE_KEY_STORE_VERSION
      || value.profileId !== profile.id
      || value.origin !== profile.origin
      || value.userId !== userId
      || value.algorithm !== "AES-GCM"
      || typeof value.encryptedKey !== "string"
      || value.encryptedKey.length === 0
      || value.encryptedKey.length > 8_192
      || !/^[A-Za-z0-9+/=]+$/u.test(value.encryptedKey)
      || typeof value.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.createdAt))
    ) throw new OfflineKeyStoreError("OFFLINE_KEY_STORE_INVALID", "离线数据密钥字段无效");
    let keyBase64: string;
    try {
      keyBase64 = this.secretStorage.decryptString(Buffer.from(value.encryptedKey, "base64"));
    } catch {
      throw new OfflineKeyStoreError("OFFLINE_KEY_DECRYPT_FAILED", "无法解锁离线数据，请先解锁系统密钥环");
    }
    let rawKey: Buffer;
    try {
      rawKey = Buffer.from(keyBase64, "base64");
    } catch {
      throw new OfflineKeyStoreError("OFFLINE_KEY_STORE_INVALID", "离线数据密钥无效");
    }
    if (rawKey.byteLength !== 32 || rawKey.toString("base64") !== keyBase64) {
      throw new OfflineKeyStoreError("OFFLINE_KEY_STORE_INVALID", "离线数据密钥无效");
    }
    return { algorithm: "AES-GCM", schemaVersion: 1, profileId: profile.id, userId, keyBase64 };
  }

  clearProfile(profileId: string): number {
    assertUuid(profileId, "profile id");
    const profileDirectory = join(this.directory, profileId);
    if (!existsSync(profileDirectory)) return 0;
    let cleared = 0;
    for (const entry of readdirSync(profileDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const userId = entry.name.slice(0, -5);
      assertUuid(userId, "user id");
      writeDesktopJsonAtomically(join(profileDirectory, entry.name), {
        version: OFFLINE_KEY_STORE_VERSION,
        state: "cleared",
        profileId,
        userId,
        updatedAt: new Date().toISOString()
      });
      cleared += 1;
    }
    return cleared;
  }

  private assertAvailable(): void {
    if (!this.secretStorage.isEncryptionAvailable() || !this.secretStorage.isSecureBackend()) {
      throw new OfflineKeyStoreError(
        "DESKTOP_SECRET_STORAGE_UNAVAILABLE",
        "系统安全存储不可用，已拒绝开启离线正文；Linux 请启用 Secret Service 或 KWallet"
      );
    }
  }
}
