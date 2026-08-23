const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

contextBridge.exposeInMainWorld("scriverseDesktopLocalShell", Object.freeze({
  getCapabilities: () => ipcRenderer.invoke("local-workspace:shell:get-capabilities"),
  requestSwitch: () => ipcRenderer.invoke("local-workspace:shell:request-switch"),
  logout: () => ipcRenderer.invoke("local-workspace:shell:logout")
}));

contextBridge.exposeInMainWorld("scriverseDesktopLocalAi", Object.freeze({
  catalog: () => ipcRenderer.invoke("local-workspace:local-ai:catalog"),
  complete: (input: unknown) => ipcRenderer.invoke("local-workspace:local-ai:complete", input),
  cancel: (input: unknown) => ipcRenderer.invoke("local-workspace:local-ai:cancel", input)
}));
