import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeDownloadFilename } from "../../src/shared/download-filename.js";

const root = process.cwd();
const menuSource = readFileSync(join(root, "src/main/native-menu.ts"), "utf8");
const mainSource = readFileSync(join(root, "src/main/main.ts"), "utf8");
const downloadSource = readFileSync(join(root, "src/main/download-policy.ts"), "utf8");
const preloadSource = readFileSync(join(root, "src/preload/workspace-preload.cts"), "utf8");
const localPreloadSource = readFileSync(join(root, "src/preload/local-workspace-preload.cts"), "utf8");
const localIpcSource = readFileSync(join(root, "src/main/local-workspace-ipc.ts"), "utf8");
const workspaceIpcSource = readFileSync(join(root, "src/main/workspace-ipc.ts"), "utf8");

describe("Desktop 原生菜单与下载", () => {
  it("净化路径、控制字符、设备名和超长下载文件名", () => {
    expect(sanitizeDownloadFilename("../../章节导出?.docx")).toBe("章节导出_.docx");
    expect(sanitizeDownloadFilename("C:\\temp\\CON.txt")).toBe("scriverse-download");
    expect(sanitizeDownloadFilename("../\u0000")).toBe("_");
    const longName = `${"正文".repeat(100)}.epub`;
    expect(sanitizeDownloadFilename(longName)).toHaveLength(180);
    expect(sanitizeDownloadFilename(longName)).toMatch(/\.epub$/u);
  });

  it("提供工作区、编辑、视图、窗口和帮助菜单", () => {
    for (const label of ["切换工作区", "重新连接", "打开同步中心", "撤销", "查找", "开发者工具", "切换全屏", "打开日志目录", "版本信息", "检查更新"]) {
      expect(menuSource).toContain(label);
    }
  });

  it("在所有正式窗口启用开发者工具并提供平台快捷键", () => {
    for (const path of ["selector-window.ts", "workspace-window.ts", "remote-workspace-window.ts"]) {
      const source = readFileSync(join(root, "src/main", path), "utf8");
      expect(source).toContain("devTools: true");
      expect(source).not.toContain("devTools: !app.isPackaged");
    }
    expect(menuSource).toContain('role: "toggleDevTools"');
    expect(menuSource).toContain('platform === "darwin" ? "Command+Alt+I" : "Control+Shift+I"');
  });

  it("向本地页面提供工作区名称和切换能力", () => {
    expect(localPreloadSource).toContain('exposeInMainWorld("scriverseDesktopLocalShell"');
    expect(localPreloadSource).toContain('invoke("local-workspace:shell:request-switch")');
    expect(localIpcSource).toContain('profileName: string; profileKind: "local"');
  });

  it("向远端页面提供已选择的 Server 工作区名称", () => {
    expect(workspaceIpcSource).toContain("profileName: profile.name");
    expect(workspaceIpcSource).toContain('profileKind: "remote"');
    expect(readFileSync(join(root, "src/main/remote-workspace-window.ts"), "utf8")).toContain("remoteWorkspaceShellUrl(options.profile.id)");
    expect(preloadSource).toContain('ipcRenderer.invoke("workspace:shell:request-switch")');
  });

  it("About 面板分行显示 Desktop 与对应 Server 版本", () => {
    expect(mainSource).toContain("app.setAboutPanelOptions");
    expect(mainSource).toContain("applicationName: DESKTOP_DISPLAY_NAME");
    expect(mainSource).toContain('applicationVersion: desktopVersion');
    expect(mainSource).toContain('version: ""');
    expect(mainSource).toContain("对应 Server 版本 ${serverVersion}");
  });

  it("下载只允许当前工作区并始终使用系统保存对话框", () => {
    expect(downloadSource).toContain("webContents.id !== owner.webContents.id");
    expect(downloadSource).toContain("setSaveDialogOptions");
    expect(downloadSource).not.toContain("setSavePath");
    expect(preloadSource).toContain('new Set(["open-sync-center"])');
    expect(preloadSource).not.toContain("send:");
  });
});
