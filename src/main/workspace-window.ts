import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { DESKTOP_DISPLAY_NAME } from "../shared/branding.js";
import { LOCAL_PROFILE_PARTITION } from "../shared/contracts.js";
import { isAllowedWorkspaceNavigation, normalizeLocalWorkspaceOrigin } from "../shared/workspace-url.js";
import { createWorkspaceLoadingCover } from "./workspace-loading-cover.js";
import { applyWindowPlacement, type DesktopWindowPlacement } from "./window-placement.js";

export async function createLocalWorkspaceWindow(options: {
  origin: string;
  desktopRoot: string;
  onReady: () => void;
  onClosed: () => void;
  onCreated?: (window: BrowserWindow) => void;
  enableLocalAiBridge?: boolean;
  placement?: DesktopWindowPlacement;
  show?: boolean;
}): Promise<BrowserWindow> {
  const origin = normalizeLocalWorkspaceOrigin(options.origin);
  const window = new BrowserWindow({
    width: 1_320,
    height: 840,
    minWidth: 390,
    minHeight: 600,
    ...(options.placement?.bounds ?? {}),
    show: false,
    title: `本地工作区 - ${DESKTOP_DISPLAY_NAME}`,
    backgroundColor: "#f3efe7",
    autoHideMenuBar: true,
    webPreferences: {
      ...(options.enableLocalAiBridge === false ? {} : { preload: join(options.desktopRoot, "preload", "local-workspace-preload.cjs") }),
      partition: LOCAL_PROFILE_PARTITION,
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
  const workspaceSession = window.webContents.session;
  workspaceSession.setPermissionCheckHandler(() => false);
  workspaceSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => {
    if (!isAllowedWorkspaceNavigation(target, origin)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, target) => {
    if (!isAllowedWorkspaceNavigation(target, origin)) event.preventDefault();
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
    if (isMainFrame) process.stderr.write(`Local workspace load failed (${errorCode}): ${errorDescription}\n`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    process.stderr.write(`Local workspace renderer stopped: ${details.reason}\n`);
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
  window.once("closed", () => {
    loadingCover.dispose();
    options.onClosed();
  });
  try {
    await window.loadURL(origin);
  } catch (error) {
    if (!window.isDestroyed()) window.destroy();
    throw error;
  }
  return window;
}
