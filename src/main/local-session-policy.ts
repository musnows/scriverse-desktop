import { session, type Session } from "electron";
import { LOCAL_PROFILE_PARTITION } from "../shared/contracts.js";
import { remoteRequestHeaders, remoteResponseHeaders } from "../shared/remote-session-headers.js";
import { normalizeLocalWorkspaceOrigin } from "../shared/workspace-url.js";

export class LocalSessionPolicy {
  private token: string | null = null;
  private origin: string | null = null;
  readonly electronSession: Session;

  constructor() {
    this.electronSession = session.fromPartition(LOCAL_PROFILE_PARTITION);
    this.electronSession.setPermissionCheckHandler(() => false);
    this.electronSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    this.electronSession.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({
        requestHeaders: remoteRequestHeaders(
          details.requestHeaders,
          details.url,
          this.origin ?? "http://127.0.0.1",
          this.token
        ) as Record<string, string>
      });
    });
    this.electronSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: details.responseHeaders
          ? remoteResponseHeaders(details.responseHeaders) as Record<string, string[]>
          : undefined
      });
    });
  }

  authorize(origin: string, token: string): Session {
    if (!/^scrvd_[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error("本地 Desktop token 无效");
    this.origin = normalizeLocalWorkspaceOrigin(origin);
    this.token = token;
    return this.electronSession;
  }

  clear(): void {
    this.origin = null;
    this.token = null;
  }
}
