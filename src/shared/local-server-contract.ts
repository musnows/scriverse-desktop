import { isAbsolute, join, normalize } from "node:path";
import { parseLocalServerPort } from "./desktop-settings-contract.js";

export const LOCAL_SERVER_START_TIMEOUT_MS = 30_000;
export const LOCAL_SERVER_SHUTDOWN_TIMEOUT_MS = 10_000;
export const LOCAL_SERVER_HEALTH_TIMEOUT_MS = 5_000;
export const LOCAL_SERVER_HEALTH_MAX_BYTES = 64 * 1024;
export const LOCAL_COOKIE_OPERATION_TIMEOUT_MS = 30_000;
export const LOCAL_SESSION_COOKIE_NAME = "scriverse_session";
export const LOCAL_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

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
  "SCRIVERSE_AI_STREAM_IDLE_TIMEOUT_SECONDS"
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

export type LocalServerParentMessage = LocalServerStartMessage | LocalServerProvisionMessage | LocalServerShutdownMessage;

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

export type LocalServerProvisionedMessage = {
  type: "provisioned";
  requestId: string;
  sessionToken: string;
  user: LocalProvisionedUser;
};

export type LocalServerProvisionFailedMessage = {
  type: "provision-failed";
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
  | LocalServerProvisionedMessage
  | LocalServerProvisionFailedMessage
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

function assertAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || !isAbsolute(value)) {
    throw new LocalServerContractError("LOCAL_PATH_INVALID", `${label} 必须是绝对路径`);
  }
  return normalize(value);
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
  if (value.type !== "start") throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地服务消息类型无效");
  assertExactKeys(value, ["type", "dataDirectory", "databasePath", "publicPath", "vditorPath", "preferredPort", "envAllowlist"]);
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
  if (value.type === "provision-failed") {
    assertExactKeys(value, ["type", "requestId", "code", "safeMessage"]);
    const requestId = assertRequestId(value.requestId);
    if (typeof value.code !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/u.test(value.code)) {
      throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地初始化错误代码无效");
    }
    if (typeof value.safeMessage !== "string" || value.safeMessage.length === 0 || value.safeMessage.length > 300) {
      throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地初始化错误信息无效");
    }
    return { type: "provision-failed", requestId, code: value.code, safeMessage: value.safeMessage };
  }
  if (value.type === "provisioned") {
    assertExactKeys(value, ["type", "requestId", "sessionToken", "user"]);
    const requestId = assertRequestId(value.requestId);
    if (typeof value.sessionToken !== "string" || !/^[A-Za-z0-9_-]{32,128}$/u.test(value.sessionToken)) {
      throw new LocalServerContractError("LOCAL_MESSAGE_INVALID", "本地初始化 session token 无效");
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
      type: "provisioned",
      requestId,
      sessionToken: value.sessionToken,
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
