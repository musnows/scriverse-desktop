import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RemoteWorkspaceProfile } from "../shared/contracts.js";
import {
  REMOTE_AUTH_TOKEN_PREFIX,
  parseRemoteAuthUser,
  type RemoteAuthUser,
  type RemoteLoginResult
} from "../shared/remote-auth-contract.js";
import { writeDesktopJsonAtomically } from "../shared/storage-manifest.js";
import type { CredentialVault } from "./credential-vault.js";

export const REMOTE_AUTH_STORE_VERSION = 1;

export type StoredRemoteCredential = {
  token: string;
  expiresAt: string;
  user: RemoteAuthUser;
};

export class RemoteAuthStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteAuthStoreError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RemoteAuthStoreError("REMOTE_AUTH_STORE_INVALID", "远端登录存储包含未知字段");
  }
}

function profilePath(directory: string, profileId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(profileId)) {
    throw new RemoteAuthStoreError("REMOTE_AUTH_STORE_INVALID", "远端登录 profile id 无效");
  }
  return join(directory, `${profileId}.json`);
}

export class RemoteAuthStore {
  constructor(
    private readonly directory: string,
    private readonly credentialVault: CredentialVault
  ) {}

  load(profile: RemoteWorkspaceProfile): StoredRemoteCredential | null {
    const path = profilePath(this.directory, profile.id);
    if (!existsSync(path)) return null;
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch {
      throw new RemoteAuthStoreError("REMOTE_AUTH_STORE_INVALID", "远端登录存储无法读取");
    }
    if (!isRecord(document)) throw new RemoteAuthStoreError("REMOTE_AUTH_STORE_INVALID", "远端登录存储格式无效");
    if (document.state === "signed-out") {
      assertExactKeys(document, ["version", "state", "profileId", "origin", "updatedAt"]);
      if (
        document.version !== REMOTE_AUTH_STORE_VERSION
        || document.profileId !== profile.id
        || document.origin !== profile.origin
        || typeof document.updatedAt !== "string"
        || !Number.isFinite(Date.parse(document.updatedAt))
      ) throw new RemoteAuthStoreError("REMOTE_AUTH_STORE_INVALID", "远端登出状态无效");
      return null;
    }
    assertExactKeys(document, ["version", "state", "profileId", "origin", "tokenEncrypted", "tokenIv", "tokenTag", "expiresAt", "user", "updatedAt"]);
    if (
      document.version !== REMOTE_AUTH_STORE_VERSION
      || document.state !== "authenticated"
      || document.profileId !== profile.id
      || document.origin !== profile.origin
      || typeof document.tokenEncrypted !== "string" || document.tokenEncrypted.length > 8_192
      || typeof document.tokenIv !== "string" || document.tokenIv.length > 256
      || typeof document.tokenTag !== "string" || document.tokenTag.length > 256
      || ![document.tokenEncrypted, document.tokenIv, document.tokenTag].every((part) => /^[A-Za-z0-9+/=]+$/u.test(part))
      || typeof document.expiresAt !== "string"
      || !Number.isFinite(Date.parse(document.expiresAt))
      || typeof document.updatedAt !== "string"
      || !Number.isFinite(Date.parse(document.updatedAt))
    ) throw new RemoteAuthStoreError("REMOTE_AUTH_STORE_INVALID", "远端登录存储字段无效");
    let token: string;
    try {
      token = this.credentialVault.decrypt({
        encrypted: document.tokenEncrypted,
        iv: document.tokenIv,
        tag: document.tokenTag
      });
    } catch {
      throw new RemoteAuthStoreError("REMOTE_AUTH_DECRYPT_FAILED", "无法解锁已保存的远端登录，请重新登录");
    }
    if (!new RegExp(`^${REMOTE_AUTH_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`, "u").test(token)) {
      throw new RemoteAuthStoreError("REMOTE_AUTH_STORE_INVALID", "远端登录令牌格式无效");
    }
    return { token, expiresAt: document.expiresAt, user: parseRemoteAuthUser(document.user) };
  }

  save(profile: RemoteWorkspaceProfile, result: RemoteLoginResult): void {
    let encrypted;
    try {
      encrypted = this.credentialVault.encrypt(result.token);
    } catch {
      throw new RemoteAuthStoreError("REMOTE_AUTH_ENCRYPT_FAILED", "本地 master.key 未能保存远端登录");
    }
    writeDesktopJsonAtomically(profilePath(this.directory, profile.id), {
      version: REMOTE_AUTH_STORE_VERSION,
      state: "authenticated",
      profileId: profile.id,
      origin: profile.origin,
      tokenEncrypted: encrypted.encrypted,
      tokenIv: encrypted.iv,
      tokenTag: encrypted.tag,
      expiresAt: result.expiresAt,
      user: result.user,
      updatedAt: new Date().toISOString()
    });
  }

  clear(profile: RemoteWorkspaceProfile): void {
    writeDesktopJsonAtomically(profilePath(this.directory, profile.id), {
      version: REMOTE_AUTH_STORE_VERSION,
      state: "signed-out",
      profileId: profile.id,
      origin: profile.origin,
      updatedAt: new Date().toISOString()
    });
  }
}
