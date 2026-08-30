import { createHash, createSign } from "node:crypto";
import {
  parseGoogleServiceAccount,
  type GoogleServiceAccountCredential,
  type LocalAiProviderInput
} from "../shared/local-ai-contract.js";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GOOGLE_TOKEN_EXPIRY_SKEW_MS = 60_000;

type LocalAiProviderCredential = Pick<LocalAiProviderInput, "protocol" | "apiKey"> & { id: string };

type CachedGoogleToken = {
  accessToken: string;
  expiresAt: number;
};

export class LocalAiProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalAiProtocolError";
  }
}

function normalizedProviderBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "").replace(/\/(?:chat\/completions|messages|responses)$/u, "");
}

function versionedEndpoint(baseUrl: string, resource: string): string {
  const normalized = normalizedProviderBaseUrl(baseUrl);
  return /\/v1$/u.test(normalized) ? `${normalized}/${resource}` : `${normalized}/v1/${resource}`;
}

export function localAiCompletionUrl(baseUrl: string, protocol: LocalAiProviderInput["protocol"]): string {
  if (protocol === "anthropic-messages") return versionedEndpoint(baseUrl, "messages");
  if (protocol === "openai-responses") return versionedEndpoint(baseUrl, "responses");
  return `${normalizedProviderBaseUrl(baseUrl)}/chat/completions`;
}

export function localAiEmbeddingUrl(baseUrl: string): string {
  return versionedEndpoint(baseUrl, "embeddings");
}

export function localAiLegacyCompletionUrl(baseUrl: string): string {
  return versionedEndpoint(baseUrl, "completions");
}

export function localAiRequestHeaders(
  protocol: LocalAiProviderInput["protocol"],
  accessToken: string,
  accept: "application/json" | "text/event-stream"
): Record<string, string> {
  return {
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...(protocol === "anthropic-messages" && accessToken
      ? { "x-api-key": accessToken, "anthropic-version": "2023-06-01" }
      : protocol === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}),
    "Content-Type": "application/json",
    Accept: accept
  };
}

function base64Url(value: string | Buffer): string {
  return (typeof value === "string" ? Buffer.from(value, "utf8") : value).toString("base64url");
}

function googleServiceAccountJwt(account: GoogleServiceAccountCredential, nowSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: account.client_email,
    sub: account.client_email,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3_600,
    scope: GOOGLE_CLOUD_PLATFORM_SCOPE
  }));
  const unsigned = `${header}.${payload}`;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${base64Url(signer.sign(account.private_key))}`;
  } catch {
    throw new LocalAiProtocolError("LOCAL_AI_SERVICE_ACCOUNT_INVALID", "服务账号私钥无法用于签名");
  }
}

export class LocalAiCredentialResolver {
  private readonly tokens = new Map<string, CachedGoogleToken>();

  constructor(private readonly fetch: typeof globalThis.fetch) {}

  async accessToken(provider: LocalAiProviderCredential, signal?: AbortSignal): Promise<string> {
    if (provider.protocol !== "google-vertex") return provider.apiKey;
    if (!provider.apiKey) throw new LocalAiProtocolError("LOCAL_AI_SERVICE_ACCOUNT_REQUIRED", "Google Vertex 需要服务账号 JSON");
    const fingerprint = createHash("sha256").update(provider.apiKey).digest("hex");
    const cacheKey = `${provider.id}:${fingerprint}`;
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt - GOOGLE_TOKEN_EXPIRY_SKEW_MS > Date.now()) return cached.accessToken;
    const account = parseGoogleServiceAccount(provider.apiKey);
    const jwt = googleServiceAccountJwt(account, Math.floor(Date.now() / 1_000));
    let response: Response;
    try {
      response = await this.fetch(GOOGLE_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt
        }).toString(),
        cache: "no-store",
        redirect: "error",
        signal
      });
    } catch {
      throw new LocalAiProtocolError("LOCAL_AI_VERTEX_TOKEN_NETWORK_ERROR", "无法连接 Google OAuth 换票服务");
    }
    const text = await response.text();
    if (!response.ok) throw new LocalAiProtocolError("LOCAL_AI_VERTEX_TOKEN_FAILED", `Google OAuth 换票失败（HTTP ${response.status}）`);
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new LocalAiProtocolError("LOCAL_AI_VERTEX_TOKEN_INVALID", "Google OAuth 换票返回了无效 JSON");
    }
    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    const accessToken = typeof record.access_token === "string" ? record.access_token.trim() : "";
    if (!accessToken) throw new LocalAiProtocolError("LOCAL_AI_VERTEX_TOKEN_INVALID", "Google OAuth 换票响应缺少 access_token");
    const expiresIn = typeof record.expires_in === "number" && Number.isFinite(record.expires_in) && record.expires_in > 0
      ? record.expires_in
      : 3_600;
    this.tokens.set(cacheKey, { accessToken, expiresAt: Date.now() + expiresIn * 1_000 });
    return accessToken;
  }
}
