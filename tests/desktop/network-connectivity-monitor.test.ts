import { describe, expect, it, vi } from "vitest";
import {
  NETWORK_CONNECTIVITY_CHECK_INTERVAL_MS,
  NETWORK_CONNECTIVITY_CONFIRMATION_DELAY_MS,
  NetworkConnectivityMonitor
} from "../../src/main/network-connectivity-monitor.js";

describe("Desktop 网络连接监测", () => {
  it("默认每 15 秒探测一次，第一次成功后 1 秒复测", () => {
    expect(NETWORK_CONNECTIVITY_CHECK_INTERVAL_MS).toBe(15_000);
    expect(NETWORK_CONNECTIVITY_CONFIRMATION_DELAY_MS).toBe(1_000);
  });

  it("连续两次成功才通知恢复，并停止后续轮询", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => true);
      const onStatusChange = vi.fn();
      const monitor = new NetworkConnectivityMonitor({
        probe,
        onStatusChange,
        intervalMs: 15_000
      });
      monitor.start();
      expect(probe).toHaveBeenCalledTimes(1);
      expect(onStatusChange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(999);
      expect(probe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(onStatusChange).toHaveBeenLastCalledWith(true);
      expect(monitor.currentOnline()).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("第一次失败不复测，第二次失败则回到 15 秒轮询", async () => {
    vi.useFakeTimers();
    try {
      const results = [false, true, false, true, true];
      const probe = vi.fn(async () => results.shift() ?? false);
      const onStatusChange = vi.fn();
      const monitor = new NetworkConnectivityMonitor({
        probe,
        onStatusChange,
        intervalMs: 15_000
      });
      monitor.start();
      await Promise.resolve();
      expect(probe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(onStatusChange).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(14_000);
      expect(probe).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(probe).toHaveBeenCalledTimes(3);
      expect(onStatusChange).not.toHaveBeenCalled();
      expect(monitor.currentOnline()).toBe(false);

      await vi.advanceTimersByTimeAsync(14_000);
      expect(probe).toHaveBeenCalledTimes(4);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(probe).toHaveBeenCalledTimes(5);
      expect(onStatusChange).toHaveBeenCalledTimes(1);
      expect(onStatusChange).toHaveBeenLastCalledWith(true);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(probe).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("复测超时或抛错都不显示恢复，进行中的轮询不会重叠", async () => {
    const onStatusChange = vi.fn();
    let releaseFirst: (value: boolean) => void = () => undefined;
    let calls = 0;
    const monitor = new NetworkConnectivityMonitor({
      probe: () => {
        calls += 1;
        if (calls === 1) return new Promise<boolean>((resolve) => { releaseFirst = resolve; });
        throw new Error("timeout");
      },
      onStatusChange,
      intervalMs: 60_000,
      confirmationDelayMs: 0
    });

    const first = monitor.check();
    const overlapped = monitor.check();
    expect(calls).toBe(1);
    await expect(overlapped).resolves.toBe(false);
    releaseFirst(true);
    await expect(first).resolves.toBe(false);
    expect(calls).toBe(2);
    expect(onStatusChange).not.toHaveBeenCalled();
    expect(monitor.currentOnline()).toBe(false);
  });

  it("释放后不再发出确认探测", async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => true);
      const onStatusChange = vi.fn();
      const monitor = new NetworkConnectivityMonitor({
        probe,
        onStatusChange,
        intervalMs: 15_000
      });
      monitor.start();
      expect(probe).toHaveBeenCalledTimes(1);
      monitor.dispose();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(onStatusChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});