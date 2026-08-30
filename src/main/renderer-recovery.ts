import type { BrowserWindow, RenderProcessGoneDetails } from "electron";

const RECOVERABLE_RENDERER_FAILURES = new Set<RenderProcessGoneDetails["reason"]>([
  "abnormal-exit",
  "crashed",
  "oom",
  "launch-failed",
  "integrity-failure",
  "memory-eviction"
]);

export class RendererRecoveryTracker {
  private attempts = 0;

  constructor(private readonly maximumAttempts = 2) {}

  failure(reason: RenderProcessGoneDetails["reason"]): "ignore" | "reload" | "exhausted" {
    if (!RECOVERABLE_RENDERER_FAILURES.has(reason)) return "ignore";
    if (this.attempts >= this.maximumAttempts) return "exhausted";
    this.attempts += 1;
    return "reload";
  }

  stable(): void {
    this.attempts = 0;
  }
}

export function installRendererRecovery(window: BrowserWindow, label: string, options: {
  maximumAttempts?: number;
  reloadDelayMs?: number;
  stableAfterMs?: number;
  onExhausted?: (details: RenderProcessGoneDetails) => void;
} = {}): () => void {
  const contents = window.webContents;
  const tracker = new RendererRecoveryTracker(options.maximumAttempts ?? 2);
  const reloadDelayMs = options.reloadDelayMs ?? 100;
  const stableAfterMs = options.stableAfterMs ?? 30_000;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  let stableTimer: ReturnType<typeof setTimeout> | null = null;

  const handleLoaded = (): void => {
    if (stableTimer !== null) clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      stableTimer = null;
      tracker.stable();
    }, stableAfterMs);
  };
  const handleGone = (_event: Electron.Event, details: RenderProcessGoneDetails): void => {
    process.stderr.write(`${label} renderer stopped: ${details.reason} (exit ${details.exitCode})\n`);
    if (stableTimer !== null) clearTimeout(stableTimer);
    stableTimer = null;
    const action = tracker.failure(details.reason);
    if (action === "exhausted") {
      options.onExhausted?.(details);
      return;
    }
    if (action !== "reload" || reloadTimer !== null) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (contents.isDestroyed()) return;
      process.stderr.write(`${label} renderer recovery reload started\n`);
      contents.reloadIgnoringCache();
    }, reloadDelayMs);
  };
  const dispose = (): void => {
    if (reloadTimer !== null) clearTimeout(reloadTimer);
    if (stableTimer !== null) clearTimeout(stableTimer);
    reloadTimer = null;
    stableTimer = null;
    contents.off("did-finish-load", handleLoaded);
    contents.off("render-process-gone", handleGone);
  };

  contents.on("did-finish-load", handleLoaded);
  contents.on("render-process-gone", handleGone);
  window.once("closed", dispose);
  return dispose;
}
