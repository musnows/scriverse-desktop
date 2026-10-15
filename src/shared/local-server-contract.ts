import { isAbsolute, join, normalize } from "node:path";
import {
  isLocalPortUnbindableError,
  localServerPortUnavailableMessage,
  LocalServerPortUnavailableError,
  parseLocalServerPort
} from "./desktop-settings-contract.js";

export const LOCAL_SERVER_START_TIMEOUT_MS = 30_000;
export const LOCAL_SERVER_SHUTDOWN_TIMEOUT_MS = 10_000;
export const LOCAL_SERVER_HEALTH_TIMEOUT_MS = 5_000;
export const LOCAL_SERVER_HEALTH_MAX_BYTES = 64 * 1024;

export const LOCAL_SERVER_ALLOWED_ENVIRONMENT_KEYS = [
  "APP_UPDATE_CHECK_INTERVAL_MINUTES",
  "APP_UPDATE_CHECK_TIMEOUT_SECONDS",
  "APP_UPDATE_CHECK_RETRIES",
  "SCRIVERSE_AVATAR_IMAGE_MAX_BYTES",
  "SCRIVERSE_COVER_IMAGE_MAX_BYTES",
  "SCRIVERSE_ATTACHMENT_IMAGE_MAX_BYTES",
  "SCRIVERSE_AI_CHAT_IMAGE_MAX_BYTES",
  "SCRIVERSE_AI_RETRY_COUNT",
  "SCRIVERSE_AI_BACKOFF_RETRY_COUNT",
  "SCRIVERSE_AI_STREAM_IDLE_TIMEOUT_SECONDS",
  "SCRIVERSE_AI_RESPONSE_MAX_BYTES"
] as const;

export type LocalServerEnvironment = Record<string, string> & {
  NODE_ENV: "production";
  APP_ALLOW_PRIVATE_AI_ENDPOINTS: "true";
};

export type LocalServerStartMessage = {
  type: "start";
  dataDirectory: string;
  databasePath: string;
  publicPath: string;
  vditorPath: string;
  preferredPort: number;
  desktopId: string;
  profileId: string;
  clientVersion: string;
  envAllowlist: LocalServerEnvironment;
};

export type LocalServerShutdownMessage = {
  type: "shutdown";
  requestId: string;
};

export type LocalServerProvisionMessage = {
  type: "provision";
  requestId: string;
  username: string;
  password: string;
};

export type LocalServerLoginMessage = {
  type: "login";
  requestId: string;
  username: string;
  password: string;
};

export type LocalServerParentMessage = LocalServerStartMessage | LocalServerProvisionMessage | LocalServerLoginMessage | LocalServerShutdownMessage;

export type LocalProvisionedUser = {
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  status: "active" | "disabled";
  createdAt: string;
  avatarUrl: string | null;
  onboardingCompleted: boolean;
  isSystemAdmin: boolean;
};

export type LocalServerAuthenticatedMessage = {
  type: "authenticated";
  requestId: string;
  token: string;
  expiresAt: string;
  user: LocalProvisionedUser;
};

export type LocalServerAuthenticationFailedMessage = {
  type: "authentication-failed";
  requestId: string;
  code: string;
  safeMessage: string;
};

export type LocalServerReadyMessage = {
  type: "ready";
  url: string;
  port: number;
  bootId: string;
  schemaVersion: number;
};

export type LocalServerStoppedMessage = {
  type: "stopped";
  requestId: string;
};

export type LocalServerFatalMessage = {
  type: "fatal";
  phase: "validate" | "load" | "start" | "shutdown" | "runtime";
  code: string;
  safeMessage: string;
};

export type LocalServerUtilityMessage =
  | LocalServerReadyMessage
  | LocalServerAuthenticatedMessage
  | LocalServerAuthenticationFailedMessage
  | LocalServerStoppedMessage
  | LocalServerFatalMessage;

export type LocalServerPublicStatus = {
  phase: "stopped" | "starting" | "running" | "stopping" | "failed";
  setupRequired: boolean | null;
  errorCode: string | null;
};

export class LocalServerContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalServerContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务消息包含未知字段");
  }
}

function assertRequestId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务 requestId 无效");
  }
  return value;
}

function assertDesktopVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/u.test(value)) {
    throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "Desktop 版本无效");
  }
  return value;
}

function assertAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || !isAbsolute(value)) {
    throw new LocalServerContractError("LOCAL_PATH_INVALID", `${label} 必须是绝对路径`);
  }
  return normalize(value);
}

const LOCAL_SERVER_INVALID_ARGUMENT_MESSAGE = "本地服务启动参数无效。请重新打开叙界；若刚升级过，请重新安装当前 Desktop 版本后再进入本地工作区。";
const LOCAL_SERVER_STORAGE_MESSAGE = "本地工作区目录校验失败，已停止启动。请确认本地工作区目录完整且没有被其他程序占用后再试。";
const LOCAL_SERVER_DATABASE_MESSAGE = "本地数据库无法打开。若日志显示 novel.db-wal 或 novel.db-shm 权限错误，请关闭占用这些文件的程序后重试。";
const LOCAL_SERVER_RETRY_LIMIT_MESSAGE = "本地服务连续启动失败次数已达到上限。请先根据 Desktop 日志处理上一次启动错误，再重新进入本地工作区。";
const LOCAL_SERVER_UNKNOWN_MESSAGE = "本地服务启动失败，请查看 Desktop 日志";
const LOCAL_SERVER_SHUTDOWN_MESSAGE = "本地服务未能正常关闭";

function readErrorField(error: unknown, field: string): string | null {
  if (typeof error !== "object" || error === null || !(field in error)) return null;
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStorageManifestFailure(error: unknown, message: string): boolean {
  if (error instanceof Error && (error.name === "StorageManifestError" || error.name === "DesktopStorageError")) return true;
  const code = readErrorField(error, "code");
  if (code?.startsWith("STORAGE_")) return true;
  return message.includes("存储清单")
    || message.includes("数据目录")
    || message.includes("已拒绝认领")
    || message.includes("已拒绝打开")
    || message.includes("存储目录版本");
}

function isDatabaseOpenFailure(error: unknown, message: string): boolean {
  const syscall = readErrorField(error, "syscall");
  if (syscall === "listen" || syscall === "bind") return false;
  const path = readErrorField(error, "path") ?? "";
  if (/novel\.db(?:-wal|-shm)?/u.test(path) || /novel\.db(?:-wal|-shm)?/u.test(message)) return true;
  if (readErrorField(error, "code") === "ERR_SQLITE_ERROR") return true;
  return /unable to open database file|disk I\/O error|database is locked/iu.test(message);
}

function listenFailurePort(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("port" in error)) return undefined;
  const port = (error as { port?: unknown }).port;
  return typeof port === "number" && Number.isInteger(port) ? port : undefined;
}

/** 监听失败才改写成端口提示。数据库 chmod 的 EPERM 必须留给数据库文案。 */
export function shouldReportAsPortUnavailable(error: unknown): boolean {
  if (error instanceof LocalServerPortUnavailableError) return false;
  if (!isLocalPortUnbindableError(error)) return false;
  return !isDatabaseOpenFailure(error, errorText(error));
}

export function formatLocalServerFatalLog(phase: string, code: string, rawMessage: string): string {
  return `Desktop local server fatal phase=${phase} code=${code}: ${rawMessage}\n`;
}

export function describeLocalServerStartupFailure(
  error: unknown,
  phase: LocalServerFatalMessage["phase"]
): { code: string; safeMessage: string } {
  if (phase === "shutdown") {
    return { code: "LOCAL_SERVER_SHUTDOWN_FAILED", safeMessage: LOCAL_SERVER_SHUTDOWN_MESSAGE };
  }
  const message = errorText(error);
  if (error instanceof LocalServerPortUnavailableError) {
    return { code: "LOCAL_PORT_UNAVAILABLE", safeMessage: error.message };
  }
  if (message.includes("Startup retry limit reached")) {
    return { code: "LOCAL_STARTUP_RETRY_LIMIT", safeMessage: LOCAL_SERVER_RETRY_LIMIT_MESSAGE };
  }
  if (isStorageManifestFailure(error, message)) {
    return { code: "LOCAL_STORAGE_INVALID", safeMessage: LOCAL_SERVER_STORAGE_MESSAGE };
  }
  if (isDatabaseOpenFailure(error, message)) {
    return { code: "LOCAL_DATABASE_OPEN_FAILED", safeMessage: LOCAL_SERVER_DATABASE_MESSAGE };
  }
  if (shouldReportAsPortUnavailable(error)) {
    return { code: "LOCAL_PORT_UNAVAILABLE", safeMessage: localServerPortUnavailableMessage(listenFailurePort(error)) };
  }
  if (phase === "validate" || message.includes("Desktop 版本无效") || message.includes("invalid start message")) {
    return { code: "LOCAL_START_MESSAGE_INVALID", safeMessage: LOCAL_SERVER_INVALID_ARGUMENT_MESSAGE };
  }
  return { code: "LOCAL_SERVER_START_FAILED", safeMessage: LOCAL_SERVER_UNKNOWN_MESSAGE };
}

export function parseLocalSetupInput(value: unknown): { username: string; password: string } {
  if (!isRecord(value)) throw new LocalServerContractError("LOCAL_SETUP_INVALID", "本地管理员初始化请求无效");
  assertExactKeys(value, ["username", "password"]);
  if (typeof value.username !== "string") throw new LocalServerContractError("LOCAL_USERNAME_INVALID", "用户名无效");
  const username = value.username.trim();
  if (username.length < 3 || username.length > 40 || !/^[\p{L}\p{N}_.-]+$/u.test(username)) {
    throw new LocalServerContractError("LOCAL_USERNAME_INVALID", "用户名需为 3 到 40 个文字、数字、点、下划线或短横线");
  }
  if (typeof value.password !== "string" || value.password.length < 10 || value.password.length > 200) {
    throw new LocalServerContractError("LOCAL_PASSWORD_INVALID", "密码长度必须在 10 到 200 个字符之间");
  }
  return { username, password: value.password };
}

export function parseLocalLoginInput(value: unknown): { username: string; password: string } {
  if (!isRecord(value)) throw new LocalServerContractError("LOCAL_LOGIN_INVALID", "本地登录请求无效");
  assertExactKeys(value, ["username", "password"]);
  const username = typeof value.username === "string" ? value.username.trim() : "";
  if (username.length === 0 || username.length > 100) {
    throw new LocalServerContractError("LOCAL_USERNAME_INVALID", "用户名长度必须在 1 到 100 个字符之间");
  }
  if (typeof value.password !== "string" || value.password.length === 0 || value.password.length > 200) {
    throw new LocalServerContractError("LOCAL_PASSWORD_INVALID", "密码长度必须在 1 到 200 个字符之间");
  }
  return { username, password: value.password };
}

export function filterLocalServerEnvironment(environment: NodeJS.ProcessEnv): LocalServerEnvironment {
  const filtered: LocalServerEnvironment = {
    NODE_ENV: "production",
    APP_ALLOW_PRIVATE_AI_ENDPOINTS: "true"
  };
  for (const key of LOCAL_SERVER_ALLOWED_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (typeof value === "string" && value.length <= 256) filtered[key] = value;
  }
  return filtered;
}

export function parseLocalServerEnvironment(value: unknown): LocalServerEnvironment {
  if (!isRecord(value)) throw new LocalServerContractError("LOCAL_ENV_INVALID", "本地服务环境变量无效");
  const allowed = new Set<string>(["NODE_ENV", "APP_ALLOW_PRIVATE_AI_ENDPOINTS", ...LOCAL_SERVER_ALLOWED_ENVIRONMENT_KEYS]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new LocalServerContractError("LOCAL_ENV_FORBIDDEN", "本地服务环境变量不在允许列表中");
  }
  if (value.NODE_ENV !== "production") throw new LocalServerContractError("LOCAL_ENV_INVALID", "本地服务必须使用 production 环境");
  if (value.APP_ALLOW_PRIVATE_AI_ENDPOINTS !== "true") {
    throw new LocalServerContractError("LOCAL_ENV_INVALID", "本地工作区必须允许连接本机与局域网 AI 供应商");
  }
  const parsed: LocalServerEnvironment = {
    NODE_ENV: "production",
    APP_ALLOW_PRIVATE_AI_ENDPOINTS: "true"
  };
  for (const key of LOCAL_SERVER_ALLOWED_ENVIRONMENT_KEYS) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string" || candidate.length > 256) {
      throw new LocalServerContractError("LOCAL_ENV_INVALID", "本地服务环境变量值无效");
    }
    parsed[key] = candidate;
  }
  return parsed;
}

export function parseLocalServerParentMessage(value: unknown): LocalServerParentMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务消息无效");
  }
  if (value.type === "shutdown") {
    assertExactKeys(value, ["type", "requestId"]);
    return { type: "shutdown", requestId: assertRequestId(value.requestId) };
  }
  if (value.type === "provision") {
    assertExactKeys(value, ["type", "requestId", "username", "password"]);
    return {
      type: "provision",
      requestId: assertRequestId(value.requestId),
      ...parseLocalSetupInput({ username: value.username, password: value.password })
    };
  }
  if (value.type === "login") {
    assertExactKeys(value, ["type", "requestId", "username", "password"]);
    return {
      type: "login",
      requestId: assertRequestId(value.requestId),
      ...parseLocalLoginInput({ username: value.username, password: value.password })
    };
  }
  if (value.type !== "start") throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务消息类型无效");
  assertExactKeys(value, ["type", "dataDirectory", "databasePath", "publicPath", "vditorPath", "preferredPort", "desktopId", "profileId", "clientVersion", "envAllowlist"]);
  const dataDirectory = assertAbsolutePath(value.dataDirectory, "本地数据目录");
  const databasePath = assertAbsolutePath(value.databasePath, "本地数据库路径");
  if (databasePath !== join(dataDirectory, "novel.db")) {
    throw new LocalServerContractError("LOCAL_PATH_INVALID", "本地数据库必须位于 Desktop runtime 目录");
  }
  return {
    type: "start",
    dataDirectory,
    databasePath,
    publicPath: assertAbsolutePath(value.publicPath, "本地页面资源路径"),
    vditorPath: assertAbsolutePath(value.vditorPath, "Vditor 资源路径"),
    preferredPort: parseLocalServerPort(value.preferredPort),
    desktopId: assertRequestId(value.desktopId),
    profileId: assertRequestId(value.profileId),
    clientVersion: assertDesktopVersion(value.clientVersion),
    envAllowlist: parseLocalServerEnvironment(value.envAllowlist)
  };
}

export function parseLocalServerUtilityMessage(value: unknown): LocalServerUtilityMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务响应无效");
  }
  if (value.type === "stopped") {
    assertExactKeys(value, ["type", "requestId"]);
    return { type: "stopped", requestId: assertRequestId(value.requestId) };
  }
  if (value.type === "authentication-failed") {
    assertExactKeys(value, ["type", "requestId", "code", "safeMessage"]);
    const requestId = assertRequestId(value.requestId);
    if (typeof value.code !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(value.code)) {
      throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地初始化错误代码无效");
    }
    if (typeof value.safeMessage !== "string" || value.safeMessage.length === 0 || value.safeMessage.length > 300) {
      throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地初始化错误信息无效");
    }
    return { type: "authentication-failed", requestId, code: value.code, safeMessage: value.safeMessage };
  }
  if (value.type === "authenticated") {
    assertExactKeys(value, ["type", "requestId", "token", "expiresAt", "user"]);
    const requestId = assertRequestId(value.requestId);
    if (typeof value.token !== "string" || !/^scrvd_[A-Za-z0-9_-]{43}$/u.test(value.token)) {
      throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地 Desktop token 无效");
    }
    if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) {
      throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地 Desktop token 到期时间无效");
    }
    if (!isRecord(value.user)) throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地初始化用户无效");
    assertExactKeys(value.user, ["userId", "username", "displayName", "role", "status", "createdAt", "avatarUrl", "onboardingCompleted", "isSystemAdmin"]);
    if (
      typeof value.user.userId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.user.userId)
      || typeof value.user.username !== "string" || value.user.username.length === 0 || value.user.username.length > 100
      || typeof value.user.displayName !== "string" || value.user.displayName.length === 0 || value.user.displayName.length > 200
      || (value.user.role !== "admin" && value.user.role !== "user")
      || (value.user.status !== "active" && value.user.status !== "disabled")
      || typeof value.user.createdAt !== "string"
      || !Number.isFinite(Date.parse(value.user.createdAt))
      || (value.user.avatarUrl !== null && (typeof value.user.avatarUrl !== "string" || value.user.avatarUrl.length > 2_048))
      || typeof value.user.onboardingCompleted !== "boolean"
      || typeof value.user.isSystemAdmin !== "boolean"
      || value.user.isSystemAdmin !== (value.user.role === "admin")
    ) throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地初始化用户字段无效");
    return {
      type: "authenticated",
      requestId,
      token: value.token,
      expiresAt: value.expiresAt,
      user: value.user as LocalProvisionedUser
    };
  }
  if (value.type === "fatal") {
    assertExactKeys(value, ["type", "phase", "code", "safeMessage"]);
    if (!["validate", "load", "start", "shutdown", "runtime"].includes(String(value.phase))) {
      throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务 fatal 阶段无效");
    }
    if (typeof value.code !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(value.code)) {
      throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务错误代码无效");
    }
    if (typeof value.safeMessage !== "string" || value.safeMessage.length === 0 || value.safeMessage.length > 300) {
      throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务错误信息无效");
    }
    return {
      type: "fatal",
      phase: value.phase as LocalServerFatalMessage["phase"],
      code: value.code,
      safeMessage: value.safeMessage
    };
  }
  if (value.type !== "ready") throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务响应类型无效");
  assertExactKeys(value, ["type", "url", "port", "bootId", "schemaVersion"]);
  if (typeof value.url !== "string" || typeof value.bootId !== "string") {
    throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务 ready 响应无效");
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务 URL 无效");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.search || url.hash) {
    throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务必须绑定 IPv4 回环地址");
  }
  if (!Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65_535 || url.port !== String(value.port)) {
    throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务端口无效");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.bootId)) {
    throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务 bootId 无效");
  }
  if (!Number.isInteger(value.schemaVersion) || Number(value.schemaVersion) < 1) {
    throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务 schemaVersion 无效");
  }
  return {
    type: "ready",
    url: url.origin,
    port: Number(value.port),
    bootId: value.bootId,
    schemaVersion: Number(value.schemaVersion)
  };
}
