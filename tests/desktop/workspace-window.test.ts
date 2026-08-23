import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const workspaceSource = readFileSync(join(root, "src/main/workspace-window.ts"), "utf8");
const mainSource = readFileSync(join(root, "src/main/main.ts"), "utf8");

describe("Desktop 本地工作区窗口", () => {
  it("固定使用本地 partition 与 sandbox 安全边界", () => {
    expect(workspaceSource).toContain("partition: LOCAL_PROFILE_PARTITION");
    expect(workspaceSource).toContain("nodeIntegration: false");
    expect(workspaceSource).toContain("contextIsolation: true");
    expect(workspaceSource).toContain("sandbox: true");
    expect(workspaceSource).toContain("webSecurity: true");
    expect(workspaceSource).toContain('preload: join(options.desktopRoot, "preload", "local-workspace-preload.cjs")');
    expect(workspaceSource).toContain('title: "本地工作区 - Scriverse Desktop"');
    expect(workspaceSource).toContain("setPermissionRequestHandler");
    expect(workspaceSource).toContain('action: "deny"');
  });

  it("只由 Main 写入 HttpOnly session cookie，Selector 不接收 token", () => {
    expect(mainSource).toContain("httpOnly: true");
    expect(mainSource).toContain("LOCAL_SESSION_COOKIE_NAME");
    expect(mainSource).toContain('error.code = "KEYCHAIN_INTERACTION_REQUIRED"');
    expect(mainSource).not.toContain("sessionToken: result.sessionToken");
  });

  it("打开与切换工作区时继承当前窗口位置且先显示替代窗口", () => {
    expect(workspaceSource).toContain("...(options.placement?.bounds ?? {})");
    expect(workspaceSource.indexOf("window.show();")).toBeLessThan(workspaceSource.indexOf("options.onReady();"));
    expect(mainSource).toContain("placement: captureWindowPlacement(mainWindow)");
    expect(mainSource).toContain("applyWindowPlacement(selector, captureWindowPlacement(window))");
    expect(mainSource).toContain("showSelectorFromWorkspace(window);\n    window.destroy();");
    expect(mainSource).toContain("showSelectorFromWorkspace(window);\n  window.close();");
  });
});
