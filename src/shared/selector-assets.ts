import { extname, join } from "node:path";

export const SELECTOR_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

const selectorAssets = new Map<string, string>([
  ["/selector/index.html", "text/html; charset=utf-8"],
  ["/selector/selector.css", "text/css; charset=utf-8"],
  ["/selector/selector.js", "text/javascript; charset=utf-8"],
  ["/selector/icon.svg", "image/svg+xml"],
  ["/desktop-fonts.css", "text/css; charset=utf-8"],
  ["/external-url-prompt.js", "text/javascript; charset=utf-8"],
  ["/local-ai/index.html", "text/html; charset=utf-8"],
  ["/local-ai/styles.css", "text/css; charset=utf-8"],
  ["/local-ai/local-ai.css", "text/css; charset=utf-8"],
  ["/local-ai/local-ai.js", "text/javascript; charset=utf-8"],
  ["/local-ai/ai-provider-config-view.js", "text/javascript; charset=utf-8"],
  ["/local-ai/model-config.js", "text/javascript; charset=utf-8"]
]);

const bundledFontContentTypes = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".woff2", "font/woff2"]
]);

export type SelectorAsset = {
  path: string;
  contentType: string;
};

export function resolveSelectorAsset(requestUrl: string, rendererRoot: string): SelectorAsset | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "app:"
    || url.hostname !== "desktop"
    || url.port !== ""
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
    || url.pathname.includes("\\")
  ) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const contentType = selectorAssets.get(pathname)
    ?? (pathname.startsWith("/fonts/") ? bundledFontContentTypes.get(extname(pathname).toLocaleLowerCase("en-US")) : undefined);
  if (!contentType) return null;
  return { path: join(rendererRoot, ...pathname.split("/").filter(Boolean)), contentType };
}
