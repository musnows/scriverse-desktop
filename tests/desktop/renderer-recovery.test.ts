import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RendererRecoveryTracker } from "../../src/main/renderer-recovery.js";

describe("Desktop Renderer 恢复策略", () => {
  it("自动重载异常退出并限制连续尝试次数", () => {
    const tracker = new RendererRecoveryTracker(2);

    expect(tracker.failure("crashed")).toBe("reload");
    expect(tracker.failure("oom")).toBe("reload");
    expect(tracker.failure("abnormal-exit")).toBe("exhausted");
  });

  it("稳定运行后重新允许自动恢复", () => {
    const tracker = new RendererRecoveryTracker(1);

    expect(tracker.failure("memory-eviction")).toBe("reload");
    expect(tracker.failure("crashed")).toBe("exhausted");
    tracker.stable();
    expect(tracker.failure("crashed")).toBe("reload");
  });

  it("忽略正常退出和主动结束", () => {
    const tracker = new RendererRecoveryTracker();

    expect(tracker.failure("clean-exit")).toBe("ignore");
    expect(tracker.failure("killed")).toBe("ignore");
  });

  it("记录最后一次页内路由并在恢复时重新加载", () => {
    const source = readFileSync(join(process.cwd(), "src/main/renderer-recovery.ts"), "utf8");

    expect(source).toContain('contents.on("did-navigate-in-page", handleNavigation)');
    expect(source).toContain("void contents.loadURL(lastKnownUrl)");
    expect(source.indexOf("contents.loadURL(lastKnownUrl)")).toBeLessThan(source.indexOf("contents.reloadIgnoringCache()"));
  });
});
