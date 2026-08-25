import { BrowserWindow } from "electron";
import { join } from "node:path";
import { DESKTOP_DISPLAY_NAME } from "../shared/branding.js";
import { LOCAL_AI_CONFIG_ENTRY_URL, SELECTOR_ENTRY_URL } from "../shared/selector-contract.js";
import { captureRendererConsole } from "./renderer-console-logging.js";

export function createSelectorWindow(desktopRoot: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1_100,
    height: 760,
    minWidth: 390,
    minHeight: 600,
    show: false,
    title: DESKTOP_DISPLAY_NAME,
    backgroundColor: "#f3efe7",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(desktopRoot, "preload", "selector-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: true
    }
  });
  captureRendererConsole(window.webContents, "selector");
  const selectorSession = window.webContents.session;
  selectorSession.setPermissionCheckHandler(() => false);
  selectorSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== SELECTOR_ENTRY_URL && url !== LOCAL_AI_CONFIG_ENTRY_URL) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (url !== SELECTOR_ENTRY_URL && url !== LOCAL_AI_CONFIG_ENTRY_URL) event.preventDefault();
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    process.stderr.write(`Selector load failed (${errorCode}): ${errorDescription}\n`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    process.stderr.write(`Selector renderer stopped: ${details.reason}\n`);
  });
  window.webContents.on("did-finish-load", () => {
    process.stderr.write("Selector renderer finished loading\n");
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(SELECTOR_ENTRY_URL).catch((error: unknown) => {
    process.stderr.write(`Selector navigation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  return window;
}
