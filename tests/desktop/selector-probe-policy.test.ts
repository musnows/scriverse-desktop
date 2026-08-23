import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/main/selector-ipc.ts"), "utf8");

describe("Desktop Selector Server 探测策略", () => {
  it("保存新 Server 前先探测 product 和协议能力", () => {
    const createHandler = source.slice(
      source.indexOf('handle("selector:profiles:create"'),
      source.indexOf('handle("selector:profiles:update"')
    );
    expect(createHandler.indexOf("options.probeRemote")).toBeGreaterThanOrEqual(0);
    expect(createHandler.indexOf("options.probeRemote")).toBeLessThan(createHandler.indexOf("profileStore.createRemote"));
  });

  it("每次打开前重新协商且旧 Server 不回退到 Cookie 登录", () => {
    expect(source).toContain("assertRemoteCanOpen(capabilities)");
    expect(source).toContain("REMOTE_SERVER_DESKTOP_AUTH_REQUIRED");
    expect(source).toContain("该 Server 版本过旧，请升级后再使用 Desktop");
    expect(source).toContain("isRemoteConnectivityError(error)");
    expect(source).toContain("profile.capabilities");
  });
});
