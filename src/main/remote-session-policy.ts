import { session, type Session } from "electron";
import type { RemoteWorkspaceProfile } from "../shared/contracts.js";
import { remoteRequestHeaders, remoteResponseHeaders } from "../shared/remote-session-headers.js";

export class RemoteSessionPolicyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteSessionPolicyError";
  }
}

class RemoteSessionPolicy {
  private token: string | null = null;

  constructor(
    readonly profileId: string,
    readonly origin: string,
    readonly partition: string,
    readonly electronSession: Session
  ) {
    electronSession.setPermissionCheckHandler(() => false);
    electronSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    electronSession.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({
        requestHeaders: remoteRequestHeaders(details.requestHeaders, details.url, this.origin, this.token) as Record<string, string>
      });
    });
    electronSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: details.responseHeaders
          ? remoteResponseHeaders(details.responseHeaders) as Record<string, string[]>
          : undefined
      });
    });
  }

  authorize(token: string): void {
    this.token = token;
  }

  clear(): void {
    this.token = null;
  }
}

export class RemoteSessionRegistry {
  private readonly policies = new Map<string, RemoteSessionPolicy>();

  authorize(profile: RemoteWorkspaceProfile, token: string): Session {
    let policy = this.policies.get(profile.id);
    if (!policy) {
      policy = new RemoteSessionPolicy(
        profile.id,
        profile.origin,
        profile.partition,
        session.fromPartition(profile.partition)
      );
      this.policies.set(profile.id, policy);
    } else if (policy.origin !== profile.origin || policy.partition !== profile.partition) {
      throw new RemoteSessionPolicyError("REMOTE_SESSION_PROFILE_MISMATCH", "远端浏览器分区与 profile 不匹配");
    }
    policy.authorize(token);
    return policy.electronSession;
  }

  clear(profileId: string): void {
    this.policies.get(profileId)?.clear();
  }

  async clearStorage(profile: RemoteWorkspaceProfile): Promise<void> {
    const policy = this.policies.get(profile.id);
    if (policy && (policy.origin !== profile.origin || policy.partition !== profile.partition)) {
      throw new RemoteSessionPolicyError("REMOTE_SESSION_PROFILE_MISMATCH", "远端浏览器分区与 profile 不匹配");
    }
    policy?.clear();
    const electronSession = policy?.electronSession ?? session.fromPartition(profile.partition);
    await electronSession.flushStorageData();
    await electronSession.clearStorageData();
    await electronSession.clearCache();
    await electronSession.clearAuthCache();
    this.policies.delete(profile.id);
  }
}
