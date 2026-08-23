import { app, autoUpdater, dialog, powerMonitor, shell, type BrowserWindow } from "electron";
import type { WorkspaceLeaveState } from "../shared/workspace-contract.js";
import { desktopUpdateFeedUrl, updateInstallDetail } from "../shared/update-policy.js";

const RELEASES_URL = "https://github.com/musnows/Scriverse/releases/latest";
const UPDATE_INTERVAL_MS = 10 * 60_000;

export class DesktopUpdater {
  private checking = false;
  private manualCheck = false;
  private suspended = false;
  private initialized = false;
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
    autoUpdater.setFeedURL({ url: feedUrl });
    autoUpdater.on("checking-for-update", () => { this.checking = true; });
    autoUpdater.on("update-available", () => { this.checking = false; });
    autoUpdater.on("update-not-available", () => {
      this.checking = false;
      if (!this.manualCheck) return;
      this.manualCheck = false;
      void this.showMessageBox({
        type: "info",
        title: "检查更新",
        message: `Scriverse Desktop ${this.options.version} 已是最新版本`
      });
    });
    autoUpdater.on("error", (error) => {
      this.checking = false;
      process.stderr.write(`Desktop update check failed: ${error.message}\n`);
      if (!this.manualCheck) return;
      this.manualCheck = false;
      void this.showMessageBox({
        type: "error",
        title: "检查更新失败",
        message: "暂时无法检查 Desktop 更新",
        detail: "当前版本仍可继续使用，请稍后重试。"
      });
    });
    autoUpdater.on("update-downloaded", (_event, _notes, releaseName) => {
      this.checking = false;
      this.manualCheck = false;
      void this.promptInstall(releaseName);
    });
    powerMonitor.on("suspend", this.handleSuspend);
    powerMonitor.on("resume", this.handleResume);
    this.initialTimer = setTimeout(() => this.check(true), 15_000);
    this.intervalTimer = setInterval(() => this.check(true), UPDATE_INTERVAL_MS);
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
      autoUpdater.checkForUpdates();
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
      title: "Desktop 更新",
      message: "Linux 版本由系统包管理器或下载页更新",
      detail: "Scriverse Desktop 不在 Linux 上伪装内置自动更新。",
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
      title: "Desktop 更新已下载",
      message: `Scriverse Desktop ${releaseName || "新版本"} 已准备好`,
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
    autoUpdater.quitAndInstall();
  }
}
