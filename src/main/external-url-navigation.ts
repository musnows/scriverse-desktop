import { randomUUID } from "node:crypto";
import { shell, type BrowserWindow } from "electron";
import {
  EXTERNAL_URL_REQUEST_CHANNEL,
  type ExternalUrlRequest,
  normalizeExternalHttpUrl,
  parseExternalUrlResponse
} from "../shared/external-url-contract.js";

const EXTERNAL_URL_REQUEST_TIMEOUT_MS = 30_000;

type PendingExternalUrl = {
  window: BrowserWindow;
  url: string;
  timeout: ReturnType<typeof setTimeout>;
};

function externalUrlError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

export class ExternalUrlNavigationController {
  private readonly pending = new Map<string, PendingExternalUrl>();

  request(window: BrowserWindow, target: string, channel = EXTERNAL_URL_REQUEST_CHANNEL): boolean {
    const url = normalizeExternalHttpUrl(target);
    if (!url || window.isDestroyed()) return false;
    const requestId = randomUUID();
    const timeout = setTimeout(() => {
      const request = this.pending.get(requestId);
      if (!request) return;
      this.pending.delete(requestId);
    }, EXTERNAL_URL_REQUEST_TIMEOUT_MS);
    this.pending.set(requestId, { window, url, timeout });
    try {
      const requestPayload: ExternalUrlRequest = { requestId, url };
      window.webContents.send(channel, requestPayload);
      return true;
    } catch {
      clearTimeout(timeout);
      this.pending.delete(requestId);
      return false;
    }
  }

  async respond(window: BrowserWindow, input: unknown): Promise<null> {
    const response = parseExternalUrlResponse(input);
    const request = this.pending.get(response.requestId);
    if (!request || request.window !== window || window.isDestroyed()) {
      throw externalUrlError("EXTERNAL_URL_REQUEST_EXPIRED", "外部网站跳转请求已失效，请重新点击链接");
    }
    clearTimeout(request.timeout);
    this.pending.delete(response.requestId);
    if (response.confirmed) await shell.openExternal(request.url);
    return null;
  }

  dispose(window: BrowserWindow): void {
    for (const [requestId, request] of this.pending) {
      if (request.window !== window) continue;
      clearTimeout(request.timeout);
      this.pending.delete(requestId);
    }
  }
}
