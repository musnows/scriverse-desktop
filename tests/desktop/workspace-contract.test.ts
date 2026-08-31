import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWorkspaceLeaveState } from "../../src/shared/workspace-contract.js";

const root = process.cwd();
const preloadSource = readFileSync(join(root, "src/preload/workspace-preload.cts"), "utf8");
const ipcSource = readFileSync(join(root, "src/main/workspace-ipc.ts"), "utf8");
const localPreloadSource = readFileSync(join(root, "src/preload/local-workspace-preload.cts"), "utf8");
const localIpcSource = readFileSync(join(root, "src/main/local-workspace-ipc.ts"), "utf8");

describe("Desktop 工作区最小 bridge", () => {
  it("严格校验工作区离开状态", () => {
    expect(parseWorkspaceLeaveState({ dirty: true, activeAiRequests: 1, pendingMutations: 2, conflicts: 3, rejected: 4 })).toEqual({
      dirty: true,
      activeAiRequests: 1,
      pendingMutations: 2,
      conflicts: 3,
      rejected: 4
    });
    expect(() => parseWorkspaceLeaveState({ dirty: false, activeAiRequests: -1, pendingMutations: 0, conflicts: 0, rejected: 0 })).toThrow();
  });

  it("只暴露有限 shell 方法并在 Main 复核 sender origin 与 session", () => {
    expect(preloadSource).toContain("getCapabilities");
    expect(preloadSource).not.toContain("getOfflineKey");
    expect(preloadSource).toContain("reportLeaveState");
    expect(preloadSource).toContain("requestSwitch");
    expect(preloadSource).toContain("onMenuCommand");
    expect(preloadSource).toContain("onExternalUrlRequest");
    expect(preloadSource).toContain('ipcRenderer.invoke("workspace:shell:open-external-url"');
    expect(preloadSource).toContain("localAi: Object.freeze");
    expect(preloadSource).toContain('ipcRenderer.invoke("workspace:local-ai:catalog"');
    expect(preloadSource).toContain('invokeAiWithStream("workspace:local-ai:complete"');
    expect(preloadSource).toContain('ipcRenderer.invoke("workspace:local-ai:cancel"');
    expect(preloadSource).toContain('invokeAiWithStream("workspace:local-ai:agent-round"');
    expect(preloadSource).toContain('ipcRenderer.invoke("workspace:local-ai:agent-round-cancel"');
    expect(preloadSource).toContain('const aiStreamChannel = "workspace:local-ai:stream-event"');
    expect(preloadSource).toContain("invokeAiWithStream");
    expect(preloadSource).toContain("ipcRenderer.on(aiStreamChannel, handler)");
    expect(preloadSource).toContain("ipcRenderer.removeListener(aiStreamChannel, handler)");
    expect(preloadSource).not.toContain('workspace:local-ai:create');
    expect(preloadSource).not.toContain('workspace:local-ai:remove');
    expect(preloadSource).not.toContain("ipcRenderer,");
    expect(preloadSource).not.toContain("send:");
    expect(ipcSource).toContain("event.sender.session !== workspaceWindow.webContents.session");
    expect(ipcSource).toContain('isRemoteWorkspaceShellUrl(event.senderFrame?.url ?? "", profile.id)');
    expect(ipcSource).toContain("activeProfileId() !== profile.id");
    expect(ipcSource).toContain("user: options.getCachedUser()");
    expect(ipcSource).toContain("connectionMode: options.getConnectionMode()");
    expect(ipcSource).toContain("getLocalAiCatalog");
    expect(ipcSource).toContain("parseLocalAiCompletionRequestInput");
    expect(ipcSource).toContain("parseLocalAiAgentRoundInput");
    expect(ipcSource).toContain("parseCancelLocalAiAgentRoundInput");
    expect(localPreloadSource).toContain('exposeInMainWorld("scriverseDesktopLocalAi"');
    expect(localPreloadSource).toContain("onExternalUrlRequest");
    expect(localPreloadSource).toContain('ipcRenderer.invoke("local-workspace:shell:open-external-url"');
    expect(localPreloadSource).not.toContain("getOfflineKey");
    expect(localPreloadSource).toContain('invokeAiWithStream("local-workspace:local-ai:agent-round"');
    expect(localPreloadSource).toContain('const aiStreamChannel = "local-workspace:local-ai:stream-event"');
    expect(ipcSource).toContain("workspaceWindow.webContents.send(aiStreamEventChannel");
    expect(localIpcSource).toContain("workspaceWindow.webContents.send(aiStreamEventChannel");
    expect(localIpcSource).toContain("event.sender.session !== workspaceWindow.webContents.session");
    expect(localIpcSource).toContain("senderOrigin !== origin");
    expect(ipcSource).toContain('workspace:shell:open-external-url');
    expect(localIpcSource).toContain('local-workspace:shell:open-external-url');
  });

  it("按平台把正文编辑器保存快捷键映射到保存按钮", () => {
    for (const source of [preloadSource, localPreloadSource]) {
      expect(source).toContain("function installEditorSaveShortcut(): void");
      expect(source).toContain('process.platform === "darwin"');
      expect(source).toContain("event.metaKey && !event.ctrlKey");
      expect(source).toContain("event.ctrlKey && !event.metaKey");
      expect(source).toContain('document.querySelector("#editor-view")');
      expect(source).toContain('document.querySelector("#save-button")');
      expect(source).toContain('editor.classList.contains("is-read-only")');
      expect(source).toContain("event.preventDefault()");
      expect(source).toContain("event.stopImmediatePropagation()");
      expect(source).toContain("saveButton.click()");
    }
  });
});
