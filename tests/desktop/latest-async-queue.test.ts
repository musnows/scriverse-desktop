import { describe, expect, it, vi } from "vitest";
import {
  createLatestAsyncQueue,
  mergeLatestChapterSaveRequest
} from "../../runtime-overlay/public/latest-async-queue.js";

describe("Desktop 正文保存请求队列", () => {
  it("把执行期间累积的自动保存合并为一次最新执行", async () => {
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const received: Array<{ automatic: boolean }> = [];
    const execute = vi.fn(async (input: { automatic: boolean }) => {
      received.push(input);
      if (received.length === 1) await firstGate;
      return input;
    });
    const queue = createLatestAsyncQueue(execute, mergeLatestChapterSaveRequest);

    const running = queue.request({ automatic: true });
    const callers = Array.from({ length: 10_000 }, () => queue.request({ automatic: true }));

    expect(callers.every((promise) => promise === running)).toBe(true);
    expect(queue.isRunning()).toBe(true);
    releaseFirst?.();
    await expect(running).resolves.toEqual({ automatic: true });
    expect(received).toEqual([{ automatic: true }, { automatic: true }]);
    expect(queue.isRunning()).toBe(false);
  });

  it("让积压的手工保存优先于自动保存语义", async () => {
    let releaseFirst: (() => void) | null = null;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const received: Array<{ automatic: boolean }> = [];
    const queue = createLatestAsyncQueue(async (input: { automatic: boolean }) => {
      received.push(input);
      if (received.length === 1) await firstGate;
      return input;
    }, mergeLatestChapterSaveRequest);

    const running = queue.request({ automatic: true });
    queue.request({ automatic: true });
    queue.request({ automatic: false });
    queue.request({ automatic: true });
    releaseFirst?.();

    await expect(running).resolves.toEqual({ automatic: false });
    expect(received).toEqual([{ automatic: true }, { automatic: false }]);
  });
});
