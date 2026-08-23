import type {
  ProtocolRange,
  RemoteCapabilitySnapshot,
  RemoteSyncProtocolCapability
} from "../shared/contracts.js";
import { isLoopbackOrigin, normalizeProfileOrigin } from "../shared/profile-url.js";
import { classifyRemoteCompatibility } from "../shared/protocol-range.js";

export const REMOTE_PROBE_TIMEOUT_MS = 5_000;
export const REMOTE_PROBE_MAX_RESPONSE_BYTES = 64 * 1024;

export class RemoteServerProbeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RemoteServerProbeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableVersion(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 80) {
    throw new RemoteServerProbeError("REMOTE_HEALTH_INVALID", `Server ${label} 无效`);
  }
  return value;
}

function protocolRange(value: unknown, label: string): ProtocolRange {
  if (!isRecord(value) || !Number.isInteger(value.min) || !Number.isInteger(value.max)) {
    throw new RemoteServerProbeError("REMOTE_HEALTH_INVALID", `Server ${label} 无效`);
  }
  const min = Number(value.min);
  const max = Number(value.max);
  if (min < 1 || max < min || max > 1_000) {
    throw new RemoteServerProbeError("REMOTE_HEALTH_INVALID", `Server ${label} 范围无效`);
  }
  return { min, max };
}

function syncProtocol(value: unknown): RemoteSyncProtocolCapability {
  const range = protocolRange(value, "syncProtocol");
  if (!isRecord(value) || !Array.isArray(value.entityTypes) || !Number.isInteger(value.maxMutationBytes)) {
    throw new RemoteServerProbeError("REMOTE_HEALTH_INVALID", "Server syncProtocol 能力无效");
  }
  const entityTypes = value.entityTypes.map((entityType) => {
    if (typeof entityType !== "string" || !/^[a-z][a-z0-9-]{0,39}$/u.test(entityType)) {
      throw new RemoteServerProbeError("REMOTE_HEALTH_INVALID", "Server syncProtocol entityTypes 无效");
    }
    return entityType;
  });
  if (entityTypes.length > 50 || new Set(entityTypes).size !== entityTypes.length) {
    throw new RemoteServerProbeError("REMOTE_HEALTH_INVALID", "Server syncProtocol entityTypes 无效");
  }
  const maxMutationBytes = Number(value.maxMutationBytes);
  if (maxMutationBytes < 1_024 || maxMutationBytes > 16 * 1024 * 1024) {
    throw new RemoteServerProbeError("REMOTE_HEALTH_INVALID", "Server syncProtocol maxMutationBytes 无效");
  }
  return { ...range, entityTypes, maxMutationBytes };
}

async function limitedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > REMOTE_PROBE_MAX_RESPONSE_BYTES) {
    throw new RemoteServerProbeError("REMOTE_HEALTH_TOO_LARGE", "Server health 响应超过 64 KiB");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > REMOTE_PROBE_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new RemoteServerProbeError("REMOTE_HEALTH_TOO_LARGE", "Server health 响应超过 64 KiB");
      }
      chunks.push(value);
    }
  }
  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)) as unknown;
  } catch {
    throw new RemoteServerProbeError("REMOTE_HEALTH_INVALID", "Server health 不是有效 JSON");
  }
}

function parseHealth(value: unknown, desktopVersion: string): RemoteCapabilitySnapshot {
  if (!isRecord(value) || !isRecord(value.data) || value.data.status !== "ok") {
    throw new RemoteServerProbeError("REMOTE_HEALTH_INVALID", "目标没有返回有效的 Scriverse health");
  }
  const data = value.data;
  const hasModernFields = data.product !== undefined
    || data.shellProtocol !== undefined
    || data.syncProtocol !== undefined
    || data.minimumDesktopVersion !== undefined;
  if (!hasModernFields) {
    return {
      checkedAt: new Date().toISOString(),
      product: "scriverse",
      serverVersion: nullableVersion(data.version, "version"),
      webAssetVersion: null,
      shellProtocol: null,
      syncProtocol: null,
      minimumDesktopVersion: null,
      compatibility: "legacy-online-only"
    };
  }
  if (data.product !== "scriverse") {
    throw new RemoteServerProbeError("REMOTE_PRODUCT_MISMATCH", "目标不是 Scriverse Server");
  }
  const shell = protocolRange(data.shellProtocol, "shellProtocol");
  const sync = data.syncProtocol === undefined || data.syncProtocol === null ? null : syncProtocol(data.syncProtocol);
  const minimumDesktopVersion = nullableVersion(data.minimumDesktopVersion, "minimumDesktopVersion");
  return {
    checkedAt: new Date().toISOString(),
    product: "scriverse",
    serverVersion: nullableVersion(data.serverVersion ?? data.version, "serverVersion"),
    webAssetVersion: nullableVersion(data.webAssetVersion, "webAssetVersion"),
    shellProtocol: shell,
    syncProtocol: sync,
    minimumDesktopVersion,
    compatibility: classifyRemoteCompatibility({
      desktopVersion,
      minimumDesktopVersion,
      shellProtocol: shell,
      syncProtocol: sync
    })
  };
}

export class RemoteServerProbe {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async probe(originInput: string, desktopVersion: string): Promise<RemoteCapabilitySnapshot> {
    const origin = normalizeProfileOrigin(originInput);
    if (new URL(origin).protocol !== "https:" && !isLoopbackOrigin(origin)) {
      throw new RemoteServerProbeError(
        "REMOTE_INSECURE_ORIGIN_FORBIDDEN",
        "远端 Server 默认要求 HTTPS；仅回环地址可直接使用 HTTP"
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REMOTE_PROBE_TIMEOUT_MS);
    try {
      const request = async (url: string, redirect: RequestRedirect): Promise<Response> => {
        try {
          return await this.fetchImpl(url, {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
            credentials: "omit",
            redirect,
            signal: controller.signal
          });
        } catch {
          if (controller.signal.aborted) throw new RemoteServerProbeError("REMOTE_PROBE_TIMEOUT", "Server 检测超时");
          throw new RemoteServerProbeError("REMOTE_PROBE_NETWORK_ERROR", "无法连接 Server，请检查地址、网络和证书");
        }
      };
      const healthUrl = new URL("/api/health", `${origin}/`).href;
      let response = await request(healthUrl, "manual");
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new RemoteServerProbeError("REMOTE_PROBE_REDIRECT_INVALID", "Server health 重定向缺少目标");
        const redirected = new URL(location, healthUrl);
        if (redirected.origin !== origin) {
          throw new RemoteServerProbeError("REMOTE_PROBE_REDIRECT_FORBIDDEN", "Server health 不能重定向到其他 origin");
        }
        response = await request(redirected.href, "manual");
        if (response.status >= 300 && response.status < 400) {
          throw new RemoteServerProbeError("REMOTE_PROBE_REDIRECT_LIMIT", "Server health 重定向次数超过上限");
        }
      }
      const value = await limitedJson(response);
      if (response.status !== 200) {
        throw new RemoteServerProbeError(`REMOTE_HEALTH_HTTP_${response.status}`, `Server health 请求失败（HTTP ${response.status}）`);
      }
      return parseHealth(value, desktopVersion);
    } finally {
      clearTimeout(timeout);
    }
  }
}
