export const REMOTE_AUTH_REQUEST_TIMEOUT_MS = 15_000;
export const REMOTE_AUTH_MAX_RESPONSE_BYTES = 256 * 1024;
export const REMOTE_AUTH_TOKEN_PREFIX = "scrvd_";

export type RemoteAuthUser = {
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  createdAt: string;
  avatarUrl: string | null;
  onboardingCompleted: boolean;
};

export type RemoteLoginChallenge = {
  captchaId: string;
  imageDataUrl: string;
};

export type RemoteLoginInput = {
  profileId: string;
  username: string;
  password: string;
  captchaId: string;
  captchaAnswer: string;
};

export type RemoteLoginResult = {
  token: string;
  expiresAt: string;
  user: RemoteAuthUser;
};

export type RemoteSessionState = {
  authenticated: boolean;
  user: RemoteAuthUser | null;
};

export type RemoteProfileOpenResult =
  | { status: "opened"; mode: "online" | "offline" }
  | { status: "login-required"; challenge: RemoteLoginChallenge };

export class RemoteAuthContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteAuthContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RemoteAuthContractError("REMOTE_AUTH_RESPONSE_INVALID", `${label} 包含未知字段`);
  }
}

function assertUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new RemoteAuthContractError("REMOTE_AUTH_INPUT_INVALID", `${label} 无效`);
  }
  return value;
}

export function parseRemoteAuthUser(value: unknown): RemoteAuthUser {
  if (!isRecord(value)) throw new RemoteAuthContractError("REMOTE_AUTH_RESPONSE_INVALID", "Server 返回的用户信息无效");
  assertExactKeys(value, ["userId", "username", "displayName", "role", "status", "createdAt", "avatarUrl", "onboardingCompleted"], "Server 用户信息");
  if (
    typeof value.userId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.userId)
    || typeof value.username !== "string" || value.username.length === 0 || value.username.length > 100
    || typeof value.displayName !== "string" || value.displayName.length === 0 || value.displayName.length > 200
    || (value.role !== "admin" && value.role !== "user")
    || (value.status !== "active" && value.status !== "disabled")
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || (value.avatarUrl !== null && (typeof value.avatarUrl !== "string" || value.avatarUrl.length > 2_048))
    || typeof value.onboardingCompleted !== "boolean"
  ) throw new RemoteAuthContractError("REMOTE_AUTH_RESPONSE_INVALID", "Server 返回的用户字段无效");
  return value as RemoteAuthUser;
}

export function parseRemoteLoginInput(value: unknown): RemoteLoginInput {
  if (!isRecord(value)) throw new RemoteAuthContractError("REMOTE_AUTH_INPUT_INVALID", "远端登录请求无效");
  const allowed = new Set(["profileId", "username", "password", "captchaId", "captchaAnswer"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RemoteAuthContractError("REMOTE_AUTH_INPUT_INVALID", "远端登录请求包含未知字段");
  }
  const profileId = assertUuid(value.profileId, "profile id");
  const username = typeof value.username === "string" ? value.username.trim() : "";
  if (username.length === 0 || username.length > 100) {
    throw new RemoteAuthContractError("REMOTE_USERNAME_INVALID", "用户名长度必须在 1 到 100 个字符之间");
  }
  if (typeof value.password !== "string" || value.password.length === 0 || value.password.length > 200) {
    throw new RemoteAuthContractError("REMOTE_PASSWORD_INVALID", "密码长度必须在 1 到 200 个字符之间");
  }
  const captchaId = typeof value.captchaId === "string" ? value.captchaId.trim() : "";
  const captchaAnswer = typeof value.captchaAnswer === "string" ? value.captchaAnswer.trim() : "";
  if (captchaId.length === 0 || captchaId.length > 200 || captchaAnswer.length === 0 || captchaAnswer.length > 16) {
    throw new RemoteAuthContractError("REMOTE_CAPTCHA_INVALID", "验证码无效，请刷新后重试");
  }
  return { profileId, username, password: value.password, captchaId, captchaAnswer };
}

export function parseRemoteCaptchaResponse(value: unknown): RemoteLoginChallenge {
  if (!isRecord(value)) throw new RemoteAuthContractError("REMOTE_AUTH_RESPONSE_INVALID", "Server 验证码响应无效");
  assertExactKeys(value, ["data"], "Server 验证码响应");
  if (!isRecord(value.data)) throw new RemoteAuthContractError("REMOTE_AUTH_RESPONSE_INVALID", "Server 验证码数据无效");
  assertExactKeys(value.data, ["captchaId", "imageDataUrl", "answer"], "Server 验证码数据");
  if (
    typeof value.data.captchaId !== "string" || value.data.captchaId.length === 0 || value.data.captchaId.length > 200
    || typeof value.data.imageDataUrl !== "string"
    || value.data.imageDataUrl.length > 200_000
    || !/^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/u.test(value.data.imageDataUrl)
    || (value.data.answer !== undefined && (typeof value.data.answer !== "string" || value.data.answer.length > 16))
  ) throw new RemoteAuthContractError("REMOTE_AUTH_RESPONSE_INVALID", "Server 验证码字段无效");
  return { captchaId: value.data.captchaId, imageDataUrl: value.data.imageDataUrl };
}

export function parseRemoteLoginResponse(value: unknown): RemoteLoginResult {
  if (!isRecord(value)) throw new RemoteAuthContractError("REMOTE_AUTH_RESPONSE_INVALID", "Server 登录响应无效");
  assertExactKeys(value, ["data"], "Server 登录响应");
  if (!isRecord(value.data)) throw new RemoteAuthContractError("REMOTE_AUTH_RESPONSE_INVALID", "Server 登录数据无效");
  assertExactKeys(value.data, ["token", "expiresAt", "user"], "Server 登录数据");
  if (
    typeof value.data.token !== "string"
    || !new RegExp(`^${REMOTE_AUTH_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`, "u").test(value.data.token)
    || typeof value.data.expiresAt !== "string"
    || !Number.isFinite(Date.parse(value.data.expiresAt))
  ) throw new RemoteAuthContractError("REMOTE_AUTH_RESPONSE_INVALID", "Server 登录凭据无效");
  return { token: value.data.token, expiresAt: value.data.expiresAt, user: parseRemoteAuthUser(value.data.user) };
}

export function parseRemoteSessionResponse(value: unknown): RemoteSessionState {
  if (!isRecord(value) || !isRecord(value.data) || typeof value.data.authenticated !== "boolean") {
    throw new RemoteAuthContractError("REMOTE_AUTH_RESPONSE_INVALID", "Server 会话响应无效");
  }
  if (!value.data.authenticated) return { authenticated: false, user: null };
  return { authenticated: true, user: parseRemoteAuthUser(value.data.user) };
}

export function parseRemoteApiError(value: unknown, fallbackStatus: number): RemoteAuthContractError {
  const error = isRecord(value) && isRecord(value.error) ? value.error : null;
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/u.test(error.code)
    ? error.code
    : `REMOTE_HTTP_${fallbackStatus}`;
  const message = typeof error?.message === "string" && error.message.length > 0 && error.message.length <= 300
    ? error.message
    : `Server 请求失败（HTTP ${fallbackStatus}）`;
  return new RemoteAuthContractError(code, message);
}
