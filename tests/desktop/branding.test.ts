import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DESKTOP_DISPLAY_NAME } from "../../src/shared/branding.js";

const root = process.cwd();
const userFacingSources = [
  "src/main/background-tray.ts",
  "src/main/desktop-updater.ts",
  "src/main/native-menu.ts",
  "src/main/remote-workspace-window.ts",
  "src/main/selector-window.ts",
  "src/main/workspace-window.ts",
  "src/renderer/local-ai/index.html",
  "src/renderer/selector/index.html"
].map((path) => readFileSync(join(root, path), "utf8")).join("\n");

describe("叙界桌面端品牌显示", () => {
  it("在窗口、菜单、托盘和前端只显示叙界名称", () => {
    expect(DESKTOP_DISPLAY_NAME).toBe("叙界");
    expect(userFacingSources).toContain("DESKTOP_DISPLAY_NAME");
    expect(userFacingSources).toContain("选择工作区 - 叙界");
    expect(userFacingSources).not.toContain("Scriverse Desktop");
  });

  it("保留英文可执行文件、打包目录和数据目录契约", () => {
    const forge = readFileSync(join(root, "forge.config.ts"), "utf8");
    const paths = readFileSync(join(root, "src/main/app-paths.ts"), "utf8");
    const verifier = readFileSync(join(root, "scripts/verify-package.mjs"), "utf8");
    const localizedInfo = readFileSync(join(root, "assets/zh-Hans.lproj/InfoPlist.strings"), "utf8");
    expect(forge).toContain('const internalApplicationName = "Scriverse Desktop"');
    expect(forge).toContain('name: packagedApplicationName');
    expect(forge).toContain('executableName: internalApplicationName');
    expect(paths).toContain('"Application Support", "Scriverse Desktop", "data"');
    expect(verifier).toContain('"叙界.app"');
    expect(localizedInfo).toContain('"CFBundleDisplayName" = "叙界";');
  });
});
