import { Menu, Tray, nativeImage } from "electron";

export type BackgroundTrayStatus = {
  localServerRunning: boolean;
};

export class BackgroundTray {
  private readonly tray: Tray;
  private status: BackgroundTrayStatus = { localServerRunning: false };

  constructor(iconPath: string, private readonly actions: {
    show: () => void;
    refresh: () => void | Promise<void>;
    quit: () => void;
  }) {
    const icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) throw new Error("Desktop tray icon is unavailable");
    this.tray = new Tray(icon.resize({ width: 18, height: 18 }));
    this.tray.setToolTip("Scriverse Desktop");
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
        label: "打开 Scriverse Desktop",
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
        label: "退出 Scriverse Desktop",
        click: () => this.actions.quit()
      }
    ]));
  }
}
