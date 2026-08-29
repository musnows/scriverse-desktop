export const EXTERNAL_URL_REQUEST_CHANNEL = "workspace:shell:external-url-request";
export const LOCAL_EXTERNAL_URL_REQUEST_CHANNEL = "local-workspace:shell:external-url-request";
export const SELECTOR_EXTERNAL_URL_REQUEST_CHANNEL = "selector:shell:external-url-request";

export type ExternalUrlRequest = {
  requestId: string;
  url: string;
};

export type ExternalUrlResponse = {
  requestId: string;
  confirmed: boolean;
};

export function normalizeExternalHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username !== "" || url.password !== "") return null;
  return url.href;
}

export function parseExternalUrlResponse(input: unknown): ExternalUrlResponse {
  const candidate = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : null;
  if (
    !candidate
    || Object.keys(candidate).length !== 2
    || typeof candidate.requestId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate.requestId)
    || typeof candidate.confirmed !== "boolean"
  ) {
    const error = new Error("外部网站跳转确认请求无效") as Error & { code: string };
    error.code = "EXTERNAL_URL_RESPONSE_INVALID";
    throw error;
  }
  return { requestId: candidate.requestId, confirmed: candidate.confirmed };
}
