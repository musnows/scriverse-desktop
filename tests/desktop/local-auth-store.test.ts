import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CredentialVault } from "../../src/main/credential-vault.js";
import { LocalAuthStore } from "../../src/main/local-auth-store.js";

const user = {
  userId: "44444444-4444-4444-8444-444444444444",
  username: "local-author",
  displayName: "本地作者",
  role: "admin" as const,
  status: "active" as const,
  createdAt: "2026-08-23T00:00:00.000Z",
  avatarUrl: null,
  onboardingCompleted: true,
  isSystemAdmin: true
};

function storePath(): string {
  return join(tmpdir(), `scriverse-local-auth-${process.pid}-${crypto.randomUUID()}`, "local-auth.json");
}

function vault(): CredentialVault {
  return new CredentialVault("local-auth-test-master-secret-1234567890");
}

describe("Desktop 本地登录存储", () => {
  it("使用 master.key 同款格式保存 Desktop Bearer 并可重启读取", () => {
    const path = storePath();
    const token = `scrvd_${"a".repeat(43)}`;
    const store = new LocalAuthStore(path, vault());
    store.save({ token, expiresAt: "2026-09-23T00:00:00.000Z", user, url: "http://127.0.0.1:23241" });
    const source = readFileSync(path, "utf8");
    expect(source).not.toContain(token);
    expect(source).toContain("tokenEncrypted");
    expect(new LocalAuthStore(path, vault()).load()).toEqual({
      token,
      expiresAt: "2026-09-23T00:00:00.000Z",
      user
    });
  });

  it("登出后不保留令牌", () => {
    const path = storePath();
    const store = new LocalAuthStore(path, vault());
    store.save({ token: `scrvd_${"b".repeat(43)}`, expiresAt: "2026-09-23T00:00:00.000Z", user, url: "http://127.0.0.1:23241" });
    store.clear();
    expect(store.load()).toBeNull();
    expect(readFileSync(path, "utf8")).not.toContain("tokenEncrypted");
  });
});
