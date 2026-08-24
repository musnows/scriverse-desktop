import type { BrowserWindow } from "electron";

const workspaceLoadingCoverCss = `
html::before {
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483646 !important;
  display: block !important;
  background: #f3efe7 !important;
  content: "" !important;
}
html::after {
  position: fixed !important;
  top: 50% !important;
  left: 50% !important;
  z-index: 2147483647 !important;
  width: 30px !important;
  height: 30px !important;
  margin: -18px 0 0 -18px !important;
  border: 3px solid rgba(154, 73, 56, .22) !important;
  border-top-color: #9a4938 !important;
  border-radius: 50% !important;
  content: "" !important;
  animation: scriverse-desktop-workspace-loading .8s linear infinite !important;
}
@keyframes scriverse-desktop-workspace-loading { to { transform: rotate(360deg); } }
@media (prefers-color-scheme: dark) {
  html::before { background: #171715 !important; }
  html::after { border-color: rgba(195, 106, 85, .25) !important; border-top-color: #c36a55 !important; }
}
@media (prefers-reduced-motion: reduce) {
  html::after { animation-duration: 2s !important; }
}`;

const workspaceReadyScript = `Boolean(document.body && !document.body.classList.contains("auth-pending"))`;
const readinessTimeoutMs = 10_000;
const readinessPollMs = 50;

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

export function createWorkspaceLoadingCover(window: BrowserWindow): {
  prepare: () => Promise<void>;
  revealWhenReady: () => Promise<void>;
  dispose: () => void;
} {
  let cssKey: string | null = null;
  let preparePromise: Promise<void> | null = null;
  let disposed = false;

  const prepare = (): Promise<void> => {
    if (preparePromise) return preparePromise;
    preparePromise = window.webContents.insertCSS(workspaceLoadingCoverCss)
      .then((key) => { cssKey = key; });
    return preparePromise;
  };

  const remove = async (): Promise<void> => {
    const key = cssKey;
    cssKey = null;
    if (!key || window.isDestroyed() || window.webContents.isDestroyed()) return;
    await window.webContents.removeInsertedCSS(key).catch(() => undefined);
  };

  const revealWhenReady = async (): Promise<void> => {
    const deadline = Date.now() + readinessTimeoutMs;
    while (!disposed && !window.isDestroyed() && Date.now() < deadline) {
      const ready = await window.webContents.executeJavaScript(workspaceReadyScript)
        .then((value) => value === true)
        .catch(() => false);
      if (ready) break;
      await delay(readinessPollMs);
    }
    await remove();
  };

  const dispose = (): void => {
    disposed = true;
    void remove();
  };

  return { prepare, revealWhenReady, dispose };
}
