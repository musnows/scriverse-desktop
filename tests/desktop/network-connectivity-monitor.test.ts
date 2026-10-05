import { describe, expect, it, vi } from "vitest";
import { NETWORK_CONNECTIVITY_CHECK_INTERVAL_MS, NetworkConnectivityMonitor } from "../../src/main/network-connectivity-monitor.js";

describe("Desktop 网络连接监测", () => {
  it("默认每 15 秒探测一次", () => {
    expect(NETWORK_CONNECTIVITY_CHECK_INTERVAL_MS).toBe(15_000);
  });

  it("只在 health 探测结果变化时通知，失败和超时都不算恢复", async () => {
    let healthy = false;
    const onStatusChange = vi.fn();
    const monitor = new NetworkConnectivityMonitor({
      probe: async () => healthy,
      onStatusChange,
      intervalMs: 60_000
    });

    await monitor.check();
    expect(onStatusChange).toHaveBeenCalledTimes(1);
    expect(onStatusChange).toHaveBeenLastCalledWith(false);
    expect(monitor.currentOnline()).toBe(false);

    await monitor.check();
    expect(onStatusChange).toHaveBeenCalledTimes(1);

    healthy = true;
    await monitor.check();
    expect(onStatusChange).toHaveBeenLastCalledWith(true);
    expect(monitor.currentOnline()).toBe(true);

    monitor.dispose();
    healthy = false;
    await monitor.check();
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    expect(monitor.currentOnline()).toBe(true);
  });

  it("探测抛错时视为未恢复，进行中的探测不会重叠", async () => {
    const onStatusChange = vi.fn();
    let resolveProbe: (value: boolean) => void = () => undefined;
    let calls = 0;
    const monitor = new NetworkConnectivityMonitor({
      probe: () => {
        calls += 1;
        if (calls === 1) return new Promise<boolean>((resolve) => { resolveProbe = resolve; });
        throw new Error("timeout");
      },
      onStatusChange,
      intervalMs: 60_000
    });

    const first = monitor.check();
    const overlapped = monitor.check();
    expect(calls).toBe(1);
    await expect(overlapped).resolves.toBe(false);
    resolveProbe(true);
    await expect(first).resolves.toBe(true);
    expect(onStatusChange).toHaveBeenLastCalledWith(true);

    await monitor.check();
    expect(onStatusChange).toHaveBeenLastCalledWith(false);
    expect(calls).toBe(2);
  });

  it("按间隔重复探测，释放后停止", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => true);
      const monitor = new NetworkConnectivityMonitor({
        probe,
        onStatusChange: vi.fn(),
        intervalMs: 1_000
      });
      monitor.start();
      await Promise.resolve();
      expect(probe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(probe).toHaveBeenCalledTimes(2);
      monitor.dispose();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
