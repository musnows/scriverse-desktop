const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const menuCommands = new Set(["open-sync-center", "request-quit"]);
const aiStreamChannel = "workspace:local-ai:stream-event";
const externalUrlRequestChannel = "workspace:shell:external-url-request";

function clipboardWriteFailureMessage(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "Desktop 剪贴板写入失败";
  const error = "error" in result ? result.error : null;
  if (!error || typeof error !== "object" || Array.isArray(error)) return "Desktop 剪贴板写入失败";
  return "message" in error && typeof error.message === "string" ? error.message : "Desktop 剪贴板写入失败";
}

function writeClipboardText(channel: string, input: unknown): Promise<void> {
  return ipcRenderer.invoke(channel, input).then((result: unknown) => {
    if (result && typeof result === "object" && !Array.isArray(result) && "ok" in result && result.ok === true) return;
    throw new Error(clipboardWriteFailureMessage(result));
  });
}

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

contextBridge.exposeInMainWorld("scriverseDesktopWorkspace", Object.freeze({
  shellProtocol: 1,
  syncProtocol: 1,
  shell: Object.freeze({
    getCapabilities: () => ipcRenderer.invoke("workspace:shell:get-capabilities"),
    reportLeaveState: (input: unknown) => ipcRenderer.invoke("workspace:shell:report-leave-state", input),
    requestSwitch: () => ipcRenderer.invoke("workspace:shell:request-switch"),
    confirmQuit: () => ipcRenderer.invoke("workspace:shell:confirm-quit"),
    cacheWorkCover: (input: unknown) => ipcRenderer.invoke("workspace:shell:cache-work-cover", input),
    cacheWorkImages: (input: unknown) => ipcRenderer.invoke("workspace:shell:cache-work-images", input),
    openExternalUrl: (input: unknown) => ipcRenderer.invoke("workspace:shell:open-external-url", input),
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
  }),
  localAi: Object.freeze({
    catalog: () => ipcRenderer.invoke("workspace:local-ai:catalog"),
    complete: (input: unknown, listener?: (event: unknown) => void) => invokeAiWithStream("workspace:local-ai:complete", input, listener),
    cancel: (input: unknown) => ipcRenderer.invoke("workspace:local-ai:cancel", input),
    completeAgentRound: (input: unknown, listener?: (event: unknown) => void) => invokeAiWithStream("workspace:local-ai:agent-round", input, listener),
    cancelAgentRound: (input: unknown) => ipcRenderer.invoke("workspace:local-ai:agent-round-cancel", input)
  })
}));

contextBridge.exposeInMainWorld("scriverseDesktopClipboard", Object.freeze({
  writeText: (input: unknown) => writeClipboardText("workspace:shell:write-clipboard-text", input)
}));
