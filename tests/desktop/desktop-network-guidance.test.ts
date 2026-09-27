import { describe, expect, it } from "vitest";
import { desktopNetworkGuidanceMessage } from "../../runtime-overlay/public/desktop-network-guidance.js";

describe("Desktop 断网引导文案", () => {
  it("断网时说明离线副本入口，并明确恢复联网后仍须重新进入工作区", () => {
    const copy = desktopNetworkGuidanceMessage(false);

    expect(copy.title).toBe("网络连接已断开");
    expect(copy.description).toContain("返回工作区列表");
    expect(copy.description).toContain("离线副本");
    expect(copy.description).toContain("恢复线上模式并同步数据");
  });

  it("恢复联网后仍提示重新进入工作区", () => {
    const copy = desktopNetworkGuidanceMessage(true);

    expect(copy.title).toBe("网络连接已恢复");
    expect(copy.description).toContain("仍然返回工作区列表");
    expect(copy.description).toContain("恢复线上模式并同步数据");
  });
});
