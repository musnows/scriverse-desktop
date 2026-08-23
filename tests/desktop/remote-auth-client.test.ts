import { describe, expect, it, vi } from "vitest";
import { RemoteAuthClient } from "../../src/main/remote-auth-client.js";
import { remotePartition, type RemoteWorkspaceProfile } from "../../src/shared/contracts.js";

function profile(origin = "https://server.example"): RemoteWorkspaceProfile {
  const id = "11111111-1111-4111-8111-111111111111";
  return {
    id,
    name: "Remote",
    kind: "remote",
    origin,
    partition: remotePartition(id),
    createdAt: "2026-08-23T00:00:00.000Z",
    lastUsedAt: null,
    capabilities: null
  };
}

const user = {
  userId: "44444444-4444-4444-8444-444444444444",
  username: "author",
  displayName: "作者",
  role: "admin",
  status: "active",
  createdAt: "2026-08-23T00:00:00.000Z",
  avatarUrl: null,
  onboardingCompleted: true,
  isSystemAdmin: true
};

describe("Desktop 直连 Server 登录客户端", () => {
  it("不携带 Cookie 获取验证码并禁止重定向", async () => {
    const imageDataUrl = `data:image/svg+xml;base64,${Buffer.from("<svg></svg>").toString("base64")}`;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: { captchaId: "captcha", imageDataUrl }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await new RemoteAuthClient(fetchImpl).captcha(profile());
    expect(result).toEqual({ captchaId: "captcha", imageDataUrl });
    expect(fetchImpl).toHaveBeenCalledWith("https://server.example/api/auth/captcha", expect.objectContaining({
      credentials: "omit",
      redirect: "error"
    }));
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Cookie");
  });

  it("把软件和 profile 身份直传登录端点且只用 Bearer 验证", async () => {
    const token = `scrvd_${"a".repeat(43)}`;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { token, expiresAt: "2026-09-23T00:00:00.000Z", user }
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { authenticated: true, user, csrfToken: null }
      }), { status: 200 }));
    const client = new RemoteAuthClient(fetchImpl);
    await client.login(profile(), {
      profileId: "11111111-1111-4111-8111-111111111111",
      username: "author",
      password: "secret-password",
      captchaId: "captcha",
      captchaAnswer: "A1B2"
    }, "22222222-2222-4222-8222-222222222222", "0.8.7");
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      desktopId: "22222222-2222-4222-8222-222222222222",
      profileId: "11111111-1111-4111-8111-111111111111",
      clientVersion: "0.8.7"
    });
    await client.session(profile(), token);
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
  });

  it("拒绝公网 HTTP 和超大响应", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(new RemoteAuthClient(fetchImpl).captcha(profile("http://server.example"))).rejects.toMatchObject({
      code: "REMOTE_INSECURE_ORIGIN_FORBIDDEN"
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const oversized = vi.fn<typeof fetch>().mockResolvedValue(new Response("x", {
      status: 200,
      headers: { "content-length": String(300 * 1024) }
    }));
    await expect(new RemoteAuthClient(oversized).captcha(profile())).rejects.toMatchObject({
      code: "REMOTE_AUTH_RESPONSE_TOO_LARGE"
    });
  });
});
