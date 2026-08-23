import type { Session } from "electron";
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const OFFLINE_SHELL_CSP = "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; manifest-src 'self'; media-src 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self'";

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

function securityHeaders(contentType = "text/plain; charset=utf-8"): HeadersInit {
  return {
    "Cache-Control": "private, no-cache",
    "Content-Security-Policy": OFFLINE_SHELL_CSP,
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

export type OfflineShellAsset = {
  path: string;
  contentType: string;
};

export function resolveOfflineShellAsset(requestUrl: string, origin: string, publicRoot: string): OfflineShellAsset | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.origin !== origin || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
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

export function registerBundledOfflineShell(electronSession: Session, origin: string, publicRoot: string): () => void {
  const scheme = new URL(origin).protocol.slice(0, -1);
  let active = true;
  electronSession.protocol.handle(scheme, async (request) => {
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url);
    } catch {
      return new Response("Not found", { status: 404, headers: securityHeaders() });
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      return new Response("Not found", { status: 404, headers: securityHeaders() });
    }
    if (requestUrl.origin !== origin || pathname === "/api" || pathname.startsWith("/api/")) {
      return electronSession.fetch(request, { bypassCustomProtocolHandlers: true });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: securityHeaders() });
    }
    const asset = resolveOfflineShellAsset(request.url, origin, publicRoot);
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
    electronSession.protocol.unhandle(scheme);
  };
}
