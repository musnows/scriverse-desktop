import { mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RemoteAuthStore,
  RemoteAuthStoreError,
  type DesktopSecretStorage
} from "../../src/main/remote-auth-store.js";
import { remotePartition, type RemoteWorkspaceProfile } from "../../src/shared/contracts.js";

function testProfile(): RemoteWorkspaceProfile {
  const id = crypto.randomUUID();
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

function testDirectory(): string {
  const directory = join(tmpdir(), `scriverse-remote-auth-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function secretStorage(secure = true): DesktopSecretStorage {
  return {
    isEncryptionAvailable: () => true,
    isSecureBackend: () => secure,
    encryptString: (value) => Buffer.from([...value].reverse().join(""), "utf8"),
    decryptString: (value) => [...value.toString("utf8")].reverse().join("")
  };
}

const user = {
  userId: "44444444-4444-4444-8444-444444444444",
  username: "author",
  displayName: "作者",
  role: "admin" as const,
  status: "active" as const,
  createdAt: "2026-08-23T00:00:00.000Z",
  avatarUrl: null,
  onboardingCompleted: true,
  isSystemAdmin: true
};

describe("Desktop 远端登录安全存储", () => {
  it("只把系统加密密文写入 profile 独立文件并可重启解锁", () => {
    const directory = testDirectory();
    const profile = testProfile();
    const token = `scrvd_${"a".repeat(43)}`;
    const store = new RemoteAuthStore(directory, secretStorage());
    store.save(profile, { token, expiresAt: "2026-09-23T00:00:00.000Z", user });
    const path = join(directory, `${profile.id}.json`);
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain(token);
    expect(source).not.toContain("password");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(new RemoteAuthStore(directory, secretStorage()).load(profile)).toEqual({
      token,
      expiresAt: "2026-09-23T00:00:00.000Z",
      user
    });
  });

  it("登出以无密钥状态原子覆盖存储", () => {
    const directory = testDirectory();
    const profile = testProfile();
    const store = new RemoteAuthStore(directory, secretStorage());
    store.save(profile, { token: `scrvd_${"b".repeat(43)}`, expiresAt: "2026-09-23T00:00:00.000Z", user });
    store.clear(profile);
    expect(store.load(profile)).toBeNull();
    expect(JSON.parse(readFileSync(join(directory, `${profile.id}.json`), "utf8"))).toMatchObject({ state: "signed-out" });
  });

  it("拒绝 Linux 明文 fallback 或不可用的系统安全存储", () => {
    const profile = testProfile();
    const store = new RemoteAuthStore(testDirectory(), secretStorage(false));
    expect(() => store.save(profile, {
      token: `scrvd_${"c".repeat(43)}`,
      expiresAt: "2026-09-23T00:00:00.000Z",
      user
    })).toThrowError(RemoteAuthStoreError);
  });
});
