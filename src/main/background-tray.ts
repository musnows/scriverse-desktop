import { Menu, Tray, nativeImage } from "electron";
import { DESKTOP_DISPLAY_NAME } from "../shared/branding.js";

export type BackgroundTrayStatus = {
  localServerRunning: boolean;
};

export class BackgroundTray {
  private readonly tray: Tray;
  private status: BackgroundTrayStatus = { localServerRunning: false };

  constructor(iconPath: string, private readonly actions: {
    show: () => void;
    refresh: () => void | Promise<void>;
    requestQuit: () => void;
  }) {
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error("Desktop tray icon is unavailable");
    this.tray = new Tray(icon.resize({ width: 18, height: 18 }));
    this.tray.setToolTip(DESKTOP_DISPLAY_NAME);
    this.tray.on("click", () => this.actions.show());
    this.renderMenu();
  }

  update(status: BackgroundTrayStatus): void {
    this.status = status;
    this.renderMenu();
  }

  dispose(): void {
    this.tray.destroy();
  }

  private renderMenu(): void {
    this.tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: `打开${DESKTOP_DISPLAY_NAME}`,
        click: () => this.actions.show()
      },
      {
        label: this.status.localServerRunning ? "本地工作区正在运行" : "本地工作区尚未启动",
        enabled: false
      },
      {
        label: "清理缓存并强制刷新",
        click: () => { void this.actions.refresh(); }
      },
      { type: "separator" },
      {
        label: `退出${DESKTOP_DISPLAY_NAME}`,
        click: () => this.actions.requestQuit()
      }
    ]));
  }
}
