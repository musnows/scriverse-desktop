import { mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OfflineKeyStore,
  OfflineKeyStoreError
} from "../../src/main/offline-key-store.js";
import type { DesktopSecretStorage } from "../../src/main/remote-auth-store.js";
import { remotePartition, type RemoteWorkspaceProfile } from "../../src/shared/contracts.js";

function testDirectory(): string {
  const directory = join(tmpdir(), `scriverse-offline-key-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function profile(id = crypto.randomUUID()): RemoteWorkspaceProfile {
  return {
    id,
    name: "Remote",
    kind: "remote",
    origin: "https://server.example",
    partition: remotePartition(id),
    createdAt: "2026-08-23T00:00:00.000Z",
    lastUsedAt: null,
    capabilities: null
  };
}

function secretStorage(secure = true): DesktopSecretStorage {
  return {
    isEncryptionAvailable: () => true,
    isSecureBackend: () => secure,
    encryptString: (value) => Buffer.from([...value].reverse().join(""), "utf8"),
    decryptString: (value) => [...value.toString("utf8")].reverse().join("")
  };
}

describe("Desktop 离线数据密钥存储", () => {
  it("为 profile 与用户生成独立 AES-256 密钥且只持久化系统密文", () => {
    const directory = testDirectory();
    const firstProfile = profile("11111111-1111-4111-8111-111111111111");
    const secondProfile = profile("22222222-2222-4222-8222-222222222222");
    const firstUser = "33333333-3333-4333-8333-333333333333";
    const secondUser = "44444444-4444-4444-8444-444444444444";
    const store = new OfflineKeyStore(directory, secretStorage());
    expect(store.has(firstProfile, firstUser)).toBe(false);
    expect(() => store.load(firstProfile, firstUser)).toThrowError(
      expect.objectContaining({ code: "OFFLINE_KEY_NOT_FOUND" })
    );
    const first = store.getOrCreate(firstProfile, firstUser);
    expect(store.has(firstProfile, firstUser)).toBe(true);
    expect(store.load(firstProfile, firstUser)).toEqual(first);
    expect(Buffer.from(first.keyBase64, "base64")).toHaveLength(32);
    expect(store.getOrCreate(firstProfile, firstUser)).toEqual(first);
    expect(store.getOrCreate(firstProfile, secondUser).keyBase64).not.toBe(first.keyBase64);
    expect(store.getOrCreate(secondProfile, firstUser).keyBase64).not.toBe(first.keyBase64);

    const path = join(directory, firstProfile.id, `${firstUser}.json`);
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain(first.keyBase64);
    expect(source).not.toContain("content");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("拒绝 Linux 明文 fallback 和非 UUID 隔离键", () => {
    const secureStore = new OfflineKeyStore(testDirectory(), secretStorage());
    expect(() => secureStore.getOrCreate(profile(), "../../other-user")).toThrowError(OfflineKeyStoreError);
    const unavailable = new OfflineKeyStore(testDirectory(), secretStorage(false));
    expect(() => unavailable.getOrCreate(profile(), crypto.randomUUID())).toThrowError(
      expect.objectContaining({ code: "DESKTOP_SECRET_STORAGE_UNAVAILABLE" })
    );
  });

  it("删除 profile 时覆盖全部账户密钥且不再允许离线打开", () => {
    const directory = testDirectory();
    const target = profile();
    const firstUser = crypto.randomUUID();
    const secondUser = crypto.randomUUID();
    const store = new OfflineKeyStore(directory, secretStorage());
    const first = store.getOrCreate(target, firstUser);
    store.getOrCreate(target, secondUser);
    expect(store.clearProfile(target.id)).toBe(2);
    expect(store.has(target, firstUser)).toBe(false);
    expect(store.has(target, secondUser)).toBe(false);
    expect(() => store.load(target, firstUser)).toThrowError(expect.objectContaining({ code: "OFFLINE_KEY_NOT_FOUND" }));
    const source = readFileSync(join(directory, target.id, `${firstUser}.json`), "utf8");
    expect(source).toContain('"state": "cleared"');
    expect(source).not.toContain(first.keyBase64);
    expect(source).not.toContain("encryptedKey");
  });
});
