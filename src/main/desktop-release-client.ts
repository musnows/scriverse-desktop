import { compareSemanticVersions } from "../shared/protocol-range.js";
import { DESKTOP_RELEASE_API_URL } from "../shared/update-policy.js";

export { DESKTOP_RELEASE_API_URL };
export const DESKTOP_RELEASE_MAX_BYTES = 512 * 1024;
const RELEASE_ROOT = "https://github.com/musnows/scriverse-desktop/releases";

export type DesktopUpdateRelease = { version: string; downloadUrl: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertStableVersion(value: unknown): string {
  if (typeof value !== "string" || value.length > 80 || !/^\d+\.\d+\.\d+(?:\.\d+)?$/u.test(value) || value.split(".").some((part) => !Number.isSafeInteger(Number(part))) || compareSemanticVersions(value, value) !== 0) {
    throw new Error("Desktop release version is invalid");
  }
  return value;
}

function assertTarget(platform: NodeJS.Platform, arch: string): void {
  if ((platform !== "darwin" && platform !== "win32") || (arch !== "arm64" && arch !== "x64" && !(platform === "win32" && arch === "ia32"))) {
    throw new Error("Desktop release target is invalid");
  }
}

function installerDownloadUrl(version: string, platform: NodeJS.Platform, arch: string): string {
  const name = platform === "darwin"
    ? `scriverse-desktop-macos-darwin-${arch}-${version}.dmg`
    : `scriverse-desktop-windows-win32-${arch}-${version}-Setup.exe`;
  return `${RELEASE_ROOT}/download/v${version}/${name}`;
}

export function parseDesktopUpdateRelease(value: unknown, currentVersion: string, platform: NodeJS.Platform, arch: string): DesktopUpdateRelease | null {
  assertStableVersion(currentVersion);
  assertTarget(platform, arch);
  if (!isRecord(value)) throw new Error("Desktop release metadata is invalid");
  if (value.draft === true || value.prerelease === true) return null;
  if (value.draft !== false || value.prerelease !== false || typeof value.tag_name !== "string" || !value.tag_name.startsWith("v")) {
    throw new Error("Desktop release metadata is invalid");
  }
  const version = assertStableVersion(value.tag_name.slice(1));
  if (value.html_url !== `${RELEASE_ROOT}/tag/v${version}`) throw new Error("Desktop release repository is invalid");
  const comparison = compareSemanticVersions(version, currentVersion);
  if (comparison === null) throw new Error("Desktop release version cannot be compared");
  if (comparison <= 0) return null;
  if (!Array.isArray(value.assets) || value.assets.length > 128) throw new Error("Desktop release assets are invalid");
  const downloadUrl = installerDownloadUrl(version, platform, arch);
  const name = downloadUrl.slice(downloadUrl.lastIndexOf("/") + 1);
  const matching = value.assets.filter((asset: unknown) => isRecord(asset) && asset.name === name);
  if (matching.length !== 1 || !isRecord(matching[0])) throw new Error("Desktop release installer is unavailable");
  const asset = matching[0];
  if (asset.state !== "uploaded" || typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 2 * 1024 ** 3 || asset.browser_download_url !== downloadUrl) {
    throw new Error("Desktop release installer is invalid");
  }
  return { version, downloadUrl };
}

export async function fetchDesktopUpdateRelease(options: {
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  signal?: AbortSignal;
}): Promise<DesktopUpdateRelease | null> {
  assertStableVersion(options.currentVersion);
  assertTarget(options.platform, options.arch);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  try {
    const response = await options.fetch(DESKTOP_RELEASE_API_URL, {
      headers: { Accept: "application/vnd.github+json" },
      redirect: "error",
      credentials: "omit",
      signal
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
        return await fetchDesktopUpdateFromReleasePage(options, signal);
      }
      throw new Error(`Desktop release request failed with status ${response.status}`);
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!Number.isSafeInteger(Number(length)) || Number(length) < 0 || Number(length) > DESKTOP_RELEASE_MAX_BYTES)) {
      await response.body?.cancel();
      throw new Error("Desktop release metadata exceeds the size limit");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Desktop release response body is unavailable");
    let bytes = 0;
    let text = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > DESKTOP_RELEASE_MAX_BYTES) throw new Error("Desktop release metadata exceeds the size limit");
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const value: unknown = JSON.parse(text);
    return parseDesktopUpdateRelease(value, options.currentVersion, options.platform, options.arch);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchDesktopUpdateFromReleasePage(options: {
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}, signal: AbortSignal): Promise<DesktopUpdateRelease | null> {
  const request: RequestInit = { method: "HEAD", redirect: "manual", credentials: "omit", signal };
  const response = await options.fetch(`${RELEASE_ROOT}/latest`, request);
  const location = response.headers.get("location");
  const prefix = `${RELEASE_ROOT}/tag/v`;
  if (response.status !== 302 || !location?.startsWith(prefix)) throw new Error("Desktop latest release redirect is invalid");
  const version = assertStableVersion(location.slice(prefix.length));
  const comparison = compareSemanticVersions(version, options.currentVersion);
  if (comparison === null) throw new Error("Desktop release version cannot be compared");
  if (comparison <= 0) return null;
  const downloadUrl = installerDownloadUrl(version, options.platform, options.arch);
  let installer = await options.fetch(downloadUrl, request);
  if (installer.status === 302) {
    const redirect = installer.headers.get("location");
    const assetUrl = redirect ? new URL(redirect) : null;
    if (!assetUrl || assetUrl.origin !== "https://release-assets.githubusercontent.com" || assetUrl.username || assetUrl.password || !assetUrl.pathname.startsWith("/github-production-release-asset/")) {
      throw new Error("Desktop release installer redirect is invalid");
    }
    installer = await options.fetch(assetUrl.href, { ...request, redirect: "error" });
  }
  const size = Number(installer.headers.get("content-length"));
  if (installer.status !== 200 || !Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 3) throw new Error("Desktop release installer is unavailable");
  return { version, downloadUrl };
}
