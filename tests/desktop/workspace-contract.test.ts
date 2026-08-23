import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseOfflineKeyRequest,
  parseWorkspaceLeaveState
} from "../../src/shared/workspace-contract.js";

const root = process.cwd();
const preloadSource = readFileSync(join(root, "src/preload/workspace-preload.cts"), "utf8");
const ipcSource = readFileSync(join(root, "src/main/workspace-ipc.ts"), "utf8");
const localPreloadSource = readFileSync(join(root, "src/preload/local-workspace-preload.cts"), "utf8");
const localIpcSource = readFileSync(join(root, "src/main/local-workspace-ipc.ts"), "utf8");

describe("Desktop 工作区最小 bridge", () => {
  it("严格校验离线密钥和离开状态", () => {
    expect(parseOfflineKeyRequest({ userId: "11111111-1111-4111-8111-111111111111" })).toEqual({
      userId: "11111111-1111-4111-8111-111111111111"
    });
    expect(() => parseOfflineKeyRequest({ userId: "../user", path: "/tmp/key" })).toThrowError(/unknown|\u672a知/u);
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
    expect(preloadSource).toContain("getOfflineKey");
    expect(preloadSource).toContain("reportLeaveState");
    expect(preloadSource).toContain("requestSwitch");
    expect(preloadSource).toContain("onMenuCommand");
    expect(preloadSource).toContain("localAi: Object.freeze");
    expect(preloadSource).toContain('ipcRenderer.invoke("workspace:local-ai:catalog"');
    expect(preloadSource).toContain('ipcRenderer.invoke("workspace:local-ai:complete"');
    expect(preloadSource).toContain('ipcRenderer.invoke("workspace:local-ai:cancel"');
    expect(preloadSource).not.toContain('workspace:local-ai:create');
    expect(preloadSource).not.toContain('workspace:local-ai:remove');
    expect(preloadSource).not.toContain("ipcRenderer,");
    expect(preloadSource).not.toContain("send:");
    expect(ipcSource).toContain("event.sender.session !== workspaceWindow.webContents.session");
    expect(ipcSource).toContain("senderOrigin !== profile.origin");
    expect(ipcSource).toContain("activeProfileId() !== profile.id");
    expect(ipcSource).toContain("user: options.getCachedUser()");
    expect(ipcSource).toContain("connectionMode: options.getConnectionMode()");
    expect(ipcSource).toContain("getLocalAiCatalog");
    expect(ipcSource).toContain("parseLocalAiCompletionRequestInput");
    expect(localPreloadSource).toContain('exposeInMainWorld("scriverseDesktopLocalAi"');
    expect(localPreloadSource).not.toContain("getOfflineKey");
    expect(localIpcSource).toContain("event.sender.session !== workspaceWindow.webContents.session");
    expect(localIpcSource).toContain("senderOrigin !== origin");
  });
});
