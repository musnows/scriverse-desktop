import { describe, expect, it } from "vitest";
import {
  DESKTOP_SHELL_PROTOCOL_RANGE,
  DESKTOP_SYNC_PROTOCOL_RANGE,
  classifyRemoteCompatibility,
  compareSemanticVersions,
  desktopUpgradeRequirementMessage,
  protocolRangesIntersect
} from "../../src/shared/protocol-range.js";

describe("Desktop 协议范围", () => {
  it("与 Server 发布的协议范围保持一致", () => {
    expect(DESKTOP_SHELL_PROTOCOL_RANGE).toEqual({ min: 1, max: 1 });
    expect(DESKTOP_SYNC_PROTOCOL_RANGE).toEqual({ min: 1, max: 1 });
  });

  it("按 SemVer 比较最低 Desktop 版本", () => {
    expect(compareSemanticVersions("0.8.7", "0.8.6")).toBe(1);
    expect(compareSemanticVersions("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
    expect(compareSemanticVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareSemanticVersions("v1.0.0", "1.0.0")).toBeNull();
  });

  it("按数字段比较四段 Desktop 版本，缺省第四段视为 0", () => {
    expect(compareSemanticVersions("1.6.1.1", "1.6.1")).toBe(1);
    expect(compareSemanticVersions("1.6.1.1", "1.6.1.0")).toBe(1);
    expect(compareSemanticVersions("1.6.1", "1.6.1.0")).toBe(0);
    expect(compareSemanticVersions("1.6.1.1", "1.6.1.2")).toBe(-1);
    expect(compareSemanticVersions("1.6.1.1", "1.6.2")).toBe(-1);
    expect(compareSemanticVersions("1.6.1.1", "1.1.6.1")).toBe(1);
    expect(compareSemanticVersions("1.6.1.1", "0.0.1")).toBe(1);
  });

  it("非法或空版本比较失败，不回落成 0.0.1", () => {
    for (const invalid of ["", "   ", "latest", "v1.6.1.1", "1.6.1.1.1", "01.6.1.1"]) {
      expect(compareSemanticVersions(invalid, "0.0.1")).toBeNull();
      expect(compareSemanticVersions("1.6.1.1", invalid)).toBeNull();
      expect(desktopUpgradeRequirementMessage(invalid, "0.0.1")).not.toContain("0.0.1");
      expect(desktopUpgradeRequirementMessage(invalid, "0.0.1")).not.toContain("至少");
    }
    expect(desktopUpgradeRequirementMessage("1.6.1.1", "")).not.toContain("0.0.1");
    expect(desktopUpgradeRequirementMessage("1.6.1.1", null)).not.toContain("0.0.1");
    expect(desktopUpgradeRequirementMessage("1.6.1", "1.6.1.1")).toBe("当前 Desktop 版本过低，Server 要求至少 1.6.1.1");
  });

  it("只在闭区间有交集时协商成功", () => {
    expect(protocolRangesIntersect({ min: 1, max: 2 }, { min: 2, max: 3 })).toBe(true);
    expect(protocolRangesIntersect({ min: 1, max: 1 }, { min: 2, max: 3 })).toBe(false);
  });

  it("区分兼容、仅在线、legacy、需升级与 shell 不兼容", () => {
    expect(classifyRemoteCompatibility({
      desktopVersion: "0.8.7", minimumDesktopVersion: "0.1.0",
      shellProtocol: { min: 1, max: 1 }, syncProtocol: { min: 1, max: 1 }
    })).toBe("compatible");
    expect(classifyRemoteCompatibility({
      desktopVersion: "0.8.7", minimumDesktopVersion: null,
      shellProtocol: { min: 1, max: 1 }, syncProtocol: { min: 2, max: 2 }
    })).toBe("online-only");
    expect(classifyRemoteCompatibility({
      desktopVersion: "0.8.7", minimumDesktopVersion: null, shellProtocol: null, syncProtocol: null
    })).toBe("legacy-online-only");
    expect(classifyRemoteCompatibility({
      desktopVersion: "0.8.7", minimumDesktopVersion: "0.9.0",
      shellProtocol: { min: 1, max: 1 }, syncProtocol: { min: 1, max: 1 }
    })).toBe("desktop-upgrade-required");
    expect(classifyRemoteCompatibility({
      desktopVersion: "1.6.1.1", minimumDesktopVersion: "0.0.1",
      shellProtocol: { min: 1, max: 1 }, syncProtocol: { min: 1, max: 1 }
    })).toBe("compatible");
    expect(classifyRemoteCompatibility({
      desktopVersion: "1.6.1.1", minimumDesktopVersion: "1.6.1",
      shellProtocol: { min: 1, max: 1 }, syncProtocol: { min: 1, max: 1 }
    })).toBe("compatible");
    expect(classifyRemoteCompatibility({
      desktopVersion: "1.6.1", minimumDesktopVersion: "1.6.1.1",
      shellProtocol: { min: 1, max: 1 }, syncProtocol: { min: 1, max: 1 }
    })).toBe("desktop-upgrade-required");
    expect(classifyRemoteCompatibility({
      desktopVersion: "", minimumDesktopVersion: "0.0.1",
      shellProtocol: { min: 1, max: 1 }, syncProtocol: { min: 1, max: 1 }
    })).toBe("desktop-upgrade-required");
    expect(classifyRemoteCompatibility({
      desktopVersion: "0.8.7", minimumDesktopVersion: null,
      shellProtocol: { min: 2, max: 3 }, syncProtocol: { min: 1, max: 1 }
    })).toBe("shell-incompatible");
  });
});
