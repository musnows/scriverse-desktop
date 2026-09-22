export const NETWORK_CONNECTIVITY_CHECK_INTERVAL_MS = 15_000;

type NetworkConnectivityMonitorOptions = {
  readOnline: () => boolean;
  onStatusChange: (online: boolean) => void;
  intervalMs?: number;
};

export class NetworkConnectivityMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastOnline: boolean | null = null;
  private readonly intervalMs: number;

  constructor(private readonly options: NetworkConnectivityMonitorOptions) {
    this.intervalMs = Number.isFinite(options.intervalMs) && Number(options.intervalMs) > 0
      ? Number(options.intervalMs)
      : NETWORK_CONNECTIVITY_CHECK_INTERVAL_MS;
  }

  getOnline(): boolean {
    return this.options.readOnline() === true;
  }

  start(): void {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => this.check(), this.intervalMs);
    this.timer.unref?.();
  }

  check(): boolean {
    const online = this.getOnline();
    if (this.lastOnline === online) return online;
    this.lastOnline = online;
    this.options.onStatusChange(online);
    return online;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
