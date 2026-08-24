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

  it("导航只能停留在精确工作区 origin", () => {
    expect(isAllowedRemoteWorkspaceNavigation("https://server.example/app?work=1", "https://server.example")).toBe(true);
    expect(isAllowedRemoteWorkspaceNavigation("app://workspace-profile/#view=shelf", "app://workspace-profile/")).toBe(true);
    expect(isAllowedRemoteWorkspaceNavigation("https://evil.example/", "https://server.example")).toBe(false);
    expect(isAllowedRemoteWorkspaceNavigation("app://workspace-other/", "app://workspace-profile/")).toBe(false);
    expect(isAllowedRemoteWorkspaceNavigation("file:///etc/passwd", "https://server.example")).toBe(false);
    expect(isAllowedRemoteWorkspaceNavigation("https://user:pass@server.example/", "https://server.example")).toBe(false);
  });

  it("在线与离线都加载随包 Web，并只通过同源 API 转发访问 Server", () => {
    expect(windowSource).toContain("registerBundledWorkspaceShell");
    expect(windowSource).toContain("remoteWorkspaceShellUrl(options.profile.id)");
    expect(windowSource).toContain("await window.loadURL(shellUrl)");
    expect(windowSource).not.toContain("loadURL(options.profile.origin)");
    expect(windowSource).not.toContain("executeJavaScript");
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
    expect(windowSource).toContain("await window.loadURL(shellUrl)");
    expect(windowSource).toContain("...(options.placement?.bounds ?? {})");
    expect(windowSource.indexOf("window.show();")).toBeLessThan(windowSource.indexOf("options.onReady();"));
  });
});
