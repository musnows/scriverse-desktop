import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const mainSource = readFileSync(join(root, "src/main/main.ts"), "utf8");
const traySource = readFileSync(join(root, "src/main/background-tray.ts"), "utf8");
const buildSource = readFileSync(join(root, "scripts/copy-renderer.mjs"), "utf8");

describe("Desktop 菜单栏与系统托盘后台生命周期", () => {
  it("关闭主窗口或工作区时隐藏窗口并保留应用进程", () => {
    expect(mainSource).toContain("function hideDesktopToBackground()");
    expect(mainSource).toContain('event.preventDefault();\n    hideDesktopToBackground();');
    expect(mainSource).toContain('app.on("window-all-closed", () => {');
    expect(mainSource).not.toContain('if (process.platform !== "darwin") app.quit();');
    expect(mainSource).toContain('if (process.platform === "darwin" && app.dock) app.dock.hide();');
  });

  it("菜单栏与托盘提供打开、运行状态、缓存强刷和彻底退出操作", () => {
    expect(traySource).toContain("new Tray(");
    expect(traySource).toContain('label: "打开 Scriverse Desktop"');
    expect(traySource).toContain('label: "退出 Scriverse Desktop"');
    expect(traySource).toContain('label: "清理缓存并强制刷新"');
    expect(traySource).toContain("本地工作区正在运行");
    expect(traySource).not.toContain("tmux");
    expect(mainSource).toContain("await localServerManager?.stop();");
  });

  it("缓存强刷不删除登录或离线数据", () => {
    expect(mainSource).toContain("activeSession.clearCache()");
    expect(mainSource).toContain("activeSession.clearCodeCaches({ urls: [] })");
    expect(mainSource).toContain("target.webContents.reloadIgnoringCache()");
    expect(mainSource).not.toContain("clearStorageData");
    expect(mainSource).not.toContain("clearAuthCache");
  });

  it("把叙界图标复制到打包后的托盘资源目录", () => {
    expect(buildSource).toContain('new URL("../build/assets/"');
    expect(buildSource).toContain('new URL("../assets/icon-32.png"');
  });
});
