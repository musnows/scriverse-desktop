import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCompatibleServerVersion, resolveDesktopAppVersion } from "../../src/main/app-version.js";

describe("Desktop 应用版本", () => {
  it("打包后使用 Electron 应用包版本", () => {
    expect(resolveDesktopAppVersion({
      packaged: true,
      packagedVersion: "0.1.0",
      applicationRoot: "/not-used"
    })).toBe("0.1.0");
  });

  it("开发模式读取项目 package.json 而不是 Electron 运行时版本", () => {
    const root = join(tmpdir(), `scriverse-desktop-version-${process.pid}-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
    expect(resolveDesktopAppVersion({
      packaged: false,
      packagedVersion: "43.4.1",
      applicationRoot: root
    })).toBe("1.2.3");
  });

  it("单独读取对应 Server 版本", () => {
    const root = join(tmpdir(), `scriverse-desktop-server-version-${process.pid}-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ scriverseServerVersion: "0.8.7" }));
    expect(resolveCompatibleServerVersion(root)).toBe("0.8.7");
  });

  it("当前 Desktop 声明对应 Server 0.9.2", () => {
    expect(resolveCompatibleServerVersion(process.cwd())).toBe("0.9.2");
  });
});
