const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
const { ensureRemoteWorkspaceShellUi } = require("./remote-workspace-shell-ui.cjs") as typeof import("./remote-workspace-shell-ui.cjs");

const menuCommands = new Set(["open-sync-center"]);
let remoteShellUiObserver: MutationObserver | null = null;

async function installRemoteWorkspaceShellUi(): Promise<void> {
  const result = await ipcRenderer.invoke("workspace:shell:get-capabilities") as {
    ok?: boolean;
    data?: { profileName?: unknown; connectionMode?: unknown };
  } | null;
  const profileName = typeof result?.data?.profileName === "string" ? result.data.profileName.trim() : "";
  if (result?.ok !== true || result.data?.connectionMode !== "online" || !profileName) return;
  const render = (): void => ensureRemoteWorkspaceShellUi(
    document,
    profileName,
    () => ipcRenderer.invoke("workspace:shell:request-switch")
  );
  render();
  remoteShellUiObserver?.disconnect();
  remoteShellUiObserver = new MutationObserver(() => queueMicrotask(render));
  remoteShellUiObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("beforeunload", () => remoteShellUiObserver?.disconnect(), { once: true });
}

contextBridge.exposeInMainWorld("scriverseDesktopWorkspace", Object.freeze({
  shellProtocol: 1,
  syncProtocol: 1,
  shell: Object.freeze({
    getCapabilities: () => ipcRenderer.invoke("workspace:shell:get-capabilities"),
    reportLeaveState: (input: unknown) => ipcRenderer.invoke("workspace:shell:report-leave-state", input),
    requestSwitch: () => ipcRenderer.invoke("workspace:shell:request-switch"),
    onMenuCommand: (listener: (command: string) => void) => {
      if (typeof listener !== "function") return () => undefined;
      const handler = (_event: Electron.IpcRendererEvent, command: unknown) => {
        if (typeof command === "string" && menuCommands.has(command)) listener(command);
      };
      ipcRenderer.on("workspace:shell:menu-command", handler);
      return () => ipcRenderer.removeListener("workspace:shell:menu-command", handler);
    }
  }),
  localAi: Object.freeze({
    catalog: () => ipcRenderer.invoke("workspace:local-ai:catalog"),
    complete: (input: unknown) => ipcRenderer.invoke("workspace:local-ai:complete", input),
    cancel: (input: unknown) => ipcRenderer.invoke("workspace:local-ai:cancel", input),
    completeAgentRound: (input: unknown) => ipcRenderer.invoke("workspace:local-ai:agent-round", input),
    cancelAgentRound: (input: unknown) => ipcRenderer.invoke("workspace:local-ai:agent-round-cancel", input)
  })
}));

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void installRemoteWorkspaceShellUi().catch((error: unknown) => {
      console.error("Failed to install remote workspace shell UI", error);
    });
  }, { once: true });
} else {
  void installRemoteWorkspaceShellUi().catch((error: unknown) => {
    console.error("Failed to install remote workspace shell UI", error);
  });
}
