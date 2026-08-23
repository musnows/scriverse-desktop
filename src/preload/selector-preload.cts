const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

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
    setup: (input: unknown) => ipcRenderer.invoke("selector:local:setup", input)
  }),
  settings: Object.freeze({
    get: () => ipcRenderer.invoke("selector:settings:get"),
    update: (input: unknown) => ipcRenderer.invoke("selector:settings:update", input)
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
    testProvider: (input: unknown) => ipcRenderer.invoke("selector:local-ai:test-provider", input)
  }),
  app: Object.freeze({
    getVersion: () => ipcRenderer.invoke("selector:app:get-version"),
    getPlatform: () => ipcRenderer.invoke("selector:app:get-platform"),
    quit: () => ipcRenderer.invoke("selector:app:quit")
  })
}));
