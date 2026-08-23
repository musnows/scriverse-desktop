import { Menu, type MenuItemConstructorOptions } from "electron";

export type DesktopMenuActions = {
  switchWorkspace: () => void;
  reconnectWorkspace: () => void;
  openSyncCenter: () => void;
  find: () => void;
  openLogs: () => void;
  showVersion: () => void;
  checkForUpdates: () => void;
};

export function createDesktopMenuTemplate(
  actions: DesktopMenuActions,
  platform: NodeJS.Platform = process.platform
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  if (platform === "darwin") {
    template.push({
      label: "Scriverse Desktop",
      submenu: [
        { role: "about", label: "关于 Scriverse Desktop" },
        { type: "separator" },
        { role: "services", label: "服务" },
        { type: "separator" },
        { role: "hide", label: "隐藏 Scriverse Desktop" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        { role: "quit", label: "退出 Scriverse Desktop" }
      ]
    });
  }
  template.push(
    {
      label: "工作区",
      submenu: [
        { label: "切换工作区", accelerator: "CmdOrCtrl+Shift+O", click: actions.switchWorkspace },
        { label: "重新连接", accelerator: "CmdOrCtrl+Shift+R", click: actions.reconnectWorkspace },
        { label: "打开同步中心", accelerator: "CmdOrCtrl+Shift+Y", click: actions.openSyncCenter }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
        { type: "separator" },
        { label: "查找", accelerator: "CmdOrCtrl+F", click: actions.find }
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" }
      ]
    },
    {
      role: "window",
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        ...(platform === "darwin" ? [{ type: "separator" as const }, { role: "front" as const, label: "前置全部窗口" }] : [])
      ]
    },
    {
      role: "help",
      label: "帮助",
      submenu: [
        { label: "打开日志目录", click: actions.openLogs },
        { label: "版本信息", click: actions.showVersion },
        { type: "separator" },
        { label: "检查更新", click: actions.checkForUpdates }
      ]
    }
  );
  return template;
}

export function installDesktopMenu(actions: DesktopMenuActions): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate(createDesktopMenuTemplate(actions)));
}
