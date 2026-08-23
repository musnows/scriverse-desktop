import { existsSync, readFileSync } from "node:fs";
import type { LocalAuthenticationResult } from "./local-server-manager.js";
import type { CredentialVault } from "./credential-vault.js";
import { parseRemoteAuthUser, type RemoteAuthUser } from "../shared/remote-auth-contract.js";
import { writeDesktopJsonAtomically } from "../shared/storage-manifest.js";

export const LOCAL_AUTH_STORE_VERSION = 1;

export type StoredLocalCredential = {
  token: string;
  expiresAt: string;
  user: RemoteAuthUser;
};

export class LocalAuthStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalAuthStoreError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new LocalAuthStoreError("LOCAL_AUTH_STORE_INVALID", "本地登录存储包含未知字段");
  }
}

export class LocalAuthStore {
  constructor(
    private readonly path: string,
    private readonly credentialVault: CredentialVault
  ) {}

  load(): StoredLocalCredential | null {
    if (!existsSync(this.path)) return null;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    } catch {
      throw new LocalAuthStoreError("LOCAL_AUTH_STORE_INVALID", "本地登录存储无法读取");
    }
    if (!isRecord(value)) throw new LocalAuthStoreError("LOCAL_AUTH_STORE_INVALID", "本地登录存储格式无效");
    if (value.state === "signed-out") {
      assertExactKeys(value, ["version", "state", "updatedAt"]);
      if (value.version !== LOCAL_AUTH_STORE_VERSION || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))) {
        throw new LocalAuthStoreError("LOCAL_AUTH_STORE_INVALID", "本地登出状态无效");
      }
      return null;
    }
    assertExactKeys(value, ["version", "state", "tokenEncrypted", "tokenIv", "tokenTag", "expiresAt", "user", "updatedAt"]);
    if (
      value.version !== LOCAL_AUTH_STORE_VERSION
      || value.state !== "authenticated"
      || typeof value.tokenEncrypted !== "string" || value.tokenEncrypted.length > 8_192
      || typeof value.tokenIv !== "string" || value.tokenIv.length > 256
      || typeof value.tokenTag !== "string" || value.tokenTag.length > 256
      || ![value.tokenEncrypted, value.tokenIv, value.tokenTag].every((part) => /^[A-Za-z0-9+/=]+$/u.test(part))
      || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
      || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    ) throw new LocalAuthStoreError("LOCAL_AUTH_STORE_INVALID", "本地登录存储字段无效");
    let token: string;
    try {
      token = this.credentialVault.decrypt({ encrypted: value.tokenEncrypted, iv: value.tokenIv, tag: value.tokenTag });
    } catch {
      throw new LocalAuthStoreError("LOCAL_AUTH_DECRYPT_FAILED", "无法解锁已保存的本地登录，请重新登录");
    }
    if (!/^scrvd_[A-Za-z0-9_-]{43}$/u.test(token)) {
      throw new LocalAuthStoreError("LOCAL_AUTH_STORE_INVALID", "本地登录令牌格式无效");
    }
    return { token, expiresAt: value.expiresAt, user: parseRemoteAuthUser(value.user) };
  }

  save(result: LocalAuthenticationResult): void {
    const encrypted = this.credentialVault.encrypt(result.token);
    writeDesktopJsonAtomically(this.path, {
      version: LOCAL_AUTH_STORE_VERSION,
      state: "authenticated",
      tokenEncrypted: encrypted.encrypted,
      tokenIv: encrypted.iv,
      tokenTag: encrypted.tag,
      expiresAt: result.expiresAt,
      user: result.user,
      updatedAt: new Date().toISOString()
    });
  }

  clear(): void {
    writeDesktopJsonAtomically(this.path, {
      version: LOCAL_AUTH_STORE_VERSION,
      state: "signed-out",
      updatedAt: new Date().toISOString()
    });
  }
}
