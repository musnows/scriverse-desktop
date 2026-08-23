import type { RemoteWorkspaceProfile } from "../shared/contracts.js";
import type {
  RemoteAuthUser,
  RemoteLoginChallenge,
  RemoteLoginInput,
  RemoteProfileOpenResult
} from "../shared/remote-auth-contract.js";
import { RemoteAuthClient, RemoteAuthClientError } from "./remote-auth-client.js";
import { RemoteAuthStore, RemoteAuthStoreError, type StoredRemoteCredential } from "./remote-auth-store.js";
import { RemoteSessionRegistry } from "./remote-session-policy.js";

export class RemoteAuthCoordinator {
  private readonly activeUsers = new Map<string, RemoteAuthUser>();
  private readonly activeModes = new Map<string, "online" | "offline">();

  constructor(
    private readonly desktopId: string,
    private readonly desktopVersion: string,
    private readonly store: RemoteAuthStore,
    private readonly client: RemoteAuthClient,
    private readonly sessions: RemoteSessionRegistry,
    private readonly openWorkspace: (profile: RemoteWorkspaceProfile, mode: "online" | "offline") => Promise<void>,
    private readonly canOpenOffline: (profile: RemoteWorkspaceProfile, user: RemoteAuthUser) => boolean = () => false
  ) {}

  private isConnectivityError(error: unknown): boolean {
    return error instanceof RemoteAuthClientError
      && (error.code === "REMOTE_AUTH_NETWORK_ERROR" || error.code === "REMOTE_AUTH_TIMEOUT");
  }

  private readCredential(profile: RemoteWorkspaceProfile): StoredRemoteCredential | null {
    try {
      return this.store.load(profile);
    } catch (error) {
      if (
        error instanceof RemoteAuthStoreError
        && (error.code === "REMOTE_AUTH_DECRYPT_FAILED" || error.code === "REMOTE_AUTH_STORE_INVALID")
      ) {
        this.store.clear(profile);
        return null;
      }
      throw error;
    }
  }

  private async challenge(profile: RemoteWorkspaceProfile): Promise<RemoteLoginChallenge> {
    return this.client.captcha(profile);
  }

  async open(profile: RemoteWorkspaceProfile): Promise<RemoteProfileOpenResult> {
    const credential = this.readCredential(profile);
    if (credential && Date.parse(credential.expiresAt) > Date.now()) {
      try {
        const state = await this.client.session(profile, credential.token);
        if (state.authenticated && state.user?.userId === credential.user.userId) {
          this.activeUsers.set(profile.id, state.user);
          this.activeModes.set(profile.id, "online");
          this.sessions.authorize(profile, credential.token);
          await this.openWorkspace(profile, "online");
          return { status: "opened", mode: "online" };
        }
        this.sessions.clear(profile.id);
        this.activeUsers.delete(profile.id);
        this.activeModes.delete(profile.id);
        this.store.clear(profile);
      } catch (error) {
        if (!this.isConnectivityError(error) || !this.canOpenOffline(profile, credential.user)) throw error;
        this.activeUsers.set(profile.id, credential.user);
        this.activeModes.set(profile.id, "offline");
        this.sessions.authorize(profile, credential.token);
        await this.openWorkspace(profile, "offline");
        return { status: "opened", mode: "offline" };
      }
    } else if (credential) {
      this.sessions.clear(profile.id);
      this.activeUsers.delete(profile.id);
      this.activeModes.delete(profile.id);
      this.store.clear(profile);
    }
    return { status: "login-required", challenge: await this.challenge(profile) };
  }

  refreshChallenge(profile: RemoteWorkspaceProfile): Promise<RemoteLoginChallenge> {
    return this.challenge(profile);
  }

  async login(profile: RemoteWorkspaceProfile, input: RemoteLoginInput): Promise<RemoteAuthUser> {
    this.store.assertAvailable();
    const result = await this.client.login(profile, input, this.desktopId, this.desktopVersion);
    try {
      this.store.save(profile, result);
    } catch (error) {
      await this.client.revoke(profile, result.token).catch(() => undefined);
      throw error;
    }
    this.sessions.authorize(profile, result.token);
    this.activeUsers.set(profile.id, result.user);
    this.activeModes.set(profile.id, "online");
    await this.openWorkspace(profile, "online");
    return result.user;
  }

  async authorizeOfflineKey(profile: RemoteWorkspaceProfile, userId: string): Promise<{
    user: RemoteAuthUser;
    verifiedOnline: boolean;
  }> {
    const credential = this.readCredential(profile);
    if (!credential || Date.parse(credential.expiresAt) <= Date.now()) {
      this.sessions.clear(profile.id);
      this.activeUsers.delete(profile.id);
      this.activeModes.delete(profile.id);
      if (credential) this.store.clear(profile);
      const error = new Error("远端 Desktop 登录已失效，请重新登录后开启离线") as Error & { code: string };
      error.code = "REMOTE_LOGIN_REQUIRED";
      throw error;
    }
    if (credential.user.userId !== userId) {
      const error = new Error("页面用户与当前 Desktop 登录不一致") as Error & { code: string };
      error.code = "OFFLINE_USER_MISMATCH";
      throw error;
    }
    if (this.activeModes.get(profile.id) === "offline") {
      return { user: credential.user, verifiedOnline: false };
    }
    let state;
    try {
      state = await this.client.session(profile, credential.token);
    } catch (error) {
      if (!this.isConnectivityError(error) || !this.canOpenOffline(profile, credential.user)) throw error;
      return { user: credential.user, verifiedOnline: false };
    }
    if (!state.authenticated || !state.user || state.user.userId !== credential.user.userId) {
      this.sessions.clear(profile.id);
      this.activeUsers.delete(profile.id);
      this.activeModes.delete(profile.id);
      this.store.clear(profile);
      const error = new Error("远端 Desktop 登录已失效，请重新登录后开启离线") as Error & { code: string };
      error.code = "REMOTE_LOGIN_REQUIRED";
      throw error;
    }
    return { user: state.user, verifiedOnline: true };
  }

  cachedUser(profile: RemoteWorkspaceProfile): RemoteAuthUser | null {
    return this.activeUsers.get(profile.id) ?? null;
  }

  connectionMode(profile: RemoteWorkspaceProfile): "online" | "offline" | null {
    return this.activeModes.get(profile.id) ?? null;
  }

  async forget(profile: RemoteWorkspaceProfile): Promise<void> {
    let credential: StoredRemoteCredential | null = null;
    try {
      credential = this.store.load(profile);
    } catch {
      // 无法读取的密文仍会在本机改写为登出状态。
    }
    if (credential) await this.client.revoke(profile, credential.token).catch(() => undefined);
    this.sessions.clear(profile.id);
    this.activeUsers.delete(profile.id);
    this.activeModes.delete(profile.id);
    this.store.clear(profile);
    await this.sessions.clearStorage(profile);
  }
}
