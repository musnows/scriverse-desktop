import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Desktop 凭据与离线存储策略", () => {
  it("禁止操作系统凭据存储和浏览器 Cookie 登录", () => {
    const main = readFileSync(join(root, "src/main/main.ts"), "utf8");
    const forge = readFileSync(join(root, "forge.config.ts"), "utf8");
    const localPolicy = readFileSync(join(root, "src/main/local-session-policy.ts"), "utf8");
    const sessionHeaders = readFileSync(join(root, "src/shared/remote-session-headers.ts"), "utf8");
    expect(main).not.toContain("safeStorage");
    expect(main).not.toContain("cookies.set");
    expect(forge).toContain("[FuseV1Options.EnableCookieEncryption]: false");
    expect(localPolicy).toContain("remoteRequestHeaders");
    expect(localPolicy).toContain("remoteResponseHeaders");
    expect(sessionHeaders).toContain("sanitized.Authorization = `Bearer ${token}`");
  });

  it("仅使用 Server 同款 CredentialVault 加密登录令牌与 AI API Key", () => {
    const vault = readFileSync(join(root, "src/main/credential-vault.ts"), "utf8");
    const remoteAuth = readFileSync(join(root, "src/main/remote-auth-store.ts"), "utf8");
    const localAuth = readFileSync(join(root, "src/main/local-auth-store.ts"), "utf8");
    const localAi = readFileSync(join(root, "src/main/local-ai-provider-store.ts"), "utf8");
    expect(vault).toContain('createCipheriv("aes-256-gcm"');
    expect(vault).toContain('createHash("sha256")');
    expect(vault).toContain('writeFileSync(path, secret, { encoding: "utf8", mode: 0o600 })');
    expect(remoteAuth).toContain("tokenEncrypted");
    expect(localAuth).toContain("tokenEncrypted");
    expect(localAi).toContain("apiKeyCiphertext");
  });

  it("离线正文与冲突快照保持原始对象且不生成离线密钥", () => {
    const syncStore = readFileSync(join(root, "runtime-overlay/public/desktop-sync-store.js"), "utf8");
    const workspacePreload = readFileSync(join(root, "src/preload/workspace-preload.cts"), "utf8");
    expect(syncStore).toContain("return structuredClone(snapshot)");
    expect(syncStore).not.toContain("AES-GCM");
    expect(syncStore).not.toContain("subtle.encrypt");
    expect(syncStore).not.toContain("subtle.decrypt");
    expect(workspacePreload).not.toContain("getOfflineKey");
  });
});
