import type { Session } from "electron";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RemoteWorkspaceProfile } from "../shared/contracts.js";
import { REMOTE_MEDIA_DOWNLOAD_HEADER, RemoteMediaCache, parseRemoteMediaRoute } from "./remote-media-cache.js";

const WORKSPACE_SHELL_CSP = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; manifest-src 'self'; media-src 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'";

const contentTypes = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

function shellHost(profileId: string): string {
  return `workspace-${profileId.toLocaleLowerCase("en-US")}`;
}

export function remoteWorkspaceShellUrl(profileId: string): string {
  return `app://${shellHost(profileId)}/`;
}

export function isRemoteWorkspaceShellUrl(value: string, profileId: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "app:"
      && url.hostname === shellHost(profileId)
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function securityHeaders(contentType = "text/plain; charset=utf-8"): HeadersInit {
  return {
    "Cache-Control": "private, no-cache",
    "Content-Security-Policy": WORKSPACE_SHELL_CSP,
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Permitted-Cross-Domain-Policies": "none"
  };
}

export type WorkspaceShellAsset = {
  path: string;
  contentType: string;
};

export function resolveWorkspaceShellAsset(requestUrl: string, profileId: string, publicRoot: string): WorkspaceShellAsset | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (!isRemoteWorkspaceShellUrl(requestUrl, profileId)) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\\") || pathname.includes("\0") || pathname === "/api" || pathname.startsWith("/api/")) return null;
  const assetPathname = pathname === "/" ? "/index.html" : pathname;
  const path = resolve(publicRoot, `.${assetPathname}`);
  const relativePath = relative(publicRoot, path);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null;
  return {
    path,
    contentType: contentTypes.get(extname(path).toLocaleLowerCase("en-US")) ?? "application/octet-stream"
  };
}

function remoteRequestHeaders(request: Request, profile: RemoteWorkspaceProfile): Headers {
  const headers = new Headers(request.headers);
  for (const name of [
    "authorization",
    "connection",
    "content-length",
    "cookie",
    "cookie2",
    "host",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
    REMOTE_MEDIA_DOWNLOAD_HEADER,
    "upgrade"
  ]) headers.delete(name);
  headers.set("Origin", profile.origin);
  headers.set("Referer", `${profile.origin}/`);
  return headers;
}

async function proxyRemoteApi(request: Request, electronSession: Session, profile: RemoteWorkspaceProfile): Promise<Response> {
  const sourceUrl = new URL(request.url);
  const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}`, `${profile.origin}/`);
  const method = request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : new Uint8Array(await request.arrayBuffer());
  try {
    const response = await electronSession.fetch(targetUrl.toString(), {
      method,
      headers: remoteRequestHeaders(request, profile),
      ...(body && body.byteLength > 0 ? { body } : {}),
      redirect: "manual",
      bypassCustomProtocolHandlers: true
    });
    const headers = new Headers(response.headers);
    headers.delete("set-cookie");
    headers.delete("set-cookie2");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch {
    return Response.json({ error: { code: "REMOTE_API_UNAVAILABLE", message: "无法连接当前 Server" } }, {
      status: 502,
      headers: { "Cache-Control": "no-store" }
    });
  }
}

export function registerBundledWorkspaceShell(
  electronSession: Session,
  profile: RemoteWorkspaceProfile,
  publicRoot: string,
  connectionMode: "online" | "offline",
  mediaCache: RemoteMediaCache | null = null,
  userId: string | null = null
): () => void {
  let active = true;
  electronSession.protocol.handle("app", async (request) => {
    if (!isRemoteWorkspaceShellUrl(request.url, profile.id)) {
      return new Response("Not found", { status: 404, headers: securityHeaders() });
    }
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const mediaRoute = parseRemoteMediaRoute(`${url.pathname}${url.search}`);
      if (mediaRoute && mediaCache && userId) {
        const cached = await mediaCache.cachedResponse(profile.id, mediaRoute.path);
        if (cached) return cached;
        const requestedDownload = request.headers.get(REMOTE_MEDIA_DOWNLOAD_HEADER) === "1";
        const automaticDownload = mediaRoute.kind === "cover"
          || (mediaRoute.kind === "user-avatar" && mediaRoute.subjectId === userId);
        if (connectionMode === "online" && (requestedDownload || automaticDownload)) {
          try {
            return (await mediaCache.cachePath(electronSession, profile, mediaRoute.path)).response;
          } catch (error) {
            const message = error instanceof Error ? error.message : "无法下载远端图片";
            return Response.json({ error: { code: "REMOTE_MEDIA_UNAVAILABLE", message } }, {
              status: 502,
              headers: { "Cache-Control": "no-store" }
            });
          }
        }
      }
      if (connectionMode === "offline") {
        return Response.json({ error: { code: "DESKTOP_OFFLINE", message: "当前处于离线状态" } }, {
          status: 503,
          headers: { "Cache-Control": "no-store" }
        });
      }
      return proxyRemoteApi(request, electronSession, profile);
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: securityHeaders() });
    }
    const asset = resolveWorkspaceShellAsset(request.url, profile.id, publicRoot);
    if (!asset) return new Response("Not found", { status: 404, headers: securityHeaders() });
    try {
      const content = await readFile(asset.path);
      return new Response(request.method === "HEAD" ? null : new Uint8Array(content), {
        status: 200,
        headers: securityHeaders(asset.contentType)
      });
    } catch {
      return new Response("Not found", { status: 404, headers: securityHeaders() });
    }
  });
  return () => {
    if (!active) return;
    active = false;
    electronSession.protocol.unhandle("app");
  };
}
