export const NETWORK_CONNECTIVITY_CHECK_INTERVAL_MS = 15_000;
export const NETWORK_CONNECTIVITY_CONFIRMATION_DELAY_MS = 1_000;

type NetworkConnectivityMonitorOptions = {
  probe: () => Promise<boolean>;
  onStatusChange: (online: boolean) => void;
  intervalMs?: number;
  confirmationDelayMs?: number;
};

export class NetworkConnectivityMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private delayWaiters: Array<() => void> = [];
  private lastOnline: boolean | null = null;
  private inFlight = false;
  private confirmed = false;
  private disposed = false;
  private readonly intervalMs: number;
  private readonly confirmationDelayMs: number;

  constructor(private readonly options: NetworkConnectivityMonitorOptions) {
    this.intervalMs = Number.isFinite(options.intervalMs) && Number(options.intervalMs) > 0
      ? Number(options.intervalMs)
      : NETWORK_CONNECTIVITY_CHECK_INTERVAL_MS;
    this.confirmationDelayMs = Number.isFinite(options.confirmationDelayMs) && Number(options.confirmationDelayMs) >= 0
      ? Number(options.confirmationDelayMs)
      : NETWORK_CONNECTIVITY_CONFIRMATION_DELAY_MS;
  }

  currentOnline(): boolean {
    return this.lastOnline === true;
  }

  start(): void {
    if (this.timer || this.disposed || this.confirmed) return;
    void this.check();
    this.timer = setInterval(() => {
      void this.check();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  // 15 秒轮询第一次成功后延迟 1 秒复测。两次都成功才通知恢复并停止后续探测。
  async check(): Promise<boolean> {
    if (this.disposed || this.confirmed || this.inFlight) return this.lastOnline === true;
    this.inFlight = true;
    try {
      const first = await this.readProbe();
      if (this.disposed || !first) return false;
      await this.delay(this.confirmationDelayMs);
      if (this.disposed) return false;
      const second = await this.readProbe();
      if (this.disposed || !second) return false;
      this.markRecovered();
      return true;
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
    this.finishDelay();
  }

  private async readProbe(): Promise<boolean> {
    try {
      return await this.options.probe() === true;
    } catch {
      return false;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.delayWaiters.push(resolve);
      this.delayTimer = setTimeout(() => this.finishDelay(), ms);
      this.delayTimer.unref?.();
    });
  }

  private finishDelay(): void {
    if (this.delayTimer) clearTimeout(this.delayTimer);
    this.delayTimer = null;
    const waiters = this.delayWaiters;
    this.delayWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private markRecovered(): void {
    this.confirmed = true;
    this.lastOnline = true;
    this.stopTimer();
    this.options.onStatusChange(true);
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
