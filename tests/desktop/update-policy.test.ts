import { describe, expect, it } from "vitest";
import { desktopUpdateFeedUrl, updateInstallDetail, windowsNsisUpdateChannel } from "../../src/shared/update-policy.js";
import { parseSquirrelCommand } from "../../src/shared/squirrel-command.js";

describe("Desktop 更新策略", () => {
  it("只为 macOS 和 Windows 构造公开 GitHub Release 更新源", () => {
    expect(desktopUpdateFeedUrl("darwin", "0.8.7")).toBe("https://update.electronjs.org/musnows/Scriverse/darwin/v0.8.7");
    expect(desktopUpdateFeedUrl("win32", "0.8.7")).toBe("https://update.electronjs.org/musnows/Scriverse/win32/v0.8.7");
    expect(desktopUpdateFeedUrl("linux", "0.8.7")).toBeNull();
    expect(() => desktopUpdateFeedUrl("darwin", "../release")).toThrow();
  });

  it("为 Windows NSIS 安装器选择架构隔离的更新通道", () => {
    expect(windowsNsisUpdateChannel("x64")).toBe("latest");
    expect(windowsNsisUpdateChannel("arm64")).toBe("latest-arm64");
    expect(windowsNsisUpdateChannel("ia32")).toBe("latest-ia32");
    expect(() => windowsNsisUpdateChannel("armv7l")).toThrow(/architecture/u);
  });

  it("安装提示明确区分未保存内容与已持久化同步数据", () => {
    const detail = updateInstallDetail({ dirty: true, activeAiRequests: 1, pendingMutations: 2, conflicts: 3, rejected: 4 });
    expect(detail).toContain("页面仍有未保存内容");
    expect(detail).toContain("2 项离线变更已安全写入待上传队列");
    expect(detail).toContain("3 项同步冲突已保留");
    expect(detail).toContain("4 项被 Server 拒绝的本机修改已保留");
  });

  it("只在 Windows 处理受支持的 Squirrel 生命周期参数", () => {
    expect(parseSquirrelCommand(["app", "--squirrel-install"], "win32")).toBe("install");
    expect(parseSquirrelCommand(["app", "--squirrel-uninstall"], "win32")).toBe("uninstall");
    expect(parseSquirrelCommand(["app", "--squirrel-install"], "darwin")).toBeNull();
    expect(parseSquirrelCommand(["app", "--unknown"], "win32")).toBeNull();
  });
});
