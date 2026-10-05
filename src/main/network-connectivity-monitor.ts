export const NETWORK_CONNECTIVITY_CHECK_INTERVAL_MS = 15_000;

type NetworkConnectivityMonitorOptions = {
  probe: () => Promise<boolean>;
  onStatusChange: (online: boolean) => void;
  intervalMs?: number;
};

export class NetworkConnectivityMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastOnline: boolean | null = null;
  private inFlight = false;
  private disposed = false;
  private readonly intervalMs: number;

  constructor(private readonly options: NetworkConnectivityMonitorOptions) {
    this.intervalMs = Number.isFinite(options.intervalMs) && Number(options.intervalMs) > 0
      ? Number(options.intervalMs)
      : NETWORK_CONNECTIVITY_CHECK_INTERVAL_MS;
  }

  currentOnline(): boolean {
    return this.lastOnline === true;
  }

  start(): void {
    if (this.timer || this.disposed) return;
    void this.check();
    this.timer = setInterval(() => {
      void this.check();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async check(): Promise<boolean> {
    if (this.disposed || this.inFlight) return this.lastOnline === true;
    this.inFlight = true;
    let online = false;
    try {
      online = await this.options.probe() === true;
    } catch {
      online = false;
    } finally {
      this.inFlight = false;
    }
    if (this.disposed || this.lastOnline === online) return this.lastOnline === true;
    this.lastOnline = online;
    this.options.onStatusChange(online);
    return online;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
