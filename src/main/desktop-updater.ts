import { app, autoUpdater as squirrelAutoUpdater, dialog, powerMonitor, shell, type BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import { DESKTOP_DISPLAY_NAME } from "../shared/branding.js";
import type { WorkspaceLeaveState } from "../shared/workspace-contract.js";
import { desktopUpdateFeedUrl, updateInstallDetail, windowsNsisUpdateChannel } from "../shared/update-policy.js";
import { isSquirrelWindowsInstallation } from "./windows-installation.js";

const RELEASES_URL = "https://github.com/musnows/Scriverse/releases/latest";
const WINDOWS_UPDATE_URL = "https://github.com/musnows/scriverse-desktop/releases/latest/download";
const UPDATE_INTERVAL_MS = 10 * 60_000;
const nsisAutoUpdater = electronUpdater.autoUpdater;

export class DesktopUpdater {
  private checking = false;
  private manualCheck = false;
  private suspended = false;
  private initialized = false;
  private useNsisUpdater = false;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: {
    version: string;
    getParentWindow: () => BrowserWindow | null;
    getLeaveState: () => WorkspaceLeaveState;
    prepareInstall: (discardUnsaved: boolean) => Promise<boolean>;
  }) {}

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    const feedUrl = desktopUpdateFeedUrl(process.platform, this.options.version);
    if (!app.isPackaged || !feedUrl) return;
    this.useNsisUpdater = process.platform === "win32" && !isSquirrelWindowsInstallation();
    if (this.useNsisUpdater) {
      nsisAutoUpdater.autoInstallOnAppQuit = false;
      nsisAutoUpdater.channel = windowsNsisUpdateChannel(process.arch);
      nsisAutoUpdater.allowDowngrade = false;
      nsisAutoUpdater.setFeedURL({ provider: "generic", url: WINDOWS_UPDATE_URL });
      nsisAutoUpdater.on("checking-for-update", this.handleCheckingForUpdate);
      nsisAutoUpdater.on("update-available", this.handleUpdateAvailable);
      nsisAutoUpdater.on("update-not-available", this.handleUpdateNotAvailable);
      nsisAutoUpdater.on("error", this.handleUpdateError);
      nsisAutoUpdater.on("update-downloaded", (event) => {
        this.handleUpdateDownloaded(event.version);
      });
    } else {
      squirrelAutoUpdater.setFeedURL({ url: feedUrl });
      squirrelAutoUpdater.on("checking-for-update", this.handleCheckingForUpdate);
      squirrelAutoUpdater.on("update-available", this.handleUpdateAvailable);
      squirrelAutoUpdater.on("update-not-available", this.handleUpdateNotAvailable);
      squirrelAutoUpdater.on("error", this.handleUpdateError);
      squirrelAutoUpdater.on("update-downloaded", (_event, _notes, releaseName) => {
        this.handleUpdateDownloaded(releaseName);
      });
    }
    powerMonitor.on("suspend", this.handleSuspend);
    powerMonitor.on("resume", this.handleResume);
    this.initialTimer = setTimeout(() => this.check(true), 15_000);
    this.intervalTimer = setInterval(() => this.check(true), UPDATE_INTERVAL_MS);
  }

  private readonly handleCheckingForUpdate = (): void => {
    this.checking = true;
  };

  private readonly handleUpdateAvailable = (): void => {
    this.checking = false;
  };

  private readonly handleUpdateNotAvailable = (): void => {
    this.checking = false;
    if (!this.manualCheck) return;
    this.manualCheck = false;
    void this.showMessageBox({
      type: "info",
      title: "检查更新",
      message: `${DESKTOP_DISPLAY_NAME} ${this.options.version} 已是最新版本`
    });
  };

  private readonly handleUpdateError = (error: Error): void => {
    this.checking = false;
    process.stderr.write(`Desktop update check failed: ${error.message}\n`);
    if (!this.manualCheck) return;
    this.manualCheck = false;
    void this.showMessageBox({
      type: "error",
      title: "检查更新失败",
      message: `暂时无法检查${DESKTOP_DISPLAY_NAME}更新`,
      detail: "当前版本仍可继续使用，请稍后重试。"
    });
  };

  private handleUpdateDownloaded(releaseName: string): void {
    this.checking = false;
    this.manualCheck = false;
    void this.promptInstall(releaseName);
  }

  check(silent = false): void {
    if (process.platform === "linux") {
      if (!silent) void this.openLinuxUpdatePage();
      return;
    }
    if (!app.isPackaged) {
      if (!silent) void this.showMessageBox({
        type: "info",
        title: "检查更新",
        message: "开发模式不执行安装包更新检查"
      });
      return;
    }
    if (this.suspended || this.checking) return;
    this.manualCheck = !silent;
    this.checking = true;
    try {
      if (this.useNsisUpdater) {
        void nsisAutoUpdater.checkForUpdates().catch(() => undefined);
      } else {
        squirrelAutoUpdater.checkForUpdates();
      }
    } catch (error) {
      this.checking = false;
      this.manualCheck = false;
      process.stderr.write(`Desktop update check failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  dispose(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.initialTimer = null;
    this.intervalTimer = null;
    powerMonitor.removeListener("suspend", this.handleSuspend);
    powerMonitor.removeListener("resume", this.handleResume);
  }

  private readonly handleSuspend = (): void => {
    this.suspended = true;
  };

  private readonly handleResume = (): void => {
    this.suspended = false;
    this.check(true);
  };

  private showMessageBox(options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
    const parent = this.options.getParentWindow();
    return parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  }

  private async openLinuxUpdatePage(): Promise<void> {
    const result = await this.showMessageBox({
      type: "info",
      title: `${DESKTOP_DISPLAY_NAME}更新`,
      message: "Linux 版本由系统包管理器或下载页更新",
      detail: `${DESKTOP_DISPLAY_NAME}在 Linux 上使用系统包管理器或下载页更新。`,
      buttons: ["打开下载页", "取消"],
      defaultId: 0,
      cancelId: 1
    });
    if (result.response === 0) await shell.openExternal(RELEASES_URL);
  }

  private async promptInstall(releaseName: string): Promise<void> {
    const state = this.options.getLeaveState();
    const result = await this.showMessageBox({
      type: "info",
      title: `${DESKTOP_DISPLAY_NAME}更新已下载`,
      message: `${DESKTOP_DISPLAY_NAME} ${releaseName || "新版本"} 已准备好`,
      detail: updateInstallDetail(state),
      buttons: ["稍后", "重新启动并安装"],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    });
    if (result.response !== 1) return;
    const discardUnsaved = state.dirty || state.activeAiRequests > 0;
    if (!await this.options.prepareInstall(discardUnsaved)) return;
    this.dispose();
    if (this.useNsisUpdater) {
      nsisAutoUpdater.quitAndInstall();
    } else {
      squirrelAutoUpdater.quitAndInstall();
    }
  }
}
