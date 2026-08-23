import type { RemoteWorkspaceProfile } from "../shared/contracts.js";
import { isLoopbackOrigin } from "../shared/profile-url.js";
import {
  REMOTE_AUTH_MAX_RESPONSE_BYTES,
  REMOTE_AUTH_REQUEST_TIMEOUT_MS,
  parseRemoteApiError,
  parseRemoteCaptchaResponse,
  parseRemoteLoginResponse,
  parseRemoteSessionResponse,
  type RemoteLoginChallenge,
  type RemoteLoginInput,
  type RemoteLoginResult,
  type RemoteSessionState
} from "../shared/remote-auth-contract.js";

export class RemoteAuthClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteAuthClientError";
  }
}

async function readLimitedText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > REMOTE_AUTH_MAX_RESPONSE_BYTES) {
    throw new RemoteAuthClientError("REMOTE_AUTH_RESPONSE_TOO_LARGE", "Server 响应超过 Desktop 登录上限");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > REMOTE_AUTH_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new RemoteAuthClientError("REMOTE_AUTH_RESPONSE_TOO_LARGE", "Server 响应超过 Desktop 登录上限");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch {
    throw new RemoteAuthClientError("REMOTE_AUTH_RESPONSE_INVALID", "Server 返回了无效 UTF-8 响应");
  }
}

function requestUrl(profile: RemoteWorkspaceProfile, pathname: string): string {
  const origin = new URL(profile.origin);
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && isLoopbackOrigin(profile.origin))) {
    throw new RemoteAuthClientError(
      "REMOTE_INSECURE_ORIGIN_FORBIDDEN",
      "远端登录默认要求 HTTPS；仅回环地址可直接使用 HTTP"
    );
  }
  return new URL(pathname, `${origin.origin}/`).href;
}

export class RemoteAuthClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async request(
    profile: RemoteWorkspaceProfile,
    pathname: string,
    init: RequestInit,
    expectedStatus: number
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REMOTE_AUTH_REQUEST_TIMEOUT_MS);
    try {
      const url = requestUrl(profile, pathname);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new RemoteAuthClientError("REMOTE_AUTH_TIMEOUT", "Server 登录请求超时");
        }
        throw new RemoteAuthClientError("REMOTE_AUTH_NETWORK_ERROR", "无法连接 Server，请检查地址、网络和证书");
      }
      const text = await readLimitedText(response);
      let value: unknown = null;
      if (text.length > 0) {
        try {
          value = JSON.parse(text) as unknown;
        } catch {
          throw new RemoteAuthClientError("REMOTE_AUTH_RESPONSE_INVALID", "Server 返回了无效 JSON");
        }
      }
      if (response.status !== expectedStatus) throw parseRemoteApiError(value, response.status);
      return value;
    } finally {
      clearTimeout(timeout);
    }
  }

  async captcha(profile: RemoteWorkspaceProfile): Promise<RemoteLoginChallenge> {
    const value = await this.request(profile, "/api/auth/captcha", {
      method: "GET",
      headers: { Accept: "application/json" }
    }, 200);
    return parseRemoteCaptchaResponse(value);
  }

  async login(
    profile: RemoteWorkspaceProfile,
    input: RemoteLoginInput,
    desktopId: string,
    clientVersion: string
  ): Promise<RemoteLoginResult> {
    const value = await this.request(profile, "/api/desktop/auth/login", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        username: input.username,
        password: input.password,
        captchaId: input.captchaId,
        captchaAnswer: input.captchaAnswer,
        desktopId,
        profileId: profile.id,
        clientVersion
      })
    }, 200);
    return parseRemoteLoginResponse(value);
  }

  async session(profile: RemoteWorkspaceProfile, token: string): Promise<RemoteSessionState> {
    const value = await this.request(profile, "/api/auth/session", {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
    }, 200);
    return parseRemoteSessionResponse(value);
  }

  async revoke(profile: RemoteWorkspaceProfile, token: string): Promise<void> {
    await this.request(profile, "/api/auth/session", {
      method: "DELETE",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
    }, 204);
  }
}
