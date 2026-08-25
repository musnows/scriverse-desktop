const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const aiStreamChannel = "local-workspace:local-ai:stream-event";
const menuCommands = new Set(["request-quit"]);

function invokeAiWithStream(channel: string, input: unknown, listener?: (event: unknown) => void): Promise<unknown> {
  const requestId = input && typeof input === "object" && "requestId" in input && typeof input.requestId === "string"
    ? input.requestId
    : null;
  if (!requestId || typeof listener !== "function") return ipcRenderer.invoke(channel, input);
  const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
    if (!payload || typeof payload !== "object" || !("requestId" in payload) || payload.requestId !== requestId || !("event" in payload)) return;
    listener(payload.event);
  };
  ipcRenderer.on(aiStreamChannel, handler);
  return ipcRenderer.invoke(channel, input).finally(() => ipcRenderer.removeListener(aiStreamChannel, handler));
}

contextBridge.exposeInMainWorld("scriverseDesktopLocalShell", Object.freeze({
  getCapabilities: () => ipcRenderer.invoke("local-workspace:shell:get-capabilities"),
  requestSwitch: () => ipcRenderer.invoke("local-workspace:shell:request-switch"),
  logout: () => ipcRenderer.invoke("local-workspace:shell:logout"),
  confirmQuit: () => ipcRenderer.invoke("local-workspace:shell:confirm-quit"),
  onMenuCommand: (listener: (command: string) => void) => {
    if (typeof listener !== "function") return () => undefined;
    const handler = (_event: Electron.IpcRendererEvent, command: unknown) => {
      if (typeof command === "string" && menuCommands.has(command)) listener(command);
    };
    ipcRenderer.on("workspace:shell:menu-command", handler);
    return () => ipcRenderer.removeListener("workspace:shell:menu-command", handler);
  }
}));

contextBridge.exposeInMainWorld("scriverseDesktopLocalAi", Object.freeze({
  catalog: () => ipcRenderer.invoke("local-workspace:local-ai:catalog"),
  complete: (input: unknown, listener?: (event: unknown) => void) => invokeAiWithStream("local-workspace:local-ai:complete", input, listener),
  cancel: (input: unknown) => ipcRenderer.invoke("local-workspace:local-ai:cancel", input),
  completeAgentRound: (input: unknown, listener?: (event: unknown) => void) => invokeAiWithStream("local-workspace:local-ai:agent-round", input, listener),
  cancelAgentRound: (input: unknown) => ipcRenderer.invoke("local-workspace:local-ai:agent-round-cancel", input)
}));
