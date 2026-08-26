import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Desktop 退出二次确认", () => {
  it("让菜单栏、状态栏与 Cmd+Q 统一发起退出确认", () => {
    const menu = source("src/main/native-menu.ts");
    const tray = source("src/main/background-tray.ts");
    const main = source("src/main/main.ts");

    expect(menu).toContain('accelerator: "CmdOrCtrl+Q", click: actions.requestQuit');
    expect(menu).not.toContain('role: "quit", label: `退出${DESKTOP_DISPLAY_NAME}`');
    expect(tray).toContain("requestQuit: () => void;");
    expect(tray).toContain("this.actions.requestQuit()");
    expect(main).toContain("function requestDesktopQuitConfirmation()");
    expect(main).toContain('"workspace:shell:menu-command", "request-quit"');
    expect(main).toContain('"selector:app:request-quit"');
    expect(main).toContain("if (!desktopQuitConfirmed)");
  });

  it("只允许确认 Toast 通过具名 IPC 执行最终退出", () => {
    const selector = source("src/renderer/selector/selector.js");
    const selectorPreload = source("src/preload/selector-preload.cts");
    const selectorIpc = source("src/main/selector-ipc.ts");
    const workspacePreload = source("src/preload/workspace-preload.cts");
    const localWorkspacePreload = source("src/preload/local-workspace-preload.cts");
    const workspaceIpc = source("src/main/workspace-ipc.ts");
    const localWorkspaceIpc = source("src/main/local-workspace-ipc.ts");
    const overlay = source("runtime-overlay/web.patch");

    expect(selector).toContain("function showQuitConfirmation()");
    expect(selector).toContain("bridge.app.requestQuit()");
    expect(selector).toContain("bridge.app.confirmQuit()");
    expect(selector).toContain("bridge.app.onQuitRequested(showQuitConfirmation)");
    expect(selectorPreload).toContain('invoke("selector:app:request-quit")');
    expect(selectorPreload).toContain('invoke("selector:app:confirm-quit")');
    expect(selectorIpc).toContain('handle("selector:app:confirm-quit"');
    expect(workspacePreload).toContain('invoke("workspace:shell:confirm-quit")');
    expect(localWorkspacePreload).toContain('invoke("local-workspace:shell:confirm-quit")');
    expect(workspaceIpc).toContain('handle("workspace:shell:confirm-quit"');
    expect(localWorkspaceIpc).toContain('handle("local-workspace:shell:confirm-quit"');
    expect(overlay).toContain('title: "退出叙界？"');
    expect(overlay).toContain('confirmLabel: "退出叙界"');
    expect(overlay).toContain('command === "request-quit"');
    expect(overlay).toContain("feature=desktop-quit-confirmation-v1");
    expect(overlay).not.toMatch(/^\+\+$/mu);
  });
});
