import { describe, expect, it, vi } from "vitest";
import { NetworkConnectivityMonitor } from "../../src/main/network-connectivity-monitor.js";

describe("Desktop 网络连接监测", () => {
  it("在初始状态和网络状态变化时通知一次，并在释放后停止检测", () => {
    vi.useFakeTimers();
    try {
      let online = true;
      const onStatusChange = vi.fn();
      const monitor = new NetworkConnectivityMonitor({
        readOnline: () => online,
        onStatusChange,
        intervalMs: 1_000
      });

      monitor.start();
      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(onStatusChange).toHaveBeenLastCalledWith(true);

      vi.advanceTimersByTime(1_000);
      expect(onStatusChange).toHaveBeenCalledTimes(1);

      online = false;
      vi.advanceTimersByTime(1_000);
      expect(onStatusChange).toHaveBeenCalledTimes(2);
      expect(onStatusChange).toHaveBeenLastCalledWith(false);

      monitor.dispose();
      online = true;
      vi.advanceTimersByTime(1_000);
      expect(onStatusChange).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
