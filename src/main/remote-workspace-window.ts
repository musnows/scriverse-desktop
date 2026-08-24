import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { DESKTOP_DISPLAY_NAME } from "../shared/branding.js";
import type { RemoteWorkspaceProfile } from "../shared/contracts.js";
import { isAllowedRemoteWorkspaceNavigation } from "../shared/remote-workspace-url.js";
import { registerBundledWorkspaceShell, remoteWorkspaceShellUrl } from "./workspace-shell-protocol.js";
import { createWorkspaceLoadingCover } from "./workspace-loading-cover.js";
import { applyWindowPlacement, type DesktopWindowPlacement } from "./window-placement.js";

export async function createRemoteWorkspaceWindow(options: {
  profile: RemoteWorkspaceProfile;
  connectionMode: "online" | "offline";
  onReady: () => void;
  onClosed: () => void;
  desktopRoot: string;
  offlineShellRoot: string;
  placement?: DesktopWindowPlacement;
  onCreated?: (window: BrowserWindow) => void;
  show?: boolean;
}): Promise<BrowserWindow> {
  const shellUrl = remoteWorkspaceShellUrl(options.profile.id);
  const window = new BrowserWindow({
    width: 1_320,
    height: 840,
    minWidth: 390,
    minHeight: 600,
    ...(options.placement?.bounds ?? {}),
    show: false,
    title: `${options.profile.name} - ${DESKTOP_DISPLAY_NAME}`,
    backgroundColor: "#f3efe7",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(options.desktopRoot, "preload", "workspace-preload.cjs"),
      partition: options.profile.partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: !app.isPackaged
    }
  });
  const loadingCover = createWorkspaceLoadingCover(window);
  options.onCreated?.(window);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, target) => {
    if (!isAllowedRemoteWorkspaceNavigation(target, shellUrl)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, target) => {
    if (!isAllowedRemoteWorkspaceNavigation(target, shellUrl)) event.preventDefault();
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (isMainFrame) process.stderr.write(`Remote workspace load failed for profile ${options.profile.id} (${errorCode}): ${errorDescription}\n`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    process.stderr.write(`Remote workspace renderer stopped for profile ${options.profile.id}: ${details.reason}\n`);
  });
  window.once("ready-to-show", () => {
    void loadingCover.prepare().catch(() => undefined).finally(() => {
      if (window.isDestroyed()) return;
      if (options.placement) applyWindowPlacement(window, options.placement);
      if (options.show !== false) window.show();
      options.onReady();
      void loadingCover.revealWhenReady();
    });
  });
  let disposeWorkspaceShell: (() => void) | null = null;
  window.once("closed", () => {
    loadingCover.dispose();
    disposeWorkspaceShell?.();
    options.onClosed();
  });
  try {
    disposeWorkspaceShell = registerBundledWorkspaceShell(
      window.webContents.session,
      options.profile,
      options.offlineShellRoot,
      options.connectionMode
    );
    await window.loadURL(shellUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Remote workspace startup failed for profile ${options.profile.id}: ${message}\n`);
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  return window;
}
