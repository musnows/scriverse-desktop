const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const menuCommands = new Set(["open-sync-center"]);
const aiStreamChannel = "workspace:local-ai:stream-event";

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
    complete: (input: unknown, listener?: (event: unknown) => void) => invokeAiWithStream("workspace:local-ai:complete", input, listener),
    cancel: (input: unknown) => ipcRenderer.invoke("workspace:local-ai:cancel", input),
    completeAgentRound: (input: unknown, listener?: (event: unknown) => void) => invokeAiWithStream("workspace:local-ai:agent-round", input, listener),
    cancelAgentRound: (input: unknown) => ipcRenderer.invoke("workspace:local-ai:agent-round-cancel", input)
  })
}));
