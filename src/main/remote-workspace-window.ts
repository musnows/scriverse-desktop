import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import type { RemoteWorkspaceProfile } from "../shared/contracts.js";
import { isAllowedRemoteWorkspaceNavigation } from "../shared/remote-workspace-url.js";
import { registerBundledOfflineShell } from "./offline-shell-protocol.js";

export async function createRemoteWorkspaceWindow(options: {
  profile: RemoteWorkspaceProfile;
  connectionMode: "online" | "offline";
  onReady: () => void;
  onClosed: () => void;
  desktopRoot: string;
  offlineShellRoot: string;
  onCreated?: (window: BrowserWindow) => void;
  show?: boolean;
}): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1_320,
    height: 840,
    minWidth: 390,
    minHeight: 600,
    show: false,
    title: `${options.profile.name} - Scriverse Desktop`,
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
  options.onCreated?.(window);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event, target) => {
    if (!isAllowedRemoteWorkspaceNavigation(target, options.profile.origin)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, target) => {
    if (!isAllowedRemoteWorkspaceNavigation(target, options.profile.origin)) event.preventDefault();
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (isMainFrame) process.stderr.write(`Remote workspace load failed for profile ${options.profile.id} (${errorCode}): ${errorDescription}\n`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    process.stderr.write(`Remote workspace renderer stopped for profile ${options.profile.id}: ${details.reason}\n`);
  });
  window.once("ready-to-show", () => {
    options.onReady();
    if (options.show !== false) window.show();
  });
  let disposeOfflineShell: (() => void) | null = null;
  window.once("closed", () => {
    disposeOfflineShell?.();
    options.onClosed();
  });
  try {
    if (options.connectionMode === "offline") {
      disposeOfflineShell = registerBundledOfflineShell(
        window.webContents.session,
        options.profile.origin,
        options.offlineShellRoot
      );
    }
    await window.loadURL(options.profile.origin);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Remote workspace startup failed for profile ${options.profile.id}: ${message}\n`);
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  return window;
}
