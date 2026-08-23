import { describe, expect, it } from "vitest";
import {
  parseRemoteCaptchaResponse,
  parseRemoteLoginInput,
  parseRemoteLoginResponse,
  parseRemoteSessionResponse
} from "../../src/shared/remote-auth-contract.js";

const user = {
  userId: "44444444-4444-4444-8444-444444444444",
  username: "author",
  displayName: "作者",
  role: "admin" as const,
  status: "active" as const,
  createdAt: "2026-08-23T00:00:00.000Z",
  avatarUrl: null,
  onboardingCompleted: true
};

describe("Desktop 远端登录契约", () => {
  it("严格校验 Selector 登录输入且不接受 profile 外的目标地址", () => {
    expect(parseRemoteLoginInput({
      profileId: "11111111-1111-4111-8111-111111111111",
      username: " author ",
      password: "secret-password",
      captchaId: "captcha-id",
      captchaAnswer: "A1B2"
    })).toMatchObject({ username: "author", captchaAnswer: "A1B2" });
    expect(() => parseRemoteLoginInput({
      profileId: "11111111-1111-4111-8111-111111111111",
      username: "author",
      password: "secret-password",
      captchaId: "captcha-id",
      captchaAnswer: "A1B2",
      origin: "https://attacker.example"
    })).toThrowError(/未知字段/u);
  });

  it("只接受受限 SVG data URL 验证码", () => {
    const imageDataUrl = `data:image/svg+xml;base64,${Buffer.from("<svg></svg>").toString("base64")}`;
    expect(parseRemoteCaptchaResponse({ data: { captchaId: "captcha", imageDataUrl } })).toEqual({ captchaId: "captcha", imageDataUrl });
    expect(() => parseRemoteCaptchaResponse({
      data: { captchaId: "captcha", imageDataUrl: "https://attacker.example/captcha.svg" }
    })).toThrowError(/验证码字段/u);
  });

  it("验证带前缀的 Desktop token 并仅返回公开用户字段", () => {
    expect(parseRemoteLoginResponse({
      data: { token: `scrvd_${"a".repeat(43)}`, expiresAt: "2026-09-23T00:00:00.000Z", user }
    })).toMatchObject({ user: { userId: user.userId }, token: expect.stringMatching(/^scrvd_/u) });
    expect(parseRemoteSessionResponse({ data: { authenticated: true, user, csrfToken: null, bootId: "boot" } })).toEqual({
      authenticated: true,
      user
    });
    expect(parseRemoteSessionResponse({ data: { authenticated: false, user: null } })).toEqual({ authenticated: false, user: null });
  });
});
