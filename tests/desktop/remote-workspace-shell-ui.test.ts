import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const preloadSource = readFileSync(join(process.cwd(), "src/preload/workspace-preload.cts"), "utf8");
const uiSource = readFileSync(join(process.cwd(), "src/preload/remote-workspace-shell-ui.cts"), "utf8");

describe("Desktop 远端工作区壳界面", () => {
  it("在线工作区在左上角和页脚显示当前工作区名称", () => {
    expect(preloadSource).toContain('result.data?.connectionMode !== "online"');
    expect(uiSource).toContain('documentRef.querySelector<HTMLElement>("#home-button small")');
    expect(uiSource).toContain("当前工作区：${profileName}");
    expect(uiSource).toContain("data-desktop-workspace-name");
  });

  it("设置页使用与本地工作区相同的切换按钮", () => {
    expect(uiSource).toContain('"#settings-hub-view .settings-hub-header"');
    expect(uiSource).toContain('actions.className = "settings-detail-actions"');
    expect(uiSource).toContain('switchButton.id = "desktop-switch-button"');
    expect(uiSource).toContain('switchButton.className = "ghost-button settings-parent-button"');
    expect(uiSource).toContain('switchButton.textContent = "切换工作区"');
    expect(preloadSource).toContain('ipcRenderer.invoke("workspace:shell:request-switch")');
  });

  it("持续适配 Server 单页路由且不会重复绑定", () => {
    expect(preloadSource).toContain("new MutationObserver(() => queueMicrotask(render))");
    expect(uiSource).toContain('switchButton.dataset.desktopRemoteShellBound !== "true"');
    expect(preloadSource).toContain('window.addEventListener("beforeunload"');
  });
});
