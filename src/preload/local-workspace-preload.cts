const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const aiStreamChannel = "local-workspace:local-ai:stream-event";
const menuCommands = new Set(["request-quit"]);
const externalUrlRequestChannel = "local-workspace:shell:external-url-request";

function installEditorSaveShortcut(): void {
  document.addEventListener("keydown", (event) => {
    if (String(event.key).toLowerCase() !== "s" || event.altKey || event.shiftKey) return;
    const primaryModifier = process.platform === "darwin"
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    if (!primaryModifier) return;
    const editor = document.querySelector("#editor-view");
    const saveButton = document.querySelector("#save-button");
    if (!(editor instanceof HTMLElement)
      || editor.classList.contains("hidden")
      || editor.classList.contains("is-read-only")
      || !(saveButton instanceof HTMLButtonElement)
      || saveButton.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat) return;
    saveButton.click();
  }, { capture: true });
}

installEditorSaveShortcut();

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
  openExternalUrl: (input: unknown) => ipcRenderer.invoke("local-workspace:shell:open-external-url", input),
  onExternalUrlRequest: (listener: (request: { requestId: string; url: string }) => void) => {
    if (typeof listener !== "function") return () => undefined;
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
      const request = payload as Record<string, unknown>;
      if (typeof request.requestId === "string" && typeof request.url === "string") {
        listener({ requestId: request.requestId, url: request.url });
      }
    };
    ipcRenderer.on(externalUrlRequestChannel, handler);
    return () => ipcRenderer.removeListener(externalUrlRequestChannel, handler);
  },
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
