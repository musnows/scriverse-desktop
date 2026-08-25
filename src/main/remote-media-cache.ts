import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "electron";
import type { RemoteWorkspaceProfile } from "../shared/contracts.js";
import { writeDesktopJsonAtomically } from "../shared/storage-manifest.js";

const REMOTE_MEDIA_CACHE_VERSION = 2;
const MAX_REMOTE_MEDIA_BYTES = 64 * 1024 * 1024;
const REMOTE_MEDIA_PAGE_LIMIT = 100;
const REMOTE_MEDIA_REFRESH_INTERVAL_MS = 15 * 60 * 1_000;
const imageMimeTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

export const REMOTE_MEDIA_DOWNLOAD_HEADER = "x-scriverse-desktop-media-download";
export { REMOTE_MEDIA_REFRESH_INTERVAL_MS };

type RemoteMediaKind = "attachment" | "character-avatar" | "cover" | "user-avatar";

export type RemoteMediaRoute = {
  kind: RemoteMediaKind;
  path: string;
  key: string;
  subjectId: string;
};

type RemoteMediaCacheEntry = {
  sha256: string;
  mimeType: string;
  byteLength: number;
  cachedAt: string;
};

type RemoteMediaCacheManifest = {
  version: typeof REMOTE_MEDIA_CACHE_VERSION;
  profileId: string;
  entries: Record<string, RemoteMediaCacheEntry>;
};

type RemoteMediaCacheScope = {
  profileId: string;
  directory: string;
  objectDirectory: string;
  manifestPath: string;
  manifest: RemoteMediaCacheManifest;
};

type WorkMediaCandidate = {
  path: string;
  byteLength: number | null;
  sha256: string | null;
};

export type RemoteWorkMediaSummary = {
  title: string;
  imageCount: number;
  totalBytes: number;
  additionalBytes: number;
  alreadyCachedCount: number;
};

export type RemoteWorkMediaDownloadResult = RemoteWorkMediaSummary & {
  downloadedCount: number;
};

export class RemoteMediaCacheError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteMediaCacheError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/iu.test(value);
}

function parseByteLength(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function canonicalPath(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value, "https://desktop.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://desktop.invalid" || !url.pathname.startsWith("/api/")) return null;
  url.searchParams.sort();
  return `${url.pathname}${url.search}`;
}

export function parseRemoteMediaRoute(value: string): RemoteMediaRoute | null {
  const path = canonicalPath(value);
  if (!path) return null;
  const url = new URL(path, "https://desktop.invalid");
  const attachment = url.pathname.match(/^\/api\/attachments\/([A-Za-z0-9_-]{1,300})\/content$/u);
  if (attachment?.[1]) return { kind: "attachment", path, key: path, subjectId: attachment[1] };
  const cover = url.pathname.match(/^\/api\/works\/([A-Za-z0-9_-]{1,300})\/cover$/u);
  if (cover?.[1]) return { kind: "cover", path, key: path, subjectId: cover[1] };
  const character = url.pathname.match(/^\/api\/characters\/([A-Za-z0-9_-]{1,300})\/avatar$/u);
  if (character?.[1]) return { kind: "character-avatar", path, key: path, subjectId: character[1] };
  const user = url.pathname.match(/^\/api\/user-avatars\/([0-9a-f-]{36})$/iu);
  if (user?.[1] && isUuid(user[1])) return { kind: "user-avatar", path, key: path, subjectId: user[1] };
  return null;
}

export function formatRemoteMediaBytes(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = byteLength;
  let index = 0;
  while (value >= 1_024 && index < units.length - 1) {
    value /= 1_024;
    index += 1;
  }
  const precision = index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[index]}`;
}

function responseHeaders(entry: RemoteMediaCacheEntry): Headers {
  return new Headers({
    "Cache-Control": "private, max-age=31536000, immutable",
    "Content-Length": String(entry.byteLength),
    "Content-Type": entry.mimeType,
    ETag: `\"${entry.sha256}\"`,
    "X-Content-Type-Options": "nosniff"
  });
}

function ensureMediaResponse(response: Response): string {
  if (!response.ok) {
    throw new RemoteMediaCacheError("REMOTE_MEDIA_REQUEST_FAILED", `图片请求失败（HTTP ${response.status}）`);
  }
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase("en-US") ?? "";
  if (!imageMimeTypes.has(mimeType)) {
    throw new RemoteMediaCacheError("REMOTE_MEDIA_TYPE_INVALID", "Server 返回了不受支持的图片格式");
  }
  const declaredLength = parseByteLength(response.headers.get("content-length"));
  if (declaredLength !== null && declaredLength > MAX_REMOTE_MEDIA_BYTES) {
    throw new RemoteMediaCacheError("REMOTE_MEDIA_TOO_LARGE", "图片超过 Desktop 本地缓存上限");
  }
  return mimeType;
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_REMOTE_MEDIA_BYTES) {
      await reader.cancel();
      throw new RemoteMediaCacheError("REMOTE_MEDIA_TOO_LARGE", "图片超过 Desktop 本地缓存上限");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseRemoteData(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new RemoteMediaCacheError("REMOTE_MEDIA_RESPONSE_INVALID", "Server 返回的图片清单无效");
  }
  return value.data;
}

function paginationItems(value: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(value.items) || value.items.some((item) => !isRecord(item))) {
    throw new RemoteMediaCacheError("REMOTE_MEDIA_RESPONSE_INVALID", "Server 返回的图片清单分页无效");
  }
  return value.items;
}

export class RemoteMediaCache {
  private readonly scopes = new Map<string, Promise<RemoteMediaCacheScope>>();

  constructor(private readonly root: string) {}

  private scopeKey(profileId: string): string {
    if (!isUuid(profileId)) {
      throw new RemoteMediaCacheError("REMOTE_MEDIA_SCOPE_INVALID", "远端图片缓存范围无效");
    }
    return profileId;
  }

  private async scope(profileId: string): Promise<RemoteMediaCacheScope> {
    const key = this.scopeKey(profileId);
    let promise = this.scopes.get(key);
    if (!promise) {
      promise = this.openScope(profileId);
      this.scopes.set(key, promise);
    }
    return promise;
  }

  private async openScope(profileId: string): Promise<RemoteMediaCacheScope> {
    const directory = join(this.root, "profiles", profileId);
    const objectDirectory = join(this.root, "objects");
    const manifestPath = join(directory, "manifest.json");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
    await mkdir(objectDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(objectDirectory, 0o700);
    let manifest: RemoteMediaCacheManifest = {
      version: REMOTE_MEDIA_CACHE_VERSION,
      profileId,
      entries: {}
    };
    try {
      const document = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
      if (
        !isRecord(document)
        || document.version !== REMOTE_MEDIA_CACHE_VERSION
        || document.profileId !== profileId
        || !isRecord(document.entries)
      ) throw new Error("invalid");
      const entries: Record<string, RemoteMediaCacheEntry> = {};
      for (const [key, value] of Object.entries(document.entries)) {
        if (
          parseRemoteMediaRoute(key) === null
          || !isRecord(value)
          || !isSha256(value.sha256)
          || !imageMimeTypes.has(String(value.mimeType))
          || parseByteLength(value.byteLength) === null
          || typeof value.cachedAt !== "string"
          || !Number.isFinite(Date.parse(value.cachedAt))
        ) throw new Error("invalid");
        entries[key] = {
          sha256: value.sha256.toLocaleLowerCase("en-US"),
          mimeType: String(value.mimeType),
          byteLength: Number(value.byteLength),
          cachedAt: value.cachedAt
        };
      }
      manifest = { version: REMOTE_MEDIA_CACHE_VERSION, profileId, entries };
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return { profileId, directory, objectDirectory, manifestPath, manifest };
      if (error instanceof Error && error.message === "invalid") {
        throw new RemoteMediaCacheError("REMOTE_MEDIA_CACHE_INVALID", "远端图片缓存清单无效");
      }
      throw new RemoteMediaCacheError("REMOTE_MEDIA_CACHE_INVALID", "远端图片缓存无法读取");
    }
    return { profileId, directory, objectDirectory, manifestPath, manifest };
  }

  private async objectExists(scope: RemoteMediaCacheScope, sha256: string, byteLength: number): Promise<boolean> {
    try {
      return (await stat(join(scope.objectDirectory, sha256))).size === byteLength;
    } catch {
      return false;
    }
  }

  private async cached(scope: RemoteMediaCacheScope, route: RemoteMediaRoute): Promise<Response | null> {
    const entry = scope.manifest.entries[route.key];
    if (!entry || !await this.objectExists(scope, entry.sha256, entry.byteLength)) return null;
    try {
      const content = await readFile(join(scope.objectDirectory, entry.sha256));
      return new Response(content, { status: 200, headers: responseHeaders(entry) });
    } catch {
      return null;
    }
  }

  async cachedResponse(profileId: string, path: string): Promise<Response | null> {
    const route = parseRemoteMediaRoute(path);
    if (!route) return null;
    return this.cached(await this.scope(profileId), route);
  }

  private async remoteFetch(
    electronSession: Session,
    profile: RemoteWorkspaceProfile,
    path: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const target = new URL(path, `${profile.origin}/`);
    if (target.origin !== profile.origin) {
      throw new RemoteMediaCacheError("REMOTE_MEDIA_ORIGIN_INVALID", "远端图片地址无效");
    }
    try {
      return await electronSession.fetch(target.toString(), {
        ...init,
        cache: "no-store",
        redirect: "error",
        bypassCustomProtocolHandlers: true
      });
    } catch (error) {
      if (error instanceof RemoteMediaCacheError) throw error;
      throw new RemoteMediaCacheError("REMOTE_MEDIA_NETWORK_ERROR", "无法下载远端图片");
    }
  }

  private async persist(scope: RemoteMediaCacheScope): Promise<void> {
    writeDesktopJsonAtomically(scope.manifestPath, scope.manifest);
  }

  private async store(
    scope: RemoteMediaCacheScope,
    route: RemoteMediaRoute,
    mimeType: string,
    content: Uint8Array
  ): Promise<Response> {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const objectPath = join(scope.objectDirectory, sha256);
    if (!await this.objectExists(scope, sha256, content.byteLength)) {
      const temporaryPath = `${objectPath}.tmp-${process.pid}-${randomUUID()}`;
      await writeFile(temporaryPath, content, { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, objectPath);
    }
    const entry: RemoteMediaCacheEntry = {
      sha256,
      mimeType,
      byteLength: content.byteLength,
      cachedAt: new Date().toISOString()
    };
    scope.manifest.entries[route.key] = entry;
    await this.persist(scope);
    const body = new ArrayBuffer(content.byteLength);
    new Uint8Array(body).set(content);
    return new Response(body, { status: 200, headers: responseHeaders(entry) });
  }

  async cachePath(
    electronSession: Session,
    profile: RemoteWorkspaceProfile,
    path: string
  ): Promise<{ response: Response; downloaded: boolean }> {
    const route = parseRemoteMediaRoute(path);
    if (!route) throw new RemoteMediaCacheError("REMOTE_MEDIA_PATH_INVALID", "远端图片地址无效");
    const scope = await this.scope(profile.id);
    const existing = await this.cached(scope, route);
    if (existing) return { response: existing, downloaded: false };
    const response = await this.remoteFetch(electronSession, profile, route.path, { method: "GET" });
    const mimeType = ensureMediaResponse(response);
    const content = await readResponseBytes(response);
    return { response: await this.store(scope, route, mimeType, content), downloaded: true };
  }

  async cacheWorkCover(
    electronSession: Session,
    profile: RemoteWorkspaceProfile,
    workId: string
  ): Promise<boolean> {
    const work = await this.remoteData(electronSession, profile, `/api/works/${encodeURIComponent(workId)}`);
    const coverUrl = typeof work.coverUrl === "string" ? work.coverUrl : null;
    const route = coverUrl ? parseRemoteMediaRoute(coverUrl) : null;
    if (!route || route.kind !== "cover" || route.subjectId !== workId) return false;
    return (await this.cachePath(electronSession, profile, route.path)).downloaded;
  }

  async refreshLoggedInUserAvatar(
    electronSession: Session,
    profile: RemoteWorkspaceProfile,
    userId: string
  ): Promise<boolean> {
    const session = await this.remoteData(electronSession, profile, "/api/auth/session");
    const user = isRecord(session.user) ? session.user : null;
    if (session.authenticated !== true || user?.userId !== userId || typeof user.avatarUrl !== "string") return false;
    const route = parseRemoteMediaRoute(user.avatarUrl);
    if (!route || route.kind !== "user-avatar" || route.subjectId !== userId) return false;
    return (await this.cachePath(electronSession, profile, route.path)).downloaded;
  }

  private async remoteData(electronSession: Session, profile: RemoteWorkspaceProfile, path: string): Promise<Record<string, unknown>> {
    const response = await this.remoteFetch(electronSession, profile, path, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      throw new RemoteMediaCacheError("REMOTE_MEDIA_REQUEST_FAILED", `图片清单请求失败（HTTP ${response.status}）`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new RemoteMediaCacheError("REMOTE_MEDIA_RESPONSE_INVALID", "Server 返回的图片清单无效");
    }
    return parseRemoteData(payload);
  }

  private async paginatedData(
    electronSession: Session,
    profile: RemoteWorkspaceProfile,
    path: string
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    for (let page = 1; page <= 1_000; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const data = await this.remoteData(electronSession, profile, `${path}${separator}page=${page}&limit=${REMOTE_MEDIA_PAGE_LIMIT}`);
      const current = paginationItems(data);
      items.push(...current);
      if (data.hasMore !== true) return items;
    }
    throw new RemoteMediaCacheError("REMOTE_MEDIA_RESPONSE_INVALID", "Server 图片清单分页超出上限");
  }

  private async candidateSize(
    electronSession: Session,
    profile: RemoteWorkspaceProfile,
    candidate: WorkMediaCandidate
  ): Promise<WorkMediaCandidate> {
    if (candidate.byteLength !== null) return candidate;
    const response = await this.remoteFetch(electronSession, profile, candidate.path, { method: "HEAD" });
    const mimeType = ensureMediaResponse(response);
    if (!imageMimeTypes.has(mimeType)) throw new RemoteMediaCacheError("REMOTE_MEDIA_TYPE_INVALID", "Server 返回了不受支持的图片格式");
    const byteLength = parseByteLength(response.headers.get("content-length"));
    if (byteLength === null) throw new RemoteMediaCacheError("REMOTE_MEDIA_SIZE_UNKNOWN", "Server 未返回图片大小，无法估算本地占用");
    const etag = response.headers.get("etag")?.replaceAll("\"", "").trim() ?? "";
    return { ...candidate, byteLength, sha256: isSha256(etag) ? etag.toLocaleLowerCase("en-US") : null };
  }

  private async workImageCandidates(
    electronSession: Session,
    profile: RemoteWorkspaceProfile,
    workId: string
  ): Promise<{ title: string; candidates: WorkMediaCandidate[] }> {
    const work = await this.remoteData(electronSession, profile, `/api/works/${encodeURIComponent(workId)}`);
    const title = typeof work.title === "string" && work.title.trim() ? work.title.trim() : "未命名作品";
    const candidates = new Map<string, WorkMediaCandidate>();
    for (const attachment of await this.paginatedData(electronSession, profile, `/api/works/${encodeURIComponent(workId)}/attachments`)) {
      const route = typeof attachment.contentUrl === "string" ? parseRemoteMediaRoute(attachment.contentUrl) : null;
      if (!route || route.kind !== "attachment") continue;
      candidates.set(route.key, {
        path: route.path,
        byteLength: parseByteLength(attachment.storedByteLength),
        sha256: isSha256(attachment.storedSha256) ? attachment.storedSha256.toLocaleLowerCase("en-US") : null
      });
    }
    for (const character of await this.paginatedData(electronSession, profile, `/api/works/${encodeURIComponent(workId)}/characters`)) {
      const route = typeof character.avatarUrl === "string" ? parseRemoteMediaRoute(character.avatarUrl) : null;
      if (!route || route.kind !== "character-avatar") continue;
      candidates.set(route.key, { path: route.path, byteLength: null, sha256: null });
    }
    const sized = await Promise.all([...candidates.values()].map((candidate) => this.candidateSize(electronSession, profile, candidate)));
    return { title, candidates: sized };
  }

  private async workSummary(
    electronSession: Session,
    profile: RemoteWorkspaceProfile,
    workId: string
  ): Promise<{ summary: RemoteWorkMediaSummary; candidates: WorkMediaCandidate[] }> {
    const { title, candidates } = await this.workImageCandidates(electronSession, profile, workId);
    const scope = await this.scope(profile.id);
    const hashes = new Set<string>();
    let totalBytes = 0;
    let additionalBytes = 0;
    let alreadyCachedCount = 0;
    for (const candidate of candidates) {
      const byteLength = candidate.byteLength ?? 0;
      totalBytes += byteLength;
      const existing = await this.cached(scope, parseRemoteMediaRoute(candidate.path)!);
      if (existing) {
        alreadyCachedCount += 1;
        continue;
      }
      if (candidate.sha256 && hashes.has(candidate.sha256)) continue;
      if (candidate.sha256) hashes.add(candidate.sha256);
      additionalBytes += byteLength;
    }
    return {
      summary: { title, imageCount: candidates.length, totalBytes, additionalBytes, alreadyCachedCount },
      candidates
    };
  }

  async describeWorkImages(
    electronSession: Session,
    profile: RemoteWorkspaceProfile,
    workId: string
  ): Promise<RemoteWorkMediaSummary> {
    return (await this.workSummary(electronSession, profile, workId)).summary;
  }

  async downloadWorkImages(
    electronSession: Session,
    profile: RemoteWorkspaceProfile,
    workId: string
  ): Promise<RemoteWorkMediaDownloadResult> {
    const { summary, candidates } = await this.workSummary(electronSession, profile, workId);
    let downloadedCount = 0;
    for (const candidate of candidates) {
      if ((await this.cachePath(electronSession, profile, candidate.path)).downloaded) downloadedCount += 1;
    }
    return { ...summary, downloadedCount };
  }
}
