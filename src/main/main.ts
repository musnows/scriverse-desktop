import { app, BrowserWindow, dialog, shell, utilityProcess, type Session, type UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerDesktopScheme, registerSelectorProtocol } from "./app-protocol.js";
import { resolveCompatibleServerVersion, resolveDesktopAppVersion } from "./app-version.js";
import { DESKTOP_DISPLAY_NAME } from "../shared/branding.js";
import { initializeDesktopEnvironment, type DesktopEnvironment } from "./desktop-environment.js";
import {
  developmentIsolationError,
  resolveDevelopmentLocalServerPort
} from "./development-isolation.js";
import { LocalServerManager } from "./local-server-manager.js";
import { ProfileStore } from "./profile-store.js";
import { registerSelectorIpc } from "./selector-ipc.js";
import { createSelectorWindow } from "./selector-window.js";
import { createLocalWorkspaceWindow } from "./workspace-window.js";
import { createRemoteWorkspaceWindow } from "./remote-workspace-window.js";
import { RemoteAuthClient } from "./remote-auth-client.js";
import { RemoteAuthCoordinator } from "./remote-auth-coordinator.js";
import { RemoteAuthStore } from "./remote-auth-store.js";
import { CredentialVault, loadMasterSecret } from "./credential-vault.js";
import { LocalAuthStore, LocalAuthStoreError, type StoredLocalCredential } from "./local-auth-store.js";
import { LocalSessionPolicy } from "./local-session-policy.js";
import { RemoteSessionRegistry } from "./remote-session-policy.js";
import { RemoteSyncStatusStore } from "./remote-sync-status-store.js";
import { RemoteServerProbe } from "./remote-server-probe.js";
import { LocalAiProviderStore } from "./local-ai-provider-store.js";
import { LocalAiClient } from "./local-ai-client.js";
import { LocalAiRequestCoordinator } from "./local-ai-request-coordinator.js";
import { registerLocalWorkspaceIpc } from "./local-workspace-ipc.js";
import { registerWorkspaceIpc } from "./workspace-ipc.js";
import { ExternalUrlNavigationController } from "./external-url-navigation.js";
import { registerDownloadPolicy } from "./download-policy.js";
import { installDesktopMenu } from "./native-menu.js";
import { DesktopUpdater } from "./desktop-updater.js";
import { handleSquirrelStartup } from "./squirrel-startup.js";
import { applyWindowPlacement, captureWindowPlacement } from "./window-placement.js";
import { DesktopSettingsStore } from "./desktop-settings-store.js";
import { BackgroundTray } from "./background-tray.js";
import { installDesktopProcessLogging, type DesktopProcessLogging } from "./desktop-file-logger.js";
import { REMOTE_MEDIA_REFRESH_INTERVAL_MS, RemoteMediaCache, formatRemoteMediaBytes } from "./remote-media-cache.js";
import { LOCAL_PROFILE_ID, type RemoteWorkspaceProfile } from "../shared/contracts.js";
import { desktopLogStorageLimitBytes } from "../shared/desktop-settings-contract.js";
import { parseRemoteSessionResponse, type RemoteAuthUser } from "../shared/remote-auth-contract.js";
import type { WorkspaceLeaveState } from "../shared/workspace-contract.js";
import { LOCAL_EXTERNAL_URL_REQUEST_CHANNEL, SELECTOR_EXTERNAL_URL_REQUEST_CHANNEL } from "../shared/external-url-contract.js";

type RuntimeGateResult = {
  ok: boolean;
  electronVersion: string;
  nodeVersion: string;
  sqlite: boolean;
  sharp: boolean;
  vditor: boolean;
  localServer: boolean;
  localServerSkipped?: boolean;
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
let desktopEnvironmentInitialized = false;
let desktopStartupError: unknown = null;
let disposeSelectorIpc: (() => void) | null = null;
let disposeWorkspaceIpc: (() => void) | null = null;
let disposeWorkspaceDownloadPolicy: (() => void) | null = null;
let disposeRemoteAvatarRefresh: (() => void) | null = null;
let localServerManager: LocalServerManager | null = null;
let desktopSettingsStore: DesktopSettingsStore | null = null;
let remoteAuthCoordinator: RemoteAuthCoordinator | null = null;
let remoteSyncStatusStore: RemoteSyncStatusStore | null = null;
let localAuthStore: LocalAuthStore | null = null;
let localSessionPolicy: LocalSessionPolicy | null = null;
let localAiProviderStore: LocalAiProviderStore | null = null;
let localAiClient: LocalAiClient | null = null;
let localAiRequestCoordinator: LocalAiRequestCoordinator | null = null;
let desktopUpdater: DesktopUpdater | null = null;
let backgroundTray: BackgroundTray | null = null;
let desktopProcessLogging: DesktopProcessLogging | null = null;
let remoteMediaCache: RemoteMediaCache | null = null;
let quitAfterLocalShutdown = false;
let desktopQuitConfirmed = false;
let allowWorkspaceWindowClose = false;
let localWorkspaceOpenPromise: Promise<void> | null = null;
let remoteWorkspaceOpenPromise: Promise<void> | null = null;
let activeWorkspaceKind: "local" | "remote" | null = null;
let activeRemoteProfileId: string | null = null;
const externalUrlNavigation = new ExternalUrlNavigationController();
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
      ?? join(app.getPath("userData"), "runtime-gate"),
    SCRIVERSE_DESKTOP_GATE_SKIP_LOCAL_SERVER: process.env.SCRIVERSE_DESKTOP_GATE_SKIP_LOCAL_SERVER === "true" ? "true" : "false"
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

function initializeDesktopRuntime(): void {
  if (runtimeGateRequested || desktopEnvironmentInitialized) return;
  try {
    desktopEnvironment = initializeDesktopEnvironment();
    desktopProcessLogging = installDesktopProcessLogging(desktopEnvironment.paths.logs);
    desktopSettingsStore = new DesktopSettingsStore(desktopEnvironment.paths.desktopSettings);
    void desktopProcessLogging.logger.setTotalMaxBytes(desktopLogStorageLimitBytes(desktopSettingsStore.get().logStorageLimitMiB));
    process.stderr.write("Desktop file logging initialized\n");
    remoteMediaCache = new RemoteMediaCache(desktopEnvironment.paths.remoteMedia);
  } catch (error) {
    desktopStartupError = error;
  } finally {
    desktopEnvironmentInitialized = true;
  }
}

function requestDesktopSingleInstanceLock(): boolean {
  if (runtimeGateRequested || localServerGateRequested) return true;
  initializeDesktopRuntime();
  return app.requestSingleInstanceLock();
}

function createLocalServerManager(environment: DesktopEnvironment, settings: DesktopSettingsStore): LocalServerManager {
  return new LocalServerManager({
    paths: environment.paths,
    desktopId: environment.desktopId,
    desktopVersion: resolveDesktopAppVersion({
      packaged: app.isPackaged,
      packagedVersion: app.getVersion(),
      applicationRoot
    }),
    applicationRoot,
    desktopRoot,
    utilityWorkingDirectory,
    getPreferredPort: () => resolveDevelopmentLocalServerPort(process.env, app.isPackaged) ?? settings.get().localServerPort
  });
}

async function runLocalServerGate(manager: LocalServerManager): Promise<void> {
  try {
    const ready = await manager.start();
    let provisioned = false;
    let userRole: string | null = null;
    let duplicateProvisionRejected = false;
    let setupRequiredAfter = ready.setupRequired;
    let bearerVerified = false;
    let workspaceLoaded = false;
    if (localProvisionGateRequested && ready.setupRequired) {
      const provision = await manager.provision({
        username: "desktop_gate_admin",
        password: `desktop-gate-${randomUUID()}-A1`
      });
      const gateSessionPolicy = new LocalSessionPolicy();
      gateSessionPolicy.authorize(provision.url, provision.token);
      const sessionState = await fetch(`${provision.url}/api/auth/session`, {
        headers: { Authorization: `Bearer ${provision.token}` },
        redirect: "error"
      }).then((response) => response.json()) as { data?: { authenticated?: unknown; user?: { userId?: unknown } } };
      if (sessionState.data?.authenticated !== true || sessionState.data.user?.userId !== provision.user.userId) {
        throw new Error("Local provision gate session verification failed");
      }
      bearerVerified = true;
      const gateWindow = await createLocalWorkspaceWindow({
        origin: provision.url,
        desktopRoot,
        onReady: () => undefined,
        onClosed: () => undefined,
        enableLocalAiBridge: false,
        onExternalUrlRequest: () => false,
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
      bearerVerified,
      workspaceLoaded,
      stopped: manager.getStatus().phase === "stopped"
    })}\n`);
    await desktopProcessLogging?.logger.flush();
    app.exit(0);
  } catch (error) {
    await manager.stop();
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })}\n`);
    await desktopProcessLogging?.logger.flush();
    app.exit(1);
  }
}

function showSelectorFromWorkspace(window: BrowserWindow): void {
  const selector = mainWindow;
  if (!selector || selector.isDestroyed() || window.isDestroyed()) return;
  applyWindowPlacement(selector, captureWindowPlacement(window));
  if (process.platform === "darwin" && app.dock) void app.dock.show();
  selector.show();
  selector.focus();
  window.hide();
}

function updateBackgroundTrayStatus(): void {
  backgroundTray?.update({ localServerRunning: localServerManager?.getStatus().phase === "running" });
}

function startRemoteAvatarRefresh(window: BrowserWindow, profile: RemoteWorkspaceProfile, userId: string): () => void {
  if (!remoteMediaCache) return () => undefined;
  let running = false;
  const refresh = async (): Promise<void> => {
    if (running || window.isDestroyed()) return;
    running = true;
    try {
      await remoteMediaCache!.refreshLoggedInUserAvatar(window.webContents.session, profile, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      process.stderr.write(`Remote user avatar refresh failed for profile ${profile.id}: ${message}\n`);
    } finally {
      running = false;
    }
  };
  void refresh();
  const timer = setInterval(() => { void refresh(); }, REMOTE_MEDIA_REFRESH_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function confirmAndCacheWorkImages(window: BrowserWindow, profile: RemoteWorkspaceProfile, workId: string): Promise<unknown> {
  if (!remoteMediaCache) throw new Error("Desktop 图片缓存尚未就绪");
  const summary = await remoteMediaCache.describeWorkImages(window.webContents.session, profile, workId);
  if (summary.imageCount === 0) return { status: "empty", summary };
  const detail = summary.alreadyCachedCount > 0
    ? `共 ${summary.imageCount} 张作品图片，其中 ${summary.alreadyCachedCount} 张已在本地缓存。本次预计新增 ${formatRemoteMediaBytes(summary.additionalBytes)}。`
    : `共 ${summary.imageCount} 张作品图片，预计新增 ${formatRemoteMediaBytes(summary.additionalBytes)}。`;
  const result = await dialog.showMessageBox(window, {
    type: "question",
    title: "下载作品图片",
    message: `“${summary.title}”包含 ${summary.imageCount} 张作品图片`,
    detail: `${detail}\n\n封面已直接保存到本地。是否下载作品内图片以支持离线查看？`,
    buttons: ["暂不下载", "下载图片"],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  });
  if (result.response !== 1) return { status: "declined", summary };
  const downloaded = await remoteMediaCache.downloadWorkImages(window.webContents.session, profile, workId);
  return { status: "downloaded", ...downloaded };
}

function showDesktopWindow(): void {
  if (process.platform === "darwin" && app.dock) void app.dock.show();
  const target = workspaceWindow && !workspaceWindow.isDestroyed() ? workspaceWindow : mainWindow;
  if (!target || target.isDestroyed()) return;
  if (target.isMinimized()) target.restore();
  target.show();
  target.focus();
  if (target === workspaceWindow) mainWindow?.hide();
}

function requestDesktopQuitConfirmation(): void {
  if (desktopQuitConfirmed) {
    app.quit();
    return;
  }
  const activeWorkspace = workspaceWindow && !workspaceWindow.isDestroyed() ? workspaceWindow : null;
  const selector = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  const target = activeWorkspace ?? selector;
  if (!target) {
    app.quit();
    return;
  }
  showDesktopWindow();
  if (target === activeWorkspace) target.webContents.send("workspace:shell:menu-command", "request-quit");
  else target.webContents.send("selector:app:request-quit");
}

function confirmDesktopQuit(): void {
  desktopQuitConfirmed = true;
  app.quit();
}

function hideDesktopToBackground(): void {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.hide();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  if (process.platform === "darwin" && app.dock) app.dock.hide();
  updateBackgroundTrayStatus();
}

async function clearDesktopCachesAndReload(): Promise<void> {
  const target = workspaceWindow && !workspaceWindow.isDestroyed() ? workspaceWindow : mainWindow;
  const options = {
    type: "warning" as const,
    title: "清理缓存并强制刷新",
    message: "确认清理缓存并刷新当前工作区？",
    detail: "尚未保存的页面输入可能丢失。登录状态、离线作品和待同步数据不会被删除。",
    buttons: ["取消", "清理并刷新"],
    defaultId: 1,
    cancelId: 0,
    noLink: true
  };
  const confirmation = target
    ? await dialog.showMessageBox(target, options)
    : await dialog.showMessageBox(options);
  if (confirmation.response !== 1) return;
  const sessions = new Set<Session>();
  if (mainWindow && !mainWindow.isDestroyed()) sessions.add(mainWindow.webContents.session);
  if (workspaceWindow && !workspaceWindow.isDestroyed()) sessions.add(workspaceWindow.webContents.session);
  await Promise.all([...sessions].flatMap((activeSession) => [
    activeSession.clearCache(),
    activeSession.clearCodeCaches({ urls: [] })
  ]));
  if (!target || target.isDestroyed()) return;
  target.webContents.reloadIgnoringCache();
  showDesktopWindow();
}

function bindWorkspaceReplacement(window: BrowserWindow): void {
  window.on("close", (event) => {
    if (quitAfterLocalShutdown || allowWorkspaceWindowClose) return;
    event.preventDefault();
    hideDesktopToBackground();
  });
}

function readLocalCredential(): StoredLocalCredential | null {
  if (!localAuthStore) throw new Error("Desktop 本地登录存储尚未就绪");
  try {
    return localAuthStore.load();
  } catch (error) {
    if (error instanceof LocalAuthStoreError && (error.code === "LOCAL_AUTH_DECRYPT_FAILED" || error.code === "LOCAL_AUTH_STORE_INVALID")) {
      localAuthStore.clear();
      return null;
    }
    throw error;
  }
}

async function validateLocalCredential(origin: string, credential: StoredLocalCredential): Promise<RemoteAuthUser | null> {
  const response = await fetch(`${origin}/api/auth/session`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${credential.token}` },
    cache: "no-store",
    credentials: "omit",
    redirect: "error"
  });
  if (!response.ok) return null;
  const state = parseRemoteSessionResponse(await response.json());
  return state.authenticated && state.user?.userId === credential.user.userId ? state.user : null;
}

async function openStoredLocalWorkspace(origin: string): Promise<{ status: "opened" | "login-required"; mode?: "online" }> {
  if (!localAuthStore || !localSessionPolicy) throw new Error("Desktop 本地登录尚未就绪");
  const credential = readLocalCredential();
  if (!credential || Date.parse(credential.expiresAt) <= Date.now()) {
    if (credential) localAuthStore.clear();
    localSessionPolicy.clear();
    return { status: "login-required" };
  }
  const user = await validateLocalCredential(origin, credential);
  if (!user) {
    localAuthStore.clear();
    localSessionPolicy.clear();
    return { status: "login-required" };
  }
  localSessionPolicy.authorize(origin, credential.token);
  await openLocalWorkspace(origin);
  return { status: "opened", mode: "online" };
}

function openLocalWorkspace(origin: string): Promise<void> {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) {
    if (workspaceWindow.isMinimized()) workspaceWindow.restore();
    workspaceWindow.focus();
    mainWindow?.hide();
    return Promise.resolve();
  }
  if (localWorkspaceOpenPromise) return localWorkspaceOpenPromise;
  if (!localAiRequestCoordinator) return Promise.reject(new Error("Desktop AI 供应商尚未就绪"));
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
        confirmQuit: confirmDesktopQuit,
        logout: async () => {
          localAuthStore?.clear();
          localSessionPolicy?.clear();
          showSelectorFromWorkspace(window);
          window.destroy();
        },
        getLocalAiCatalog: () => localAiRequestCoordinator!.catalog(),
        completeLocalAi: (input, onEvent) => localAiRequestCoordinator!.complete(input, onEvent),
        cancelLocalAi: (requestId) => localAiRequestCoordinator!.cancel(requestId),
        completeLocalAiAgentRound: (input, onEvent) => localAiRequestCoordinator!.completeAgentRound(input, onEvent),
        cancelLocalAiAgentRound: (requestId) => localAiRequestCoordinator!.cancelAgentRound(requestId),
        openExternalUrl: (input) => externalUrlNavigation.respond(window, input)
      });
    },
    onReady: () => mainWindow?.hide(),
    onExternalUrlRequest: (requestWindow, target) => externalUrlNavigation.request(requestWindow, target, LOCAL_EXTERNAL_URL_REQUEST_CHANNEL),
    onClosed: () => {
      disposeWorkspaceDownloadPolicy?.();
      disposeWorkspaceDownloadPolicy = null;
      disposeWorkspaceIpc?.();
      disposeWorkspaceIpc = null;
      localAiRequestCoordinator?.cancelAll();
      const closedWorkspace = workspaceWindow;
      workspaceWindow = null;
      if (closedWorkspace) externalUrlNavigation.dispose(closedWorkspace);
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
  if (!remoteAuthCoordinator || !remoteSyncStatusStore || !localAiRequestCoordinator) return Promise.reject(new Error("Desktop 离线存储尚未就绪"));
  activeWorkspaceKind = "remote";
  activeRemoteProfileId = profile.id;
  const cachedUser = remoteAuthCoordinator.cachedUser(profile);
  if (!cachedUser) return Promise.reject(new Error("当前 Desktop 登录不可用于远端图片缓存"));
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
    remoteMediaCache: remoteMediaCache ?? undefined,
    remoteUserId: cachedUser.userId,
    ...(mainWindow && !mainWindow.isDestroyed() ? { placement: captureWindowPlacement(mainWindow) } : {}),
    onExternalUrlRequest: (requestWindow, target) => externalUrlNavigation.request(requestWindow, target),
    onCreated: (window) => {
      workspaceWindow = window;
      disposeWorkspaceDownloadPolicy?.();
      disposeWorkspaceDownloadPolicy = registerDownloadPolicy(window.webContents.session, () => workspaceWindow === window ? window : null);
      disposeRemoteAvatarRefresh?.();
      disposeRemoteAvatarRefresh = connectionMode === "online"
        ? startRemoteAvatarRefresh(window, profile, cachedUser.userId)
        : null;
      bindWorkspaceReplacement(window);
      disposeWorkspaceIpc = registerWorkspaceIpc(window, profile, {
        activeProfileId: () => activeRemoteProfileId,
        getCachedUser: () => remoteAuthCoordinator!.cachedUser(profile),
        getConnectionMode: () => remoteAuthCoordinator!.connectionMode(profile),
        getLocalAiCatalog: () => localAiRequestCoordinator!.catalog(),
        completeLocalAi: (_userId, input, onEvent) => localAiRequestCoordinator!.complete(input, onEvent),
        cancelLocalAi: (_userId, requestId) => localAiRequestCoordinator!.cancel(requestId),
        completeLocalAiAgentRound: (_userId, input, onEvent) => localAiRequestCoordinator!.completeAgentRound(input, onEvent),
        cancelLocalAiAgentRound: (_userId, requestId) => localAiRequestCoordinator!.cancelAgentRound(requestId),
        cacheWorkCover: async (_userId, workId) => {
          if (!remoteMediaCache) throw new Error("Desktop 图片缓存尚未就绪");
          return remoteMediaCache.cacheWorkCover(window.webContents.session, profile, workId);
        },
        cacheWorkImages: (_userId, workId) => confirmAndCacheWorkImages(window, profile, workId),
        reportLeaveState: (state) => {
          activeRemoteLeaveState = state;
          const user = remoteAuthCoordinator!.cachedUser(profile);
          if (user) remoteSyncStatusStore!.update(profile, user.userId, state);
        },
        requestSwitch: requestWorkspaceSwitch,
        confirmQuit: confirmDesktopQuit,
        openExternalUrl: (input) => externalUrlNavigation.respond(window, input)
      });
    },
    onReady: () => mainWindow?.hide(),
    onClosed: () => {
      disposeWorkspaceDownloadPolicy?.();
      disposeWorkspaceDownloadPolicy = null;
      disposeRemoteAvatarRefresh?.();
      disposeRemoteAvatarRefresh = null;
      disposeWorkspaceIpc?.();
      disposeWorkspaceIpc = null;
      localAiRequestCoordinator?.cancelAll();
      const closedWorkspace = workspaceWindow;
      workspaceWindow = null;
      if (closedWorkspace) externalUrlNavigation.dispose(closedWorkspace);
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
    allowWorkspaceWindowClose = false;
    if (window.isDestroyed()) return;
    mainWindow?.hide();
    window.show();
    window.focus();
  };
  window.webContents.once("will-prevent-unload", restoreWorkspace);
  window.once("closed", () => {
    allowWorkspaceWindowClose = false;
  });
  allowWorkspaceWindowClose = true;
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
  if (!localAiProviderStore || !localAiClient) throw new Error("Desktop AI 供应商尚未就绪");
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
  const credentialVault = new CredentialVault(loadMasterSecret(environment.paths.desktopMasterKey));
  remoteSyncStatusStore = new RemoteSyncStatusStore(environment.paths.syncStatus);
  localAuthStore = new LocalAuthStore(environment.paths.localAuth, credentialVault);
  localSessionPolicy = new LocalSessionPolicy();
  localAiProviderStore = new LocalAiProviderStore(environment.paths.localAiProviders, credentialVault);
  localAiClient = new LocalAiClient();
  localAiRequestCoordinator = new LocalAiRequestCoordinator(localAiProviderStore, localAiClient);
  const remoteAuth = new RemoteAuthCoordinator(
    environment.desktopId,
    desktopVersion,
    new RemoteAuthStore(environment.paths.remoteAuth, credentialVault),
    new RemoteAuthClient(),
    new RemoteSessionRegistry(),
    openRemoteWorkspace,
    (profile, user) => remoteSyncStatusStore!.user(profile, user.userId) !== null
  );
  remoteAuthCoordinator = remoteAuth;
  const remoteProbe = new RemoteServerProbe();
  const openLogsDirectory = async (): Promise<boolean> => {
    const error = await shell.openPath(environment.paths.logs);
    if (error !== "") {
      const openError = new Error("无法打开日志目录") as Error & { code: string };
      openError.code = "DESKTOP_LOG_DIRECTORY_OPEN_FAILED";
      throw openError;
    }
    return true;
  };
  mainWindow = createSelectorWindow(desktopRoot, {
    onExternalUrlRequest: (requestWindow, target) => externalUrlNavigation.request(requestWindow, target, SELECTOR_EXTERNAL_URL_REQUEST_CHANNEL)
  });
  mainWindow.on("close", (event) => {
    if (quitAfterLocalShutdown) return;
    event.preventDefault();
    hideDesktopToBackground();
  });
  if (!backgroundTray) {
    backgroundTray = new BackgroundTray(join(desktopRoot, "assets", "icon-32.png"), {
      show: showDesktopWindow,
      refresh: () => clearDesktopCachesAndReload().catch((error) => {
        dialog.showErrorBox("刷新失败", error instanceof Error ? error.message : "缓存清理失败");
      }),
      requestQuit: requestDesktopQuitConfirmation
    });
  }
  updateBackgroundTrayStatus();
  app.setAboutPanelOptions({
    applicationName: DESKTOP_DISPLAY_NAME,
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
    requestQuit: requestDesktopQuitConfirmation,
    find: () => {
      if (!workspaceWindow || workspaceWindow.isDestroyed()) return;
      const modifiers = [process.platform === "darwin" ? "meta" : "control"] as const;
      workspaceWindow.webContents.sendInputEvent({ type: "keyDown", keyCode: "F", modifiers: [...modifiers] });
      workspaceWindow.webContents.sendInputEvent({ type: "keyUp", keyCode: "F", modifiers: [...modifiers] });
    },
    openLogs: () => {
      void openLogsDirectory().catch((error) => {
        dialog.showErrorBox("打开日志目录失败", error instanceof Error ? error.message : "无法打开日志目录");
      });
    },
    showVersion: () => {
      void dialog.showMessageBox({
        type: "info",
        title: `${DESKTOP_DISPLAY_NAME}版本`,
        message: `${DESKTOP_DISPLAY_NAME} ${desktopVersion}`,
        detail: `对应 Server 版本 ${serverVersion}\nElectron ${process.versions.electron} · Node ${process.versions.node}`
      });
    },
    checkForUpdates: () => desktopUpdater?.check(false)
  });
  disposeSelectorIpc = registerSelectorIpc(mainWindow, profileStore, {
    desktopVersion,
    getLocalStatus: () => manager.getStatus(),
    getDesktopSettings: () => desktopSettingsStore!.get(),
    updateDesktopSettings: async (input) => {
      const settings = desktopSettingsStore!.update(input);
      await desktopProcessLogging?.logger.setTotalMaxBytes(desktopLogStorageLimitBytes(settings.logStorageLimitMiB));
      return settings;
    },
    openLogs: openLogsDirectory,
    openLocal: async () => {
      const ready = await manager.start();
      updateBackgroundTrayStatus();
      if (ready.setupRequired) return { status: "setup-required" as const };
      return openStoredLocalWorkspace(ready.url);
    },
    setupLocal: async (input) => {
      const result = await manager.provision(input);
      updateBackgroundTrayStatus();
      localAuthStore!.save(result);
      localSessionPolicy!.authorize(result.url, result.token);
      await openLocalWorkspace(result.url);
      return result.user;
    },
    loginLocal: async (input) => {
      const result = await manager.login(input);
      updateBackgroundTrayStatus();
      localAuthStore!.save(result);
      localSessionPolicy!.authorize(result.url, result.token);
      await openLocalWorkspace(result.url);
      return result.user;
    },
    openRemote: (profile) => remoteAuth.open(profile),
    refreshRemoteChallenge: (profile) => remoteAuth.refreshChallenge(profile),
    loginRemote: (profile, input) => remoteAuth.login(profile, input),
    forgetRemote: async (profile) => {
      await remoteAuth.forget(profile);
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
    testLocalAiProvider,
    requestQuit: requestDesktopQuitConfirmation,
    confirmQuit: confirmDesktopQuit,
    openExternalUrl: (input) => externalUrlNavigation.respond(mainWindow!, input)
  });
  mainWindow.once("closed", () => {
    const closedWindow = mainWindow;
    if (closedWindow) externalUrlNavigation.dispose(closedWindow);
    disposeSelectorIpc?.();
    disposeSelectorIpc = null;
    mainWindow = null;
  });
}

registerDesktopScheme();
app.enableSandbox();
const startupIsolationError = developmentIsolationError({ env: process.env, packaged: app.isPackaged, runtimeGateRequested });

if (handleSquirrelStartup()) {
  app.quit();
} else if (startupIsolationError) {
  process.stderr.write(`Desktop startup refused: ${startupIsolationError}\n`);
  app.exit(1);
} else if (!requestDesktopSingleInstanceLock()) {
  app.quit();
} else {
  initializeDesktopRuntime();
  app.on("second-instance", () => {
    showDesktopWindow();
  });
  app.whenReady().then(async () => {
    if (runtimeGateRequested) {
      await runRuntimeGate();
      return;
    }
    if (desktopStartupError) throw desktopStartupError;
    if (!desktopEnvironment || !desktopSettingsStore) throw new Error("Desktop data paths are unavailable");
    localServerManager = createLocalServerManager(desktopEnvironment, desktopSettingsStore);
    if (localServerGateRequested) {
      await runLocalServerGate(localServerManager);
      return;
    }
    registerSelectorProtocol(join(desktopRoot, "renderer"));
    createWindow(desktopEnvironment, localServerManager);
  }).catch(async (error: unknown) => {
    process.stderr.write(`Desktop startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    await desktopProcessLogging?.logger.flush();
    app.exit(1);
  });
  app.on("activate", () => {
    if (runtimeGateRequested || localServerGateRequested || !desktopEnvironment || !localServerManager) return;
    if (BrowserWindow.getAllWindows().length === 0) createWindow(desktopEnvironment, localServerManager);
    else showDesktopWindow();
  });
  app.on("before-quit", (event) => {
    if (runtimeGateRequested || localServerGateRequested || !localServerManager || quitAfterLocalShutdown) return;
    if (!desktopQuitConfirmed) {
      event.preventDefault();
      requestDesktopQuitConfirmation();
      return;
    }
    quitAfterLocalShutdown = true;
    const phase = localServerManager.getStatus().phase;
    if (phase === "stopped") return;
    event.preventDefault();
    void closeWorkspaceBeforeQuit().then(async (closed) => {
      if (!closed) {
        quitAfterLocalShutdown = false;
        desktopQuitConfirmed = false;
        return;
      }
      await localServerManager?.stop();
      app.quit();
    });
  });
  app.on("will-quit", (event) => {
    const processLogging = desktopProcessLogging;
    if (processLogging) {
      event.preventDefault();
      desktopProcessLogging = null;
      void processLogging.dispose().finally(() => app.quit());
      return;
    }
    desktopUpdater?.dispose();
    backgroundTray?.dispose();
    backgroundTray = null;
  });
  app.on("window-all-closed", () => {
    // 后台模式由菜单栏或系统托盘继续承载，不因窗口关闭而退出。
  });
}
