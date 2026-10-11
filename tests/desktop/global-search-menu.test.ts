import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";
import { createDesktopMenuTemplate, type DesktopMenuActions } from "../../src/main/native-menu.js";

vi.mock("electron", () => ({ Menu: {} }));

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

function actions(): DesktopMenuActions {
  return {
    switchWorkspace: vi.fn(),
    reconnectWorkspace: vi.fn(),
    openSyncCenter: vi.fn(),
    requestQuit: vi.fn(),
    find: vi.fn(),
    openGlobalSearch: vi.fn(),
    openLogs: vi.fn(),
    showVersion: vi.fn(),
    checkForUpdates: vi.fn()
  };
}

function runMainAction(name: "find" | "openGlobalSearch", workspaceWindow: unknown): void {
  const main = source("src/main/main.ts");
  const start = main.indexOf(`    ${name}: () => {`);
  const end = main.indexOf("\n    },", start);
  if (start < 0 || end < 0) throw new Error("Desktop search menu action is missing");
  const callback = main.slice(start, end).replace(`    ${name}:`, "return");
  new Function("workspaceWindow", `${callback}\n};`)(workspaceWindow)();
}

function preloadMenuBridge(path: string) {
  const exposed = new Map<string, unknown>();
  const handlers = new Map<string, (event: unknown, command: unknown) => void>();
  const ipcRenderer = {
    invoke: vi.fn(async () => ({ ok: true })),
    on: vi.fn((channel: string, listener: (event: unknown, command: unknown) => void) => handlers.set(channel, listener)),
    removeListener: vi.fn((channel: string) => handlers.delete(channel))
  };
  const electron = {
    contextBridge: { exposeInMainWorld: (name: string, bridge: unknown) => exposed.set(name, bridge) },
    ipcRenderer
  };
  const document = { addEventListener: vi.fn() };
  const compiled = transpileModule(source(path), {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2023 }
  }).outputText;
  new Function("require", "document", "window", "process", compiled)(
    () => electron, document, {}, { argv: [], platform: "darwin" }
  );
  type MenuBridge = { onMenuCommand: (listener: (command: string) => void) => () => void };
  const local = exposed.get("scriverseDesktopLocalShell") as MenuBridge | undefined;
  const remote = exposed.get("scriverseDesktopWorkspace") as { shell: MenuBridge } | undefined;
  const bridge = local ?? remote?.shell;
  if (!bridge) throw new Error("Desktop menu bridge is missing");
  return { bridge, handlers, ipcRenderer };
}

function rendererMenuHandler({ work = true, chapter = false, failure = false } = {}) {
  const added = source("runtime-overlay/web.patch").split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1)).join("\n");
  const start = added.indexOf("desktopMenuCommandBridge()?.onMenuCommand?.((command) => {");
  const end = added.indexOf("\n});", start);
  if (start < 0 || end < 0) throw new Error("Desktop renderer menu handler is missing");
  const handlers: Array<(command: string) => void> = [];
  const openChapterSearchPanel = vi.fn();
  const openSearchDialog = vi.fn(async () => {
    if (failure) throw new Error("Search is unavailable");
  });
  const toast = vi.fn();
  new Function("desktopMenuCommandBridge", "state", "isChapterSearchContext", "openChapterSearchPanel", "openSearchDialog", "toast", added.slice(start, end + 4))(
    () => ({ onMenuCommand: (handler: (command: string) => void) => handlers.push(handler) }),
    { work: work ? { id: "work-1" } : null }, () => chapter,
    openChapterSearchPanel, openSearchDialog, toast
  );
  return { command: handlers[0], openChapterSearchPanel, openSearchDialog, toast };
}

describe("Desktop search menu", () => {
  it.each(["darwin", "win32", "linux"] as const)("offers separate find and global search actions on %s", (platform) => {
    const callbacks = actions();
    const edit = createDesktopMenuTemplate(callbacks, platform).find((item) => item.label === "编辑");
    if (!Array.isArray(edit?.submenu)) throw new Error("Desktop edit menu is missing");
    const find = edit.submenu.find((item) => item.label === "查找");
    const global = edit.submenu.find((item) => item.label === "全局搜索");
    expect(find?.accelerator).toBe("CmdOrCtrl+F");
    expect(global?.accelerator).toBe("CmdOrCtrl+Shift+F");
    expect(find?.click).toBe(callbacks.find);
    expect(global?.click).toBe(callbacks.openGlobalSearch);
  });

  it.each(["find", "openGlobalSearch"] as const)("sends %s directly without synthesizing menu accelerators", (name) => {
    const send = vi.fn();
    const sendInputEvent = vi.fn();
    runMainAction(name, { isDestroyed: () => false, webContents: { send, sendInputEvent } });
    expect(send).toHaveBeenCalledExactlyOnceWith("workspace:shell:menu-command", name === "find" ? "find" : "open-global-search");
    expect(sendInputEvent).not.toHaveBeenCalled();
    runMainAction(name, null);
    runMainAction(name, { isDestroyed: () => true, webContents: { send } });
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(["src/preload/workspace-preload.cts", "src/preload/local-workspace-preload.cts"])("filters and disposes search commands in %s", (path) => {
    const { bridge, handlers, ipcRenderer } = preloadMenuBridge(path);
    const listener = vi.fn();
    const dispose = bridge.onMenuCommand(listener);
    const handler = handlers.get("workspace:shell:menu-command");
    if (!handler) throw new Error("Desktop menu IPC listener is missing");
    for (const command of ["find", "open-global-search", "unknown-command", null, { command: "find" }]) handler({}, command);
    expect(listener.mock.calls).toEqual([["find"], ["open-global-search"]]);
    dispose();
    expect(ipcRenderer.removeListener).toHaveBeenCalledExactlyOnceWith("workspace:shell:menu-command", handler);
  });

  it.each([false, true])("always opens work-wide search with chapter context %s", (chapter) => {
    const renderer = rendererMenuHandler({ chapter });
    renderer.command("open-global-search");
    expect(renderer.openSearchDialog).toHaveBeenCalledOnce();
    expect(renderer.openChapterSearchPanel).not.toHaveBeenCalled();
  });

  it("keeps find scoped to the chapter when a chapter search context is active", () => {
    const chapter = rendererMenuHandler({ chapter: true });
    chapter.command("find");
    expect(chapter.openChapterSearchPanel).toHaveBeenCalledOnce();
    expect(chapter.openSearchDialog).not.toHaveBeenCalled();
    const work = rendererMenuHandler();
    work.command("find");
    expect(work.openSearchDialog).toHaveBeenCalledOnce();
  });

  it("ignores find outside a work and reports asynchronous search errors", async () => {
    const shelf = rendererMenuHandler({ work: false });
    shelf.command("find");
    expect(shelf.openSearchDialog).not.toHaveBeenCalled();
    const renderer = rendererMenuHandler({ failure: true });
    renderer.command("open-global-search");
    await Promise.resolve();
    expect(renderer.toast).toHaveBeenCalledExactlyOnceWith("Search is unavailable", "error");
  });
});
