import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  packaged: true,
  fetch: vi.fn(),
  dialog: vi.fn(),
  openExternal: vi.fn(),
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(),
  quitAndInstall: vi.fn(),
  monitorOn: vi.fn(),
  monitorOff: vi.fn(),
  nsisAccess: vi.fn()
}));
vi.mock("electron", () => ({
  app: { get isPackaged() { return mocks.packaged; }, getVersion: () => "1.2.0.1" },
  autoUpdater: { setFeedURL: mocks.setFeedURL, checkForUpdates: mocks.checkForUpdates, quitAndInstall: mocks.quitAndInstall, on: vi.fn() },
  dialog: { showMessageBox: mocks.dialog },
  net: { fetch: mocks.fetch },
  powerMonitor: { on: mocks.monitorOn, removeListener: mocks.monitorOff },
  shell: { openExternal: mocks.openExternal }
}));
vi.mock("electron-updater", () => ({ default: { get autoUpdater() { mocks.nsisAccess(); throw new Error("Four-part versions must not initialize the NSIS SemVer updater"); } } }));
vi.mock("../../src/main/windows-installation.js", () => ({ isSquirrelWindowsInstallation: () => false }));
vi.mock("../../src/main/desktop-release-request.js", () => ({ fetchDesktopReleaseResponse: (...args: unknown[]) => mocks.fetch(...args) }));
import { DesktopUpdater } from "../../src/main/desktop-updater.js";

const originalProcess = process;
const root = "https://github.com/musnows/scriverse-desktop/releases";
function release(version = "1.2.0.2", platform = "win32", arch = "x64") {
  const name = platform === "darwin"
    ? `scriverse-desktop-macos-darwin-${arch}-${version}.dmg`
    : `scriverse-desktop-windows-win32-${arch}-${version}-Setup.exe`;
  return { tag_name: `v${version}`, draft: false, prerelease: false, html_url: `${root}/tag/v${version}`, assets: [{ name, state: "uploaded", size: 100, browser_download_url: `${root}/download/v${version}/${name}` }] };
}
let updater: DesktopUpdater;
let prepareInstall: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("process", { ...originalProcess, platform: "win32", arch: "x64" });
  vi.spyOn(originalProcess.stderr, "write").mockImplementation(() => true);
  mocks.packaged = true;
  mocks.dialog.mockResolvedValue({ response: 0 });
  mocks.openExternal.mockResolvedValue(undefined);
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify(release())));
  prepareInstall = vi.fn(async () => true);
  updater = new DesktopUpdater({ version: "1.2.0.1", getParentWindow: () => null, getLeaveState: () => ({ dirty: false, activeAiRequests: 0, pendingMutations: 0, conflicts: 0, rejected: 0 }), prepareInstall });
});

afterEach(() => {
  updater.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Desktop 四段版本的更新检查", () => {
  it("API 限流时从正式发布页发现新版并提供对应安装包", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: `${root}/tag/v1.2.0.2` } }))
      .mockResolvedValueOnce(new Response(null, { headers: { "content-length": "100" } }));
    mocks.dialog.mockResolvedValue({ response: 1 });
    updater.initialize();
    updater.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dialog).toHaveBeenCalledWith(expect.objectContaining({ message: "叙界 v1.2.0.2 可用" }));
    expect(mocks.openExternal).toHaveBeenCalledWith(release().assets[0].browser_download_url);
  });

  it.each(["arm64", "x64"])("macOS %s 发现新版后提供 DMG，不使用原生自动安装器", async (arch) => {
    vi.stubGlobal("process", { ...originalProcess, platform: "darwin", arch });
    const value = release("1.2.0.2", "darwin", arch);
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify(value)));
    mocks.dialog.mockResolvedValue({ response: 1 });
    updater.initialize();
    updater.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dialog).toHaveBeenCalledWith(expect.objectContaining({ message: "叙界 v1.2.0.2 可用" }));
    expect(mocks.openExternal).toHaveBeenCalledWith(value.assets[0].browser_download_url);
    expect(mocks.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.nsisAccess).not.toHaveBeenCalled();
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
    expect(prepareInstall).not.toHaveBeenCalled();
  });

  it("定时检查新版且不会访问未初始化的 SemVer 或 Squirrel 更新器", async () => {
    updater.initialize();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.dialog).toHaveBeenCalledWith(expect.objectContaining({ message: "叙界 v1.2.0.2 可用", buttons: ["稍后", "下载安装包"] }));
    expect(mocks.nsisAccess).not.toHaveBeenCalled();
    expect(mocks.setFeedURL).not.toHaveBeenCalled();
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
  });

  it("后台不会反复提示同一版本，手动检查仍可查看", async () => {
    updater.initialize();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.dialog).toHaveBeenCalledOnce();
    updater.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dialog).toHaveBeenCalledTimes(2);
  });

  it("仅在用户选择后打开对应架构安装包，不触发安装或关闭工作区", async () => {
    mocks.dialog.mockResolvedValue({ response: 1 });
    updater.initialize();
    updater.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.openExternal).toHaveBeenCalledWith(release().assets[0].browser_download_url);
    expect(prepareInstall).not.toHaveBeenCalled();
    expect(mocks.quitAndInstall).not.toHaveBeenCalled();
  });

  it("取消下载不会打开地址，提示未关闭时合并后续检查", async () => {
    let closeDialog: ((value: { response: number }) => void) | undefined;
    mocks.dialog.mockImplementation(() => new Promise<{ response: number }>((resolve) => { closeDialog = resolve; }));
    updater.initialize();
    updater.check();
    await vi.advanceTimersByTimeAsync(0);
    updater.check();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    closeDialog?.({ response: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.openExternal).not.toHaveBeenCalled();
    updater.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    closeDialog?.({ response: 0 });
    await vi.advanceTimersByTimeAsync(0);
  });

  it("手动检查已是最新版本时显示完整四段版本", async () => {
    mocks.fetch.mockImplementation(async () => new Response(JSON.stringify(release("1.2.0.1"))));
    updater.initialize();
    updater.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dialog).toHaveBeenCalledWith(expect.objectContaining({ message: "叙界 1.2.0.1 已是最新版本" }));
  });

  it("后台网络失败保持安静，手动检查失败显示错误", async () => {
    mocks.fetch.mockImplementation(async () => new Response("", { status: 503 }));
    updater.initialize();
    updater.check(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dialog).not.toHaveBeenCalled();
    updater.check();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dialog).toHaveBeenCalledWith(expect.objectContaining({ type: "error", title: "检查更新失败" }));
  });

  it("合并并发检查，并在销毁时中止未完成请求", async () => {
    mocks.fetch.mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    updater.initialize();
    updater.check();
    updater.check();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    updater.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.dialog).not.toHaveBeenCalled();
    expect(mocks.monitorOff).toHaveBeenCalledWith("suspend", expect.any(Function));
    expect(mocks.monitorOff).toHaveBeenCalledWith("resume", expect.any(Function));
  });
});
