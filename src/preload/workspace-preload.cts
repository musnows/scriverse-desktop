const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const menuCommands = new Set(["open-sync-center"]);

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
