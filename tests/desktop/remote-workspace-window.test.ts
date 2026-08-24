import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowedRemoteWorkspaceNavigation } from "../../src/shared/remote-workspace-url.js";

const root = process.cwd();
const windowSource = readFileSync(join(root, "src/main/remote-workspace-window.ts"), "utf8");
const sessionSource = readFileSync(join(root, "src/main/remote-session-policy.ts"), "utf8");

describe("Desktop 远端工作区窗口", () => {
  it("每个 profile 固定独立 partition 并关闭 Node、webview 与权限", () => {
    expect(windowSource).toContain("partition: options.profile.partition");
    expect(windowSource).toContain('"workspace-preload.cjs"');
    expect(windowSource).toContain("nodeIntegration: false");
    expect(windowSource).toContain("contextIsolation: true");
    expect(windowSource).toContain("sandbox: true");
    expect(windowSource).toContain("webviewTag: false");
    expect(windowSource).toContain("will-attach-webview");
    expect(sessionSource).toContain("setPermissionCheckHandler");
    expect(sessionSource).toContain("setPermissionRequestHandler");
  });

  it("导航只能停留在 profile 精确 origin", () => {
    expect(isAllowedRemoteWorkspaceNavigation("https://server.example/app?work=1", "https://server.example")).toBe(true);
    expect(isAllowedRemoteWorkspaceNavigation("https://evil.example/", "https://server.example")).toBe(false);
    expect(isAllowedRemoteWorkspaceNavigation("file:///etc/passwd", "https://server.example")).toBe(false);
    expect(isAllowedRemoteWorkspaceNavigation("https://user:pass@server.example/", "https://server.example")).toBe(false);
  });

  it("在线与离线启动都加载当前随包 Web 资源", () => {
    expect(windowSource).toContain("registerBundledOfflineShell");
    expect(windowSource).not.toContain('if (options.connectionMode === "offline")');
    expect(windowSource).not.toContain("serviceWorkers.startWorkerForScope");
    expect(windowSource).not.toContain("clearStorageData");
  });

  it("远端认证只注入 Bearer 并剥离双向 Cookie", () => {
    expect(sessionSource).toContain("remoteRequestHeaders");
    expect(sessionSource).toContain("remoteResponseHeaders");
    expect(sessionSource).not.toContain("cookies.set");
  });

  it("在 Selector 所在显示器创建并显示工作区窗口", () => {
    expect(windowSource).toContain('title: `${options.profile.name} - ${DESKTOP_DISPLAY_NAME}`');
    expect(windowSource).toContain("executeJavaScript(remoteWorkspaceShellScript(options.profile.name))");
    expect(windowSource).toContain("...(options.placement?.bounds ?? {})");
    expect(windowSource.indexOf("window.show();")).toBeLessThan(windowSource.indexOf("options.onReady();"));
  });
});
