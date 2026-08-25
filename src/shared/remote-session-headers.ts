export type RemoteHeaderValue = string | string[];
export type RemoteHeaders = Record<string, RemoteHeaderValue>;

function withoutHeaders(headers: RemoteHeaders, forbiddenNames: ReadonlySet<string>): RemoteHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !forbiddenNames.has(name.toLocaleLowerCase("en-US"))));
}

export function remoteRequestHeaders(
  headers: RemoteHeaders,
  requestUrl: string,
  origin: string,
  token: string | null
): RemoteHeaders {
  const sanitized = withoutHeaders(headers, new Set(["authorization", "cookie", "cookie2", "x-scriverse-desktop-media-download"]));
  let requestOrigin: string | null = null;
  try {
    requestOrigin = new URL(requestUrl).origin;
  } catch {
    return sanitized;
  }
  if (token && requestOrigin === origin) sanitized.Authorization = `Bearer ${token}`;
  return sanitized;
}

export function remoteResponseHeaders(headers: RemoteHeaders): RemoteHeaders {
  return withoutHeaders(headers, new Set(["set-cookie", "set-cookie2"]));
}
