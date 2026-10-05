import { describe, expect, it } from "vitest";
import { desktopNetworkGuidanceMessage, desktopNetworkGuidanceView } from "../../runtime-overlay/public/desktop-network-guidance.js";

const restored = { online: true, monitoring: true };
const disconnected = { online: false, monitoring: true };

describe("Desktop 断网引导文案", () => {
  it("断网时说明离线副本入口，并明确恢复联网后仍须重新进入工作区", () => {
    const copy = desktopNetworkGuidanceMessage(false);

    expect(copy.title).toBe("网络连接已断开");
    expect(copy.description).toContain("返回工作区列表");
    expect(copy.description).toContain("离线副本");
    expect(copy.description).toContain("恢复线上模式并同步数据");
  });

  it("离线模式恢复联网后允许继续留在当前工作区", () => {
    const copy = desktopNetworkGuidanceMessage(true);

    expect(copy.title).toBe("网络连接已恢复");
    expect(copy.description).toContain("关闭此提示并继续使用本机数据");
    expect(copy.description).toContain("返回工作区选择页");
    expect(copy.description).toContain("恢复线上模式并同步数据");
  });

  it("在线模式不显示网络恢复提示", () => {
    expect(desktopNetworkGuidanceView("online", restored, false)).toEqual({ visible: false, dismissedWhileOnline: false });
    expect(desktopNetworkGuidanceView("online", disconnected, false).visible).toBe(false);
    expect(desktopNetworkGuidanceView("offline", { online: true, monitoring: false }, false).visible).toBe(false);
  });

  it("只有离线模式在 health 成功时显示提示，关闭后要等再次失败再成功才重现", () => {
    expect(desktopNetworkGuidanceView("offline", disconnected, false)).toEqual({ visible: false, dismissedWhileOnline: false });
    const visible = desktopNetworkGuidanceView("offline", restored, false);
    expect(visible.visible).toBe(true);
    expect(visible.copy?.title).toBe("网络连接已恢复");
    expect(desktopNetworkGuidanceView("offline", restored, true)).toEqual({ visible: false, dismissedWhileOnline: true });
    expect(desktopNetworkGuidanceView("offline", disconnected, true)).toEqual({ visible: false, dismissedWhileOnline: false });
    expect(desktopNetworkGuidanceView("offline", restored, false).visible).toBe(true);
  });
});
