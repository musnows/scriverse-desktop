const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

const externalUrlRequestChannel = "selector:shell:external-url-request";

contextBridge.exposeInMainWorld("scriverseDesktop", Object.freeze({
  shellProtocol: 1,
  profiles: Object.freeze({
    list: () => ipcRenderer.invoke("selector:profiles:list"),
    status: (id: unknown) => ipcRenderer.invoke("selector:profiles:status", id),
    create: (input: unknown) => ipcRenderer.invoke("selector:profiles:create", input),
    update: (input: unknown) => ipcRenderer.invoke("selector:profiles:update", input),
    remove: (input: unknown) => ipcRenderer.invoke("selector:profiles:remove", input),
    open: (id: unknown) => ipcRenderer.invoke("selector:profiles:open", id),
    probe: (id: unknown) => ipcRenderer.invoke("selector:profiles:probe", id)
  }),
  local: Object.freeze({
    getStatus: () => ipcRenderer.invoke("selector:local:get-status"),
    setup: (input: unknown) => ipcRenderer.invoke("selector:local:setup", input),
    login: (input: unknown) => ipcRenderer.invoke("selector:local:login", input)
  }),
  settings: Object.freeze({
    get: () => ipcRenderer.invoke("selector:settings:get"),
    update: (input: unknown) => ipcRenderer.invoke("selector:settings:update", input),
    openLogs: () => ipcRenderer.invoke("selector:settings:open-logs")
  }),
  remote: Object.freeze({
    refreshCaptcha: (profileId: unknown) => ipcRenderer.invoke("selector:remote:refresh-captcha", profileId),
    login: (input: unknown) => ipcRenderer.invoke("selector:remote:login", input)
  }),
  localAi: Object.freeze({
    configuration: () => ipcRenderer.invoke("selector:local-ai:configuration"),
    updateSystemPrompt: (input: unknown) => ipcRenderer.invoke("selector:local-ai:update-system-prompt", input),
    createProvider: (input: unknown) => ipcRenderer.invoke("selector:local-ai:create-provider", input),
    updateProvider: (input: unknown) => ipcRenderer.invoke("selector:local-ai:update-provider", input),
    removeProvider: (input: unknown) => ipcRenderer.invoke("selector:local-ai:remove-provider", input),
    createModel: (input: unknown) => ipcRenderer.invoke("selector:local-ai:create-model", input),
    updateModel: (input: unknown) => ipcRenderer.invoke("selector:local-ai:update-model", input),
    removeModel: (input: unknown) => ipcRenderer.invoke("selector:local-ai:remove-model", input),
    testProvider: (input: unknown) => ipcRenderer.invoke("selector:local-ai:test-provider", input),
    testModel: (input: unknown) => ipcRenderer.invoke("selector:local-ai:test-model", input)
  }),
  app: Object.freeze({
    getVersion: () => ipcRenderer.invoke("selector:app:get-version"),
    getPlatform: () => ipcRenderer.invoke("selector:app:get-platform"),
    requestQuit: () => ipcRenderer.invoke("selector:app:request-quit"),
    confirmQuit: () => ipcRenderer.invoke("selector:app:confirm-quit"),
    onQuitRequested: (listener: () => void) => {
      if (typeof listener !== "function") return () => undefined;
      const handler = () => listener();
      ipcRenderer.on("selector:app:request-quit", handler);
      return () => ipcRenderer.removeListener("selector:app:request-quit", handler);
    }
  }),
  external: Object.freeze({
    openExternalUrl: (input: unknown) => ipcRenderer.invoke("selector:shell:open-external-url", input),
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
    }
  })
}));
