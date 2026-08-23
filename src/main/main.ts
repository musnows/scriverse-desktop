import { app, BrowserWindow, dialog, safeStorage, session, shell, utilityProcess, type UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerDesktopScheme, registerSelectorProtocol } from "./app-protocol.js";
import { resolveCompatibleServerVersion, resolveDesktopAppVersion } from "./app-version.js";
import { initializeDesktopEnvironment, type DesktopEnvironment } from "./desktop-environment.js";
import { LocalServerManager } from "./local-server-manager.js";
import { ProfileStore } from "./profile-store.js";
import { registerSelectorIpc } from "./selector-ipc.js";
import { createSelectorWindow } from "./selector-window.js";
import { createLocalWorkspaceWindow } from "./workspace-window.js";
import { createRemoteWorkspaceWindow } from "./remote-workspace-window.js";
import { RemoteAuthClient } from "./remote-auth-client.js";
import { RemoteAuthCoordinator } from "./remote-auth-coordinator.js";
import { RemoteAuthStore, type DesktopSecretStorage } from "./remote-auth-store.js";
import { RemoteSessionRegistry } from "./remote-session-policy.js";
import { RemoteSyncStatusStore } from "./remote-sync-status-store.js";
import { RemoteServerProbe } from "./remote-server-probe.js";
import { OfflineKeyStore } from "./offline-key-store.js";
import { LocalAiProviderStore } from "./local-ai-provider-store.js";
import { LocalAiClient } from "./local-ai-client.js";
import { LocalAiRequestCoordinator } from "./local-ai-request-coordinator.js";
import { registerLocalWorkspaceIpc } from "./local-workspace-ipc.js";
import { registerWorkspaceIpc } from "./workspace-ipc.js";
import { registerDownloadPolicy } from "./download-policy.js";
import { installDesktopMenu } from "./native-menu.js";
import { DesktopUpdater } from "./desktop-updater.js";
import { handleSquirrelStartup } from "./squirrel-startup.js";
import { applyWindowPlacement, captureWindowPlacement } from "./window-placement.js";
import { DesktopSettingsStore } from "./desktop-settings-store.js";
import { LOCAL_PROFILE_ID, LOCAL_PROFILE_PARTITION, type RemoteWorkspaceProfile } from "../shared/contracts.js";
import type { WorkspaceLeaveState } from "../shared/workspace-contract.js";
import {
  LOCAL_COOKIE_OPERATION_TIMEOUT_MS,
  LOCAL_SESSION_COOKIE_NAME,
  LOCAL_SESSION_MAX_AGE_SECONDS
} from "../shared/local-server-contract.js";

type RuntimeGateResult = {
  ok: boolean;
  electronVersion: string;
  nodeVersion: string;
  sqlite: boolean;
  sharp: boolean;
  vditor: boolean;
  localServer: boolean;
  error?: string;
};

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(moduleDirectory, "..");
const applicationRoot = app.isPackaged ? app.getAppPath() : join(moduleDirectory, "..", "..");
const utilityWorkingDirectory = app.isPackaged ? process.resourcesPath : applicationRoot;
const runtimeGateRequested = process.argv.includes("--runtime-gate");
const localProvisionGateRequested = process.argv.includes("--local-provision-gate");
const localServerGateRequested = process.argv.includes("--local-server-gate") || localProvisionGateRequested;
let mainWindow: BrowserWindow | null = null;
let workspaceWindow: BrowserWindow | null = null;
let desktopEnvironment: DesktopEnvironment | null = null;
let desktopStartupError: unknown = null;
let disposeSelectorIpc: (() => void) | null = null;
let disposeWorkspaceIpc: (() => void) | null = null;
let disposeWorkspaceDownloadPolicy: (() => void) | null = null;
let localServerManager: LocalServerManager | null = null;
let desktopSettingsStore: DesktopSettingsStore | null = null;
let remoteAuthCoordinator: RemoteAuthCoordinator | null = null;
let remoteSyncStatusStore: RemoteSyncStatusStore | null = null;
let offlineKeyStore: OfflineKeyStore | null = null;
let localAiProviderStore: LocalAiProviderStore | null = null;
let localAiClient: LocalAiClient | null = null;
let localAiRequestCoordinator: LocalAiRequestCoordinator | null = null;
let desktopUpdater: DesktopUpdater | null = null;
let quitAfterLocalShutdown = false;
let localWorkspaceOpenPromise: Promise<void> | null = null;
let remoteWorkspaceOpenPromise: Promise<void> | null = null;
let activeWorkspaceKind: "local" | "remote" | null = null;
let activeRemoteProfileId: string | null = null;
let activeRemoteLeaveState: WorkspaceLeaveState = {
  dirty: false,
  activeAiRequests: 0,
  pendingMutations: 0,
  conflicts: 0,
  rejected: 0
};

function writeRuntimeGateResult(result: RuntimeGateResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function runtimeGateEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    SCRIVERSE_DESKTOP_APP_ROOT: applicationRoot,
    SCRIVERSE_DESKTOP_GATE_DATA_DIR: process.env.SCRIVERSE_DESKTOP_GATE_DATA_DIR
      ?? join(app.getPath("userData"), "runtime-gate")
  };
}

async function runRuntimeGate(): Promise<void> {
  const utilityEntry = join(desktopRoot, "utility", "runtime-gate.mjs");
  if (!existsSync(utilityEntry)) {
    writeRuntimeGateResult({
      ok: false,
      electronVersion: process.versions.electron ?? "unknown",
      nodeVersion: process.versions.node,
      sqlite: false,
      sharp: false,
      vditor: false,
      localServer: false,
      error: "Desktop runtime gate utility is missing"
    });
    app.exit(1);
    return;
  }

  await new Promise<void>((resolve) => {
    let child: UtilityProcess | null = utilityProcess.fork(utilityEntry, [], {
      cwd: utilityWorkingDirectory,
      env: runtimeGateEnvironment(),
      serviceName: "Scriverse Desktop Runtime Gate",
      stdio: "pipe"
    });
    let settled = false;
    const finish = (result: RuntimeGateResult, exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      writeRuntimeGateResult(result);
      child?.kill();
      child = null;
      app.exit(exitCode);
      resolve();
    };
    const timeout = setTimeout(() => finish({
      ok: false,
      electronVersion: process.versions.electron ?? "unknown",
      nodeVersion: process.versions.node,
      sqlite: false,
      sharp: false,
      vditor: false,
      localServer: false,
      error: "Desktop runtime gate timed out"
    }, 1), 30_000);
    child.stdout?.on("data", (chunk: Buffer | string) => process.stderr.write(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => process.stderr.write(chunk));
    child.once("spawn", () => process.stderr.write("Desktop runtime gate utility spawned\n"));
    child.once("message", (message: unknown) => {
      const result = message as RuntimeGateResult;
      finish(result, result.ok ? 0 : 1);
    });
    child.once("error", () => finish({
      ok: false,
      electronVersion: process.versions.electron ?? "unknown",
      nodeVersion: process.versions.node,
      sqlite: false,
      sharp: false,
      vditor: false,
      localServer: false,
      error: "Desktop runtime gate utility crashed"
    }, 1));
    child.once("exit", (code) => {
      if (!settled) {
        finish({
          ok: false,
          electronVersion: process.versions.electron ?? "unknown",
          nodeVersion: process.versions.node,
          sqlite: false,
          sharp: false,
          vditor: false,
          localServer: false,
          error: `Desktop runtime gate utility exited before reporting with code ${code}`
        }, 1);
      }
    });
  });
}

function createLocalServerManager(environment: DesktopEnvironment, settings: DesktopSettingsStore): LocalServerManager {
  return new LocalServerManager({
    paths: environment.paths,
    desktopId: environment.desktopId,
    applicationRoot,
    desktopRoot,
    utilityWorkingDirectory,
    getPreferredPort: () => settings.get().localServerPort
  });
}

async function runLocalServerGate(manager: LocalServerManager): Promise<void> {
  try {
    const ready = await manager.start();
    let provisioned = false;
    let userRole: string | null = null;
    let duplicateProvisionRejected = false;
    let setupRequiredAfter = ready.setupRequired;
    let cookieVerified = false;
    let workspaceLoaded = false;
    if (localProvisionGateRequested && ready.setupRequired) {
      const provision = await manager.provision({
        username: "desktop_gate_admin",
        password: `desktop-gate-${randomUUID()}-A1`
      });
      await setLocalSessionCookie(provision);
      const storedCookie = (await withLocalCookieTimeout(session.fromPartition(LOCAL_PROFILE_PARTITION).cookies.get({
        url: provision.url,
        name: LOCAL_SESSION_COOKIE_NAME
      })))[0];
      if (!storedCookie || storedCookie.value !== provision.sessionToken || storedCookie.httpOnly !== true || storedCookie.sameSite !== "lax") {
        throw new Error("Local provision gate cookie verification failed");
      }
      cookieVerified = true;
      const sessionState = await fetch(`${provision.url}/api/auth/session`, {
        headers: { Cookie: `${LOCAL_SESSION_COOKIE_NAME}=${provision.sessionToken}` },
        redirect: "error"
      }).then((response) => response.json()) as { data?: { authenticated?: unknown; user?: { userId?: unknown } } };
      if (sessionState.data?.authenticated !== true || sessionState.data.user?.userId !== provision.user.userId) {
        throw new Error("Local provision gate session verification failed");
      }
      const gateWindow = await createLocalWorkspaceWindow({
        origin: provision.url,
        desktopRoot,
        onReady: () => undefined,
        onClosed: () => undefined,
        enableLocalAiBridge: false,
        show: false
      });
      workspaceLoaded = gateWindow.webContents.getURL().startsWith(`${provision.url}/`);
      gateWindow.destroy();
      if (!workspaceLoaded) throw new Error("Local provision gate workspace navigation failed");
      provisioned = true;
      userRole = provision.user.role;
      setupRequiredAfter = manager.getStatus().setupRequired ?? true;
      try {
        await manager.provision({ username: "duplicate_admin", password: `duplicate-gate-${randomUUID()}-A1` });
      } catch (error) {
        duplicateProvisionRejected = error instanceof Error
          && "code" in error
          && error.code === "LOCAL_ALREADY_PROVISIONED";
      }
      if (!duplicateProvisionRejected) throw new Error("Local provision gate accepted duplicate initialization");
    }
    await manager.stop();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      port: ready.port,
      bootId: ready.bootId,
      schemaVersion: ready.schemaVersion,
      setupRequired: setupRequiredAfter,
      provisioned,
      userRole,
      duplicateProvisionRejected,
      cookieVerified,
      workspaceLoaded,
      stopped: manager.getStatus().phase === "stopped"
    })}\n`);
    app.exit(0);
  } catch (error) {
    await manager.stop();
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    app.exit(1);
  }
}

async function setLocalSessionCookie(result: { url: string; sessionToken: string }): Promise<void> {
  const localSession = session.fromPartition(LOCAL_PROFILE_PARTITION);
  await withLocalCookieTimeout(localSession.cookies.set({
    url: result.url,
    name: LOCAL_SESSION_COOKIE_NAME,
    value: result.sessionToken,
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    path: "/",
    expirationDate: Math.floor(Date.now() / 1_000) + LOCAL_SESSION_MAX_AGE_SECONDS
  }));
}

async function withLocalCookieTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = new Error("系统钥匙串授权未完成，请在前台允许 Scriverse Desktop Safe Storage 后重试") as Error & { code: string };
          error.code = "KEYCHAIN_INTERACTION_REQUIRED";
          reject(error);
        }, LOCAL_COOKIE_OPERATION_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function createDesktopSecretStorage(): DesktopSecretStorage {
  return {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    isSecureBackend: () => process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text",
    encryptString: (value) => safeStorage.encryptString(value),
    decryptString: (value) => safeStorage.decryptString(value)
  };
}

function showSelectorFromWorkspace(window: BrowserWindow): void {
  const selector = mainWindow;
  if (!selector || selector.isDestroyed() || window.isDestroyed()) return;
  applyWindowPlacement(selector, captureWindowPlacement(window));
  selector.show();
  selector.focus();
  window.hide();
}

function bindWorkspaceReplacement(window: BrowserWindow): void {
  window.on("close", () => {
    if (!quitAfterLocalShutdown) showSelectorFromWorkspace(window);
  });
}

function openLocalWorkspace(origin: string): Promise<void> {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    if (workspaceWindow.isMinimized()) workspaceWindow.restore();
    workspaceWindow.focus();
    mainWindow?.hide();
    return Promise.resolve();
  }
  if (localWorkspaceOpenPromise) return localWorkspaceOpenPromise;
  if (!localAiRequestCoordinator) return Promise.reject(new Error("Desktop 本地 AI 尚未就绪"));
  localWorkspaceOpenPromise = createLocalWorkspaceWindow({
    origin,
    desktopRoot,
    ...(mainWindow && !mainWindow.isDestroyed() ? { placement: captureWindowPlacement(mainWindow) } : {}),
    onCreated: (window) => {
      workspaceWindow = window;
      activeWorkspaceKind = "local";
      activeRemoteProfileId = null;
      bindWorkspaceReplacement(window);
      disposeWorkspaceIpc = registerLocalWorkspaceIpc(window, new URL(origin).origin, {
        isActive: () => activeWorkspaceKind === "local" && workspaceWindow === window,
        getWorkspaceIdentity: () => ({ profileId: LOCAL_PROFILE_ID, profileName: "本地工作区", profileKind: "local" }),
        requestSwitch: requestWorkspaceSwitch,
        getLocalAiCatalog: () => localAiRequestCoordinator!.catalog(),
        completeLocalAi: (input) => localAiRequestCoordinator!.complete(input),
        cancelLocalAi: (requestId) => localAiRequestCoordinator!.cancel(requestId)
      });
    },
    onReady: () => mainWindow?.hide(),
    onClosed: () => {
      disposeWorkspaceDownloadPolicy?.();
      disposeWorkspaceDownloadPolicy = null;
      disposeWorkspaceIpc?.();
      disposeWorkspaceIpc = null;
      localAiRequestCoordinator?.cancelAll();
      workspaceWindow = null;
      activeWorkspaceKind = null;
      activeRemoteProfileId = null;
      if (quitAfterLocalShutdown) return;
    }
  }).then((window) => {
    workspaceWindow = window;
    disposeWorkspaceDownloadPolicy = registerDownloadPolicy(window.webContents.session, () => workspaceWindow === window ? window : null);
    activeWorkspaceKind = "local";
    activeRemoteProfileId = null;
  }).finally(() => {
    localWorkspaceOpenPromise = null;
  });
  return localWorkspaceOpenPromise;
}

function openRemoteWorkspace(profile: RemoteWorkspaceProfile, connectionMode: "online" | "offline"): Promise<void> {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    if (activeWorkspaceKind !== "remote" || activeRemoteProfileId !== profile.id) {
      const error = new Error("请先关闭当前工作区再切换 Server") as Error & { code: string };
      error.code = "WORKSPACE_SWITCH_REQUIRED";
      return Promise.reject(error);
    }
    if (workspaceWindow.isMinimized()) workspaceWindow.restore();
    workspaceWindow.focus();
    mainWindow?.hide();
    return Promise.resolve();
  }
  if (remoteWorkspaceOpenPromise) return remoteWorkspaceOpenPromise;
  if (!remoteAuthCoordinator || !remoteSyncStatusStore || !offlineKeyStore || !localAiRequestCoordinator) return Promise.reject(new Error("Desktop 离线安全存储尚未就绪"));
  activeWorkspaceKind = "remote";
  activeRemoteProfileId = profile.id;
  const cachedUser = remoteAuthCoordinator.cachedUser(profile);
  const persistedState = cachedUser ? remoteSyncStatusStore.user(profile, cachedUser.userId) : null;
  activeRemoteLeaveState = {
    dirty: false,
    activeAiRequests: 0,
    pendingMutations: persistedState?.pendingMutations ?? 0,
    conflicts: persistedState?.conflicts ?? 0,
    rejected: persistedState?.rejected ?? 0
  };
  remoteWorkspaceOpenPromise = createRemoteWorkspaceWindow({
    profile,
    connectionMode,
    desktopRoot,
    offlineShellRoot: join(applicationRoot, "dist", "public"),
    ...(mainWindow && !mainWindow.isDestroyed() ? { placement: captureWindowPlacement(mainWindow) } : {}),
    onCreated: (window) => {
      workspaceWindow = window;
      disposeWorkspaceDownloadPolicy?.();
      disposeWorkspaceDownloadPolicy = registerDownloadPolicy(window.webContents.session, () => workspaceWindow === window ? window : null);
      bindWorkspaceReplacement(window);
      disposeWorkspaceIpc = registerWorkspaceIpc(window, profile, {
        activeProfileId: () => activeRemoteProfileId,
        getCachedUser: () => remoteAuthCoordinator!.cachedUser(profile),
        getConnectionMode: () => remoteAuthCoordinator!.connectionMode(profile),
        getOfflineKey: async (userId) => {
          const access = await remoteAuthCoordinator!.authorizeOfflineKey(profile, userId);
          return access.verifiedOnline
            ? offlineKeyStore!.getOrCreate(profile, userId)
            : offlineKeyStore!.load(profile, userId);
        },
        getLocalAiCatalog: () => localAiRequestCoordinator!.catalog(),
        completeLocalAi: (_userId, input) => localAiRequestCoordinator!.complete(input),
        cancelLocalAi: (_userId, requestId) => localAiRequestCoordinator!.cancel(requestId),
        reportLeaveState: (state) => {
          activeRemoteLeaveState = state;
          const user = remoteAuthCoordinator!.cachedUser(profile);
          if (user) remoteSyncStatusStore!.update(profile, user.userId, state);
        },
        requestSwitch: requestWorkspaceSwitch
      });
    },
    onReady: () => mainWindow?.hide(),
    onClosed: () => {
      disposeWorkspaceDownloadPolicy?.();
      disposeWorkspaceDownloadPolicy = null;
      disposeWorkspaceIpc?.();
      disposeWorkspaceIpc = null;
      localAiRequestCoordinator?.cancelAll();
      workspaceWindow = null;
      activeWorkspaceKind = null;
      activeRemoteProfileId = null;
      activeRemoteLeaveState = { dirty: false, activeAiRequests: 0, pendingMutations: 0, conflicts: 0, rejected: 0 };
    }
  }).then((window) => {
    workspaceWindow = window;
    activeWorkspaceKind = "remote";
    activeRemoteProfileId = profile.id;
  }).catch((error) => {
    disposeWorkspaceIpc?.();
    disposeWorkspaceIpc = null;
    workspaceWindow = null;
    activeWorkspaceKind = null;
    activeRemoteProfileId = null;
    throw error;
  }).finally(() => {
    remoteWorkspaceOpenPromise = null;
  });
  return remoteWorkspaceOpenPromise;
}

async function requestWorkspaceSwitch(): Promise<void> {
  const window = workspaceWindow;
  if (!window || window.isDestroyed()) {
    mainWindow?.show();
    mainWindow?.focus();
    return;
  }
  if (activeWorkspaceKind === "remote" && (activeRemoteLeaveState.dirty || activeRemoteLeaveState.activeAiRequests > 0)) {
    const persisted = [
      activeRemoteLeaveState.pendingMutations > 0 ? `${activeRemoteLeaveState.pendingMutations} 项待同步` : null,
      activeRemoteLeaveState.conflicts > 0 ? `${activeRemoteLeaveState.conflicts} 项冲突` : null,
      activeRemoteLeaveState.rejected > 0 ? `${activeRemoteLeaveState.rejected} 项只读修改` : null
    ].filter(Boolean).join("，");
    const result = await dialog.showMessageBox(window, {
      type: "warning",
      title: "切换工作区",
      message: "当前页面仍有未保存内容或进行中的 AI 请求",
      detail: persisted ? `已写入本机的 ${persisted} 会继续保留。放弃只会丢失尚未保存的页面内容。` : "放弃会丢失尚未保存的页面内容。",
      buttons: ["继续编辑", "放弃未保存内容并切换"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (result.response !== 1) return;
    showSelectorFromWorkspace(window);
    window.destroy();
    return;
  }
  const restoreWorkspace = (): void => {
    if (window.isDestroyed()) return;
    mainWindow?.hide();
    window.show();
    window.focus();
  };
  window.webContents.once("will-prevent-unload", restoreWorkspace);
  showSelectorFromWorkspace(window);
  window.close();
}

async function closeWorkspaceBeforeQuit(): Promise<boolean> {
  await localWorkspaceOpenPromise?.catch(() => undefined);
  await remoteWorkspaceOpenPromise?.catch(() => undefined);
  const window = workspaceWindow;
  if (!window || window.isDestroyed()) return true;
  const contents = window.webContents;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (closed: boolean): void => {
      if (settled) return;
      settled = true;
      contents.off("will-prevent-unload", handlePreventedUnload);
      window.off("closed", handleClosed);
      resolve(closed);
    };
    const handlePreventedUnload = (): void => finish(false);
    const handleClosed = (): void => finish(true);
    contents.once("will-prevent-unload", handlePreventedUnload);
    window.once("closed", handleClosed);
    window.close();
  });
}

async function prepareDesktopUpdateInstall(discardUnsaved: boolean): Promise<boolean> {
  await localWorkspaceOpenPromise?.catch(() => undefined);
  await remoteWorkspaceOpenPromise?.catch(() => undefined);
  const window = workspaceWindow;
  if (discardUnsaved && window && !window.isDestroyed() && activeWorkspaceKind === "remote") {
    window.destroy();
  } else if (!await closeWorkspaceBeforeQuit()) {
    return false;
  }
  quitAfterLocalShutdown = true;
  await localServerManager?.stop();
  return true;
}

async function testLocalAiProvider(providerId: string): Promise<{ ok: boolean; error: string | null }> {
  if (!localAiProviderStore || !localAiClient) throw new Error("Desktop 本地 AI 尚未就绪");
  const model = localAiProviderStore.listModels().find((item) => item.providerId === providerId && item.enabled);
  if (!model) {
    const error = new Error("请先为本地 AI 供应商添加并启用一个模型") as Error & { code: string };
    error.code = "LOCAL_AI_MODEL_REQUIRED";
    throw error;
  }
  try {
    await localAiClient.complete(localAiProviderStore.credential(model.id), {
      modelId: model.id,
      remoteSystemPrompt: "",
      messages: [{ role: "user", content: "请仅回复 OK。" }]
    });
    localAiProviderStore.markConnection(providerId, { ok: true });
    return { ok: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "本地 AI 连接测试失败";
    localAiProviderStore.markConnection(providerId, { ok: false, error: message });
    return { ok: false, error: message };
  }
}

function createWindow(environment: DesktopEnvironment, manager: LocalServerManager): void {
  const desktopVersion = resolveDesktopAppVersion({
    packaged: app.isPackaged,
    packagedVersion: app.getVersion(),
    applicationRoot
  });
  const serverVersion = resolveCompatibleServerVersion(applicationRoot);
  const profileStore = new ProfileStore(environment.paths.profiles);
  const secretStorage = createDesktopSecretStorage();
  remoteSyncStatusStore = new RemoteSyncStatusStore(environment.paths.syncStatus);
  offlineKeyStore = new OfflineKeyStore(environment.paths.offlineKeys, secretStorage);
  localAiProviderStore = new LocalAiProviderStore(environment.paths.localAiProviders, secretStorage);
  localAiClient = new LocalAiClient();
  localAiRequestCoordinator = new LocalAiRequestCoordinator(localAiProviderStore, localAiClient);
  const remoteAuth = new RemoteAuthCoordinator(
    environment.desktopId,
    desktopVersion,
    new RemoteAuthStore(environment.paths.remoteAuth, secretStorage),
    new RemoteAuthClient(),
    new RemoteSessionRegistry(),
    openRemoteWorkspace,
    (profile, user) => offlineKeyStore!.has(profile, user.userId)
  );
  remoteAuthCoordinator = remoteAuth;
  const remoteProbe = new RemoteServerProbe();
  mainWindow = createSelectorWindow(desktopRoot);
  app.setAboutPanelOptions({
    applicationName: "Scriverse Desktop",
    applicationVersion: desktopVersion,
    version: "",
    credits: `对应 Server 版本 ${serverVersion}`,
    copyright: "Copyright musnows"
  });
  if (!desktopUpdater) {
    desktopUpdater = new DesktopUpdater({
      version: desktopVersion,
      getParentWindow: () => workspaceWindow && !workspaceWindow.isDestroyed() ? workspaceWindow : mainWindow,
      getLeaveState: () => activeRemoteLeaveState,
      prepareInstall: prepareDesktopUpdateInstall
    });
    desktopUpdater.initialize();
  }
  installDesktopMenu({
    switchWorkspace: () => { void requestWorkspaceSwitch(); },
    reconnectWorkspace: () => {
      if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.webContents.reload();
    },
    openSyncCenter: () => {
      if (workspaceWindow && !workspaceWindow.isDestroyed() && activeWorkspaceKind === "remote") {
        workspaceWindow.webContents.send("workspace:shell:menu-command", "open-sync-center");
      }
    },
    find: () => {
      if (!workspaceWindow || workspaceWindow.isDestroyed()) return;
      const modifiers = [process.platform === "darwin" ? "meta" : "control"] as const;
      workspaceWindow.webContents.sendInputEvent({ type: "keyDown", keyCode: "F", modifiers: [...modifiers] });
      workspaceWindow.webContents.sendInputEvent({ type: "keyUp", keyCode: "F", modifiers: [...modifiers] });
    },
    openLogs: () => { void shell.openPath(environment.paths.logs); },
    showVersion: () => {
      void dialog.showMessageBox({
        type: "info",
        title: "Scriverse Desktop 版本",
        message: `Scriverse Desktop ${desktopVersion}`,
        detail: `对应 Server 版本 ${serverVersion}\nElectron ${process.versions.electron} · Node ${process.versions.node}`
      });
    },
    checkForUpdates: () => desktopUpdater?.check(false)
  });
  disposeSelectorIpc = registerSelectorIpc(mainWindow, profileStore, {
    desktopVersion,
    getLocalStatus: () => manager.getStatus(),
    getDesktopSettings: () => desktopSettingsStore!.get(),
    updateDesktopSettings: (input) => desktopSettingsStore!.update(input),
    openLocal: async () => {
      const ready = await manager.start();
      if (!ready.setupRequired) await openLocalWorkspace(ready.url);
    },
    setupLocal: async (input) => {
      const result = await manager.provision(input);
      await setLocalSessionCookie(result);
      await openLocalWorkspace(result.url);
      return result.user;
    },
    openRemote: (profile) => remoteAuth.open(profile),
    refreshRemoteChallenge: (profile) => remoteAuth.refreshChallenge(profile),
    loginRemote: (profile, input) => remoteAuth.login(profile, input),
    forgetRemote: async (profile) => {
      await remoteAuth.forget(profile);
      offlineKeyStore!.clearProfile(profile.id);
      remoteSyncStatusStore!.clear(profile);
    },
    getRemoteSyncStatus: (profile) => remoteSyncStatusStore!.summary(profile),
    probeRemote: (origin) => remoteProbe.probe(origin, desktopVersion),
    getLocalAiConfiguration: () => localAiProviderStore!.configuration(),
    updateLocalAiSystemPrompt: (input) => localAiProviderStore!.updateSystemPrompt(input),
    createLocalAiProvider: (input) => localAiProviderStore!.create(input),
    updateLocalAiProvider: (input) => localAiProviderStore!.update(input),
    removeLocalAiProvider: (providerId) => localAiProviderStore!.remove(providerId),
    createLocalAiModel: (input) => localAiProviderStore!.createModel(input),
    updateLocalAiModel: (input) => localAiProviderStore!.updateModel(input),
    removeLocalAiModel: (modelId) => localAiProviderStore!.removeModel(modelId),
    testLocalAiProvider
  });
  mainWindow.once("closed", () => {
    disposeSelectorIpc?.();
    disposeSelectorIpc = null;
    mainWindow = null;
  });
}

registerDesktopScheme();
app.enableSandbox();

if (handleSquirrelStartup()) {
  app.quit();
} else if (!runtimeGateRequested && !localServerGateRequested && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (!runtimeGateRequested) {
    try {
      desktopEnvironment = initializeDesktopEnvironment();
    } catch (error) {
      desktopStartupError = error;
    }
  }
  app.on("second-instance", () => {
    const target = workspaceWindow && !workspaceWindow.isDestroyed() ? workspaceWindow : mainWindow;
    if (!target) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  });
  app.whenReady().then(async () => {
    if (runtimeGateRequested) {
      await runRuntimeGate();
      return;
    }
    if (desktopStartupError) throw desktopStartupError;
    if (!desktopEnvironment) throw new Error("Desktop data paths are unavailable");
    desktopSettingsStore = new DesktopSettingsStore(desktopEnvironment.paths.desktopSettings);
    localServerManager = createLocalServerManager(desktopEnvironment, desktopSettingsStore);
    if (localServerGateRequested) {
      await runLocalServerGate(localServerManager);
      return;
    }
    registerSelectorProtocol(join(desktopRoot, "renderer"));
    createWindow(desktopEnvironment, localServerManager);
  }).catch((error: unknown) => {
    process.stderr.write(`Desktop startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  });
  app.on("activate", () => {
    if (
      !runtimeGateRequested
      && !localServerGateRequested
      && desktopEnvironment
      && localServerManager
      && BrowserWindow.getAllWindows().length === 0
    ) createWindow(desktopEnvironment, localServerManager);
  });
  app.on("before-quit", (event) => {
    if (runtimeGateRequested || localServerGateRequested || quitAfterLocalShutdown || !localServerManager) return;
    const phase = localServerManager.getStatus().phase;
    if (phase === "stopped") return;
    event.preventDefault();
    quitAfterLocalShutdown = true;
    void closeWorkspaceBeforeQuit().then(async (closed) => {
      if (!closed) {
        quitAfterLocalShutdown = false;
        return;
      }
      await localServerManager?.stop();
      app.quit();
    });
  });
  app.on("will-quit", () => desktopUpdater?.dispose());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
