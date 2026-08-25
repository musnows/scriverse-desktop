export const DESKTOP_SETTINGS_VERSION = 1;
export const DEFAULT_LOCAL_SERVER_PORT = 23_241;
export const MIN_LOCAL_SERVER_PORT = 10_000;
export const LOCAL_SERVER_PORT_SCAN_COUNT = 20;
export const MAX_LOCAL_SERVER_PORT = 60_000;
export const DESKTOP_LOG_STORAGE_LIMIT_MIB_OPTIONS = [500, 1_024, 2_048, 5_120, 10_240] as const;
export const DEFAULT_DESKTOP_LOG_STORAGE_LIMIT_MIB = DESKTOP_LOG_STORAGE_LIMIT_MIB_OPTIONS[0];

export type DesktopLogStorageLimitMiB = typeof DESKTOP_LOG_STORAGE_LIMIT_MIB_OPTIONS[number];

export type DesktopSettingsSummary = {
  localServerPort: number;
  logStorageLimitMiB: DesktopLogStorageLimitMiB;
  updatedAt: string | null;
};

export class DesktopSettingsContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DesktopSettingsContractError";
  }
}

export class LocalServerPortUnavailableError extends Error {
  readonly code = "LOCAL_PORT_UNAVAILABLE";

  constructor(readonly preferredPort: number) {
    super(`本地服务首选端口 ${preferredPort} 被占用，请在 Desktop 系统设置中修改端口号`);
    this.name = "LocalServerPortUnavailableError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseLocalServerPort(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < MIN_LOCAL_SERVER_PORT
    || value > MAX_LOCAL_SERVER_PORT
  ) {
    throw new DesktopSettingsContractError(
      "LOCAL_PORT_INVALID",
      `本地服务首选端口必须是 ${MIN_LOCAL_SERVER_PORT} 到 ${MAX_LOCAL_SERVER_PORT} 之间的整数`
    );
  }
  return value;
}

export function parseDesktopLogStorageLimitMiB(value: unknown): DesktopLogStorageLimitMiB {
  if (typeof value !== "number" || !DESKTOP_LOG_STORAGE_LIMIT_MIB_OPTIONS.includes(value as DesktopLogStorageLimitMiB)) {
    throw new DesktopSettingsContractError(
      "DESKTOP_LOG_STORAGE_LIMIT_INVALID",
      "日志空间上限只能选择 500 MB、1 GB、2 GB、5 GB 或 10 GB"
    );
  }
  return value as DesktopLogStorageLimitMiB;
}

export function desktopLogStorageLimitBytes(value: unknown): number {
  return parseDesktopLogStorageLimitMiB(value) * 1024 * 1024;
}

export function parseDesktopSettingsUpdate(value: unknown): {
  localServerPort: number;
  logStorageLimitMiB: DesktopLogStorageLimitMiB;
} {
  if (!isRecord(value) || Object.keys(value).toSorted().join(",") !== "localServerPort,logStorageLimitMiB") {
    throw new DesktopSettingsContractError("DESKTOP_SETTINGS_INVALID", "Desktop 系统设置请求无效");
  }
  return {
    localServerPort: parseLocalServerPort(value.localServerPort),
    logStorageLimitMiB: parseDesktopLogStorageLimitMiB(value.logStorageLimitMiB)
  };
}

export function localServerPortCandidates(preferredPort: number): number[] {
  const base = parseLocalServerPort(preferredPort);
  const count = Math.min(LOCAL_SERVER_PORT_SCAN_COUNT, MAX_LOCAL_SERVER_PORT - base + 1);
  return Array.from({ length: count }, (_value, offset) => base + offset);
}

export async function selectLocalServerPort(
  preferredPort: number,
  canBind: (port: number) => Promise<boolean>
): Promise<number> {
  for (const port of localServerPortCandidates(preferredPort)) {
    if (await canBind(port)) return port;
  }
  throw new LocalServerPortUnavailableError(preferredPort);
}
