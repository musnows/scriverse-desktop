export const DESKTOP_SETTINGS_VERSION = 1;
export const DEFAULT_LOCAL_SERVER_PORT = 23_241;
export const MIN_LOCAL_SERVER_PORT = 20_001;
export const LOCAL_SERVER_PORT_SCAN_COUNT = 20;
export const MAX_LOCAL_SERVER_PORT = 60_000;
export const DESKTOP_LOG_STORAGE_LIMIT_MIB_OPTIONS = [500, 1_024, 2_048, 5_120, 10_240] as const;
export const DEFAULT_DESKTOP_LOG_STORAGE_LIMIT_MIB = DESKTOP_LOG_STORAGE_LIMIT_MIB_OPTIONS[0];
export const DESKTOP_COLOR_THEMES = ["light", "dark"] as const;
export const DEFAULT_DESKTOP_COLOR_THEME = "light";
export const DEFAULT_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD = 3;
export const MIN_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD = 1;
export const MAX_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD = 10;

export type DesktopLogStorageLimitMiB = typeof DESKTOP_LOG_STORAGE_LIMIT_MIB_OPTIONS[number];
export type DesktopColorTheme = typeof DESKTOP_COLOR_THEMES[number];

export type DesktopSettingsSummary = {
  localServerPort: number;
  logStorageLimitMiB: DesktopLogStorageLimitMiB;
  colorTheme: DesktopColorTheme;
  remoteServerUnreachableFailureThreshold: number;
  updatedAt: string | null;
};

export class DesktopSettingsContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DesktopSettingsContractError";
  }
}

/** Windows 排除端口返回 EACCES/EPERM，占用返回 EADDRINUSE。三者都表示这个端口现在不能绑定。 */
const LOCAL_PORT_UNBINDABLE_CODES = new Set(["EADDRINUSE", "EACCES", "EPERM"]);

export function localServerPortUnavailableMessage(preferredPort?: number): string {
  const lead = typeof preferredPort === "number"
    ? `本地服务从端口 ${preferredPort} 起无法绑定`
    : "本地服务端口无法绑定";
  return `${lead}。这些端口可能已被占用，或落在 Windows 排除端口范围内。请在 Desktop 系统设置中改用排除范围之外的端口。`;
}

export function isLocalPortUnbindableError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return LOCAL_PORT_UNBINDABLE_CODES.has(String(error.code));
}

export class LocalServerPortUnavailableError extends Error {
  readonly code = "LOCAL_PORT_UNAVAILABLE";

  constructor(readonly preferredPort: number) {
    super(localServerPortUnavailableMessage(preferredPort));
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

export function parseDesktopColorTheme(value: unknown): DesktopColorTheme {
  if (typeof value !== "string" || !DESKTOP_COLOR_THEMES.includes(value as DesktopColorTheme)) {
    throw new DesktopSettingsContractError("DESKTOP_COLOR_THEME_INVALID", "桌面主题只能选择白天或黑夜模式");
  }
  return value as DesktopColorTheme;
}

export function parseRemoteServerUnreachableFailureThreshold(value: unknown): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < MIN_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD
    || value > MAX_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD
  ) {
    throw new DesktopSettingsContractError(
      "REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD_INVALID",
      `Server 不可达连续失败次数必须是 ${MIN_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD} 到 ${MAX_REMOTE_SERVER_UNREACHABLE_FAILURE_THRESHOLD} 之间的整数`
    );
  }
  return value;
}

export function desktopLogStorageLimitBytes(value: unknown): number {
  return parseDesktopLogStorageLimitMiB(value) * 1024 * 1024;
}

export function parseDesktopSettingsUpdate(value: unknown): {
  localServerPort: number;
  logStorageLimitMiB: DesktopLogStorageLimitMiB;
  colorTheme: DesktopColorTheme;
  remoteServerUnreachableFailureThreshold: number;
} {
  if (!isRecord(value) || Object.keys(value).toSorted().join(",") !== "colorTheme,localServerPort,logStorageLimitMiB,remoteServerUnreachableFailureThreshold") {
    throw new DesktopSettingsContractError("DESKTOP_SETTINGS_INVALID", "Desktop 系统设置请求无效");
  }
  return {
    localServerPort: parseLocalServerPort(value.localServerPort),
    logStorageLimitMiB: parseDesktopLogStorageLimitMiB(value.logStorageLimitMiB),
    colorTheme: parseDesktopColorTheme(value.colorTheme),
    remoteServerUnreachableFailureThreshold: parseRemoteServerUnreachableFailureThreshold(value.remoteServerUnreachableFailureThreshold)
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
    try {
      if (await canBind(port)) return port;
    } catch (error) {
      // 探测直接抛出 EACCES 时继续看下一个端口，避免 Windows 排除段中断整次启动。
      if (!isLocalPortUnbindableError(error)) throw error;
    }
  }
  throw new LocalServerPortUnavailableError(preferredPort);
}
