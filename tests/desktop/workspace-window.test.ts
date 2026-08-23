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

  it("只由 Main 持久化 Bearer 并禁止浏览器 Cookie 与系统凭据存储", () => {
    expect(mainSource).toContain("localSessionPolicy!.authorize(result.url, result.token)");
    expect(mainSource).toContain("localAuthStore!.save(result)");
    expect(mainSource).not.toContain("cookies.set");
    expect(mainSource).not.toContain("safeStorage");
    expect(mainSource).not.toContain("KEYCHAIN_INTERACTION_REQUIRED");
  });

  it("打开与切换工作区时继承当前窗口位置且先显示替代窗口", () => {
    expect(workspaceSource).toContain("...(options.placement?.bounds ?? {})");
    expect(workspaceSource.indexOf("window.show();")).toBeLessThan(workspaceSource.indexOf("options.onReady();"));
    expect(mainSource).toContain("placement: captureWindowPlacement(mainWindow)");
    expect(mainSource).toContain("applyWindowPlacement(selector, captureWindowPlacement(window))");
    expect(mainSource).toContain("showSelectorFromWorkspace(window);\n    window.destroy();");
    expect(mainSource).toContain("showSelectorFromWorkspace(window);\n  window.close();");
  });

  it("退出时不在窗口销毁后重新读取 webContents", () => {
    expect(mainSource).toContain("const contents = window.webContents;");
    expect(mainSource).toContain('contents.off("will-prevent-unload", handlePreventedUnload)');
    expect(mainSource).not.toContain('window.webContents.off("will-prevent-unload", handlePreventedUnload)');
  });

  it("切换回 Selector 时保持本地 Server 与登录会话运行", () => {
    const localClosedHandler = mainSource.slice(
      mainSource.indexOf("function openLocalWorkspace"),
      mainSource.indexOf("function openRemoteWorkspace")
    );
    expect(localClosedHandler).not.toContain("localServerManager?.stop()");
    expect(mainSource).toContain("await localServerManager?.stop();");
  });
});
