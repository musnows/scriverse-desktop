import { describe, expect, it, vi } from "vitest";
import { RemoteAuthCoordinator } from "../../src/main/remote-auth-coordinator.js";
import { RemoteAuthClientError, type RemoteAuthClient } from "../../src/main/remote-auth-client.js";
import type { RemoteAuthStore } from "../../src/main/remote-auth-store.js";
import type { RemoteSessionRegistry } from "../../src/main/remote-session-policy.js";
import { remotePartition, type RemoteWorkspaceProfile } from "../../src/shared/contracts.js";

const profile: RemoteWorkspaceProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Remote",
  kind: "remote",
  origin: "https://server.example",
  partition: remotePartition("11111111-1111-4111-8111-111111111111"),
  createdAt: "2026-08-23T00:00:00.000Z",
  lastUsedAt: null,
  capabilities: null
};
const user = {
  userId: "44444444-4444-4444-8444-444444444444",
  username: "author",
  displayName: "作者",
  role: "admin" as const,
  status: "active" as const,
  createdAt: "2026-08-23T00:00:00.000Z",
  avatarUrl: null,
  onboardingCompleted: true,
  isSystemAdmin: true
};

describe("Desktop 远端登录编排", () => {
  it("重启后先验证软件内密文令牌再打开同一 profile", async () => {
    const token = `scrvd_${"a".repeat(43)}`;
    const store = {
      load: vi.fn().mockReturnValue({ token, expiresAt: "2099-09-23T00:00:00.000Z", user }),
      clear: vi.fn()
    };
    const client = { session: vi.fn().mockResolvedValue({ authenticated: true, user }), captcha: vi.fn() };
    const sessions = { authorize: vi.fn(), clear: vi.fn() };
    const openWorkspace = vi.fn().mockResolvedValue(undefined);
    const coordinator = new RemoteAuthCoordinator(
      "22222222-2222-4222-8222-222222222222",
      "0.8.7",
      store as unknown as RemoteAuthStore,
      client as unknown as RemoteAuthClient,
      sessions as unknown as RemoteSessionRegistry,
      openWorkspace
    );
    await expect(coordinator.open(profile)).resolves.toEqual({ status: "opened", mode: "online" });
    expect(sessions.authorize).toHaveBeenCalledWith(profile, token);
    expect(openWorkspace).toHaveBeenCalledWith(profile, "online");
    expect(client.captcha).not.toHaveBeenCalled();
  });

  it("Server 断线时仅凭已有离线密钥和软件内登录打开缓存工作区", async () => {
    const token = `scrvd_${"c".repeat(43)}`;
    const store = {
      load: vi.fn().mockReturnValue({ token, expiresAt: "2099-09-23T00:00:00.000Z", user }),
      clear: vi.fn()
    };
    const networkError = new RemoteAuthClientError("REMOTE_AUTH_NETWORK_ERROR", "offline");
    const client = { session: vi.fn().mockRejectedValue(networkError), captcha: vi.fn() };
    const sessions = { authorize: vi.fn(), clear: vi.fn() };
    const openWorkspace = vi.fn().mockResolvedValue(undefined);
    const coordinator = new RemoteAuthCoordinator(
      "22222222-2222-4222-8222-222222222222",
      "0.8.7",
      store as unknown as RemoteAuthStore,
      client as unknown as RemoteAuthClient,
      sessions as unknown as RemoteSessionRegistry,
      openWorkspace,
      () => true
    );
    await expect(coordinator.open(profile)).resolves.toEqual({ status: "opened", mode: "offline" });
    await expect(coordinator.authorizeOfflineKey(profile, user.userId)).resolves.toEqual({ user, verifiedOnline: false });
    expect(openWorkspace).toHaveBeenCalledWith(profile, "offline");
    expect(client.session).toHaveBeenCalledTimes(1);
    expect(sessions.authorize).toHaveBeenCalledWith(profile, token);
    expect(client.captcha).not.toHaveBeenCalled();
  });

  it("没有令牌时返回验证码，登录成功后只向 Main 交付用户", async () => {
    const token = `scrvd_${"b".repeat(43)}`;
    const challenge = { captchaId: "captcha", imageDataUrl: `data:image/svg+xml;base64,${Buffer.from("<svg></svg>").toString("base64")}` };
    const store = {
      load: vi.fn().mockReturnValue(null),
      clear: vi.fn(),
      assertAvailable: vi.fn(),
      save: vi.fn()
    };
    const client = {
      captcha: vi.fn().mockResolvedValue(challenge),
      login: vi.fn().mockResolvedValue({ token, expiresAt: "2099-09-23T00:00:00.000Z", user }),
      revoke: vi.fn()
    };
    const sessions = { authorize: vi.fn(), clear: vi.fn() };
    const coordinator = new RemoteAuthCoordinator(
      "22222222-2222-4222-8222-222222222222",
      "0.8.7",
      store as unknown as RemoteAuthStore,
      client as unknown as RemoteAuthClient,
      sessions as unknown as RemoteSessionRegistry,
      vi.fn().mockResolvedValue(undefined)
    );
    await expect(coordinator.open(profile)).resolves.toEqual({ status: "login-required", challenge });
    const result = await coordinator.login(profile, {
      profileId: profile.id,
      username: "author",
      password: "secret-password",
      captchaId: "captcha",
      captchaAnswer: "A1B2"
    });
    expect(result).toEqual(user);
    expect(result).not.toHaveProperty("token");
    expect(store.save).toHaveBeenCalledWith(profile, expect.objectContaining({ token }));
    expect(sessions.authorize).toHaveBeenCalledWith(profile, token);
  });

  it("删除 profile 时撤销软件令牌并清空整个独立浏览器分区", async () => {
    const token = `scrvd_${"d".repeat(43)}`;
    const store = {
      load: vi.fn().mockReturnValue({ token, expiresAt: "2099-09-23T00:00:00.000Z", user }),
      clear: vi.fn()
    };
    const client = { revoke: vi.fn().mockResolvedValue(undefined) };
    const sessions = { clear: vi.fn(), clearStorage: vi.fn().mockResolvedValue(undefined) };
    const coordinator = new RemoteAuthCoordinator(
      "22222222-2222-4222-8222-222222222222",
      "0.8.7",
      store as unknown as RemoteAuthStore,
      client as unknown as RemoteAuthClient,
      sessions as unknown as RemoteSessionRegistry,
      vi.fn().mockResolvedValue(undefined)
    );
    await coordinator.forget(profile);
    expect(client.revoke).toHaveBeenCalledWith(profile, token);
    expect(store.clear).toHaveBeenCalledWith(profile);
    expect(sessions.clear).toHaveBeenCalledWith(profile.id);
    expect(sessions.clearStorage).toHaveBeenCalledWith(profile);
  });
});
