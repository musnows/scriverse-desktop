export class ProfileUrlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ProfileUrlError";
  }
}

export function normalizeProfileOrigin(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048) {
    throw new ProfileUrlError("PROFILE_URL_INVALID", "Server URL 长度必须在 1 到 2048 个字符之间");
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ProfileUrlError("PROFILE_URL_INVALID", "Server URL 格式无效");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProfileUrlError("PROFILE_URL_PROTOCOL_INVALID", "Server URL 只允许 HTTP 或 HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ProfileUrlError("PROFILE_URL_CREDENTIALS_FORBIDDEN", "Server URL 不能包含用户名或密码");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new ProfileUrlError("PROFILE_URL_ORIGIN_REQUIRED", "Server URL 只能填写 origin，不能包含路径、查询参数或片段");
  }
  return url.origin;
}

export function isLoopbackOrigin(origin: string): boolean {
  const hostname = new URL(origin).hostname.toLocaleLowerCase().replace(/^\[|\]$/gu, "");
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(hostname);
}
