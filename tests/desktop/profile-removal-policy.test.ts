import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const selectorIpc = readFileSync(join(root, "src/main/selector-ipc.ts"), "utf8");
const sessionPolicy = readFileSync(join(root, "src/main/remote-session-policy.ts"), "utf8");
const main = readFileSync(join(root, "src/main/main.ts"), "utf8");

describe("Desktop Server 删除与 origin 更换保护", () => {
  it("先检查全部账户离线状态和完成本机清理，再修改 profile 清单", () => {
    const removeStart = selectorIpc.indexOf('handle("selector:profiles:remove"');
    const removeEnd = selectorIpc.indexOf('handle("selector:profiles:open"', removeStart);
    const removeSource = selectorIpc.slice(removeStart, removeEnd);
    expect(removeSource.indexOf("assertRemoteProfileDataDisposition")).toBeGreaterThan(-1);
    expect(removeSource.indexOf("options.forgetRemote(profile)")).toBeGreaterThan(removeSource.indexOf("assertRemoteProfileDataDisposition"));
    expect(removeSource.indexOf("profileStore.removeRemote")).toBeGreaterThan(removeSource.indexOf("options.forgetRemote(profile)"));

    const updateStart = selectorIpc.indexOf('handle("selector:profiles:update"');
    const updateEnd = selectorIpc.indexOf('handle("selector:profiles:remove"', updateStart);
    const updateSource = selectorIpc.slice(updateStart, updateEnd);
    expect(updateSource).toContain("nextOrigin !== existing.origin");
    expect(updateSource).toContain("assertRemoteProfileDataDisposition");
    expect(updateSource.indexOf("options.forgetRemote(existing)")).toBeLessThan(updateSource.indexOf("profileStore.updateRemote"));
  });

  it("清空 partition 的 Cookie、IndexedDB、Storage、Service Worker 和 HTTP cache，并覆盖离线密钥", () => {
    expect(sessionPolicy).toContain("electronSession.flushStorageData()");
    expect(sessionPolicy).toContain("electronSession.clearStorageData()");
    expect(sessionPolicy).toContain("electronSession.clearCache()");
    expect(sessionPolicy).toContain("electronSession.clearAuthCache()");
    expect(sessionPolicy).toContain("this.policies.delete(profile.id)");
    expect(main).toContain("offlineKeyStore!.clearProfile(profile.id)");
    expect(main).toContain("remoteSyncStatusStore!.clear(profile)");
  });
});
