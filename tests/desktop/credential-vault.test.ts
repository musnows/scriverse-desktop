import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CredentialVault,
  loadMasterSecret
} from "../../src/main/credential-vault.js";

function keyPath(): string {
  return join(tmpdir(), `scriverse-desktop-master-key-${process.pid}-${crypto.randomUUID()}`, "master.key");
}

describe("Desktop CredentialVault", () => {
  it("使用同目录 master.key 伪加密敏感字符串且不依赖系统凭据存储", () => {
    const path = keyPath();
    const first = new CredentialVault(loadMasterSecret(path));
    const encrypted = first.encrypt("scrvd_private_token");
    expect(JSON.stringify(encrypted)).not.toContain("scrvd_private_token");
    expect(readFileSync(path, "utf8").trim()).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(first.decrypt(encrypted)).toBe("scrvd_private_token");
    expect(new CredentialVault(loadMasterSecret(path)).decrypt(encrypted)).toBe("scrvd_private_token");
  });

  it("拒绝损坏的主密钥和被篡改的密文", () => {
    const invalidPath = keyPath();
    loadMasterSecret(invalidPath);
    writeFileSync(invalidPath, "short", { mode: 0o600 });
    expect(() => new CredentialVault(loadMasterSecret(invalidPath))).toThrowError(/主密钥/u);

    const path = keyPath();
    const store = new CredentialVault(loadMasterSecret(path));
    const encrypted = store.encrypt("local-ai-api-key");
    encrypted.tag = Buffer.alloc(16, 1).toString("base64");
    expect(() => store.decrypt(encrypted)).toThrow();
  });
});
