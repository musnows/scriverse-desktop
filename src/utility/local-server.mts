import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseLocalServerParentMessage,
  type LocalServerAuthenticatedMessage,
  type LocalServerAuthenticationFailedMessage,
  type LocalServerFatalMessage,
  type LocalServerReadyMessage,
  type LocalServerStoppedMessage,
  type LocalProvisionedUser
} from "../shared/local-server-contract.js";
import { LocalServerPortUnavailableError, selectLocalServerPort } from "../shared/desktop-settings-contract.js";

type RuntimeAuth = {
  hasUsers: () => boolean;
  register: (input: { username: string; password: string }) => {
    token: string;
    session: { id: string; user: LocalProvisionedUser };
  };
  loginDesktop: (username: string, password: string, input: {
    desktopId: string;
    profileId: string;
    clientVersion: string;
  }) => { token: string; session: { user: LocalProvisionedUser; expiresAt: string } };
  revoke: (sessionId: string) => void;
};

type RuntimeStore = {
  audit: (workId: string | null, action: string, entityType: string, entityId: string | null, detail?: unknown) => void;
};

type RuntimeDatabase = {
  transaction: <T>(operation: () => T) => T;
};

type LocalRuntime = {
  auth: RuntimeAuth;
  store: RuntimeStore;
  database: RuntimeDatabase;
};

type RunningServer = {
  url: string;
  port: number;
  runtime: LocalRuntime;
  close: () => Promise<void>;
};

type StartLocalServer = (options: {
  host: string;
  port: number;
  dataDirectory: string;
  databasePath: string;
  env: NodeJS.ProcessEnv;
  disableAiEndpointValidation?: boolean;
}) => Promise<RunningServer>;

let running: RunningServer | null = null;
let started = false;
let stopping = false;
let provisioning = false;
let authenticating = false;
let runWithRequestActor: (<T>(actor: LocalProvisionedUser, operation: () => T) => T) | null = null;
let desktopSessionContext: { desktopId: string; profileId: string; clientVersion: string } | null = null;

function post(message:
  | LocalServerReadyMessage
  | LocalServerAuthenticatedMessage
  | LocalServerAuthenticationFailedMessage
  | LocalServerStoppedMessage
  | LocalServerFatalMessage
): void {
  process.parentPort.postMessage(message);
}

function fatal(phase: LocalServerFatalMessage["phase"], error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof LocalServerPortUnavailableError
    ? error.code
    : message.includes("Startup retry limit reached")
      ? "LOCAL_STARTUP_RETRY_LIMIT"
      : message.includes("存储清单") || message.includes("数据目录")
        ? "LOCAL_STORAGE_INVALID"
        : phase === "validate"
          ? "LOCAL_START_MESSAGE_INVALID"
          : phase === "shutdown"
            ? "LOCAL_SERVER_SHUTDOWN_FAILED"
            : "LOCAL_SERVER_START_FAILED";
  const safeMessage = code === "LOCAL_PORT_UNAVAILABLE"
    ? message
    : code === "LOCAL_STARTUP_RETRY_LIMIT"
      ? "本地服务连续启动失败次数已达到上限，请检查日志后重试"
      : code === "LOCAL_STORAGE_INVALID"
        ? "本地工作区目录校验失败，已停止启动"
        : code === "LOCAL_START_MESSAGE_INVALID"
          ? "Desktop 发送的本地服务启动参数无效"
          : code === "LOCAL_SERVER_SHUTDOWN_FAILED"
            ? "本地服务未能正常关闭"
            : "本地服务启动失败，请查看 Desktop 日志";
  post({ type: "fatal", phase, code, safeMessage });
}

function canBindLoopbackPort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const probe = createServer();
    let settled = false;
    const finish = (available: boolean, error: unknown = null): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(available);
    };
    probe.unref();
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") finish(false);
      else finish(false, error);
    });
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close((error) => error ? finish(false, error) : finish(true));
    });
  });
}

async function start(messageValue: unknown): Promise<void> {
  let message;
  try {
    message = parseLocalServerParentMessage(messageValue);
    if (message.type !== "start" || started) throw new Error("invalid start message state");
  } catch (error) {
    fatal("validate", error);
    process.exitCode = 1;
    return;
  }
  started = true;
  try {
    const appRoot = process.env.SCRIVERSE_DESKTOP_APP_ROOT;
    if (!appRoot) throw new Error("Desktop application root is unavailable");
    const expectedPublicPath = join(appRoot, "dist", "public");
    const expectedVditorPath = join(expectedPublicPath, "vendor", "vditor", "dist");
    if (message.publicPath !== expectedPublicPath || message.vditorPath !== expectedVditorPath) {
      throw new Error("Desktop resource paths do not match the packaged application");
    }
    if (!existsSync(join(message.publicPath, "index.html")) || !existsSync(join(message.vditorPath, "index.min.js"))) {
      throw new Error("Desktop local server resources are incomplete");
    }
    const [runtimeModule, databaseModule, requestContextModule] = await Promise.all([
      import(pathToFileURL(join(appRoot, "dist", "server-runtime.js")).href) as Promise<{ startLocalServer: StartLocalServer }>,
      import(pathToFileURL(join(appRoot, "dist", "database.js")).href) as Promise<{ DATABASE_SCHEMA_VERSION: number }>,
      import(pathToFileURL(join(appRoot, "dist", "request-context.js")).href) as Promise<{
        runWithRequestActor: <T>(actor: LocalProvisionedUser, operation: () => T) => T;
      }>
    ]);
    runWithRequestActor = requestContextModule.runWithRequestActor;
    desktopSessionContext = {
      desktopId: message.desktopId,
      profileId: message.profileId,
      clientVersion: message.clientVersion
    };
    const selectedPort = await selectLocalServerPort(message.preferredPort, canBindLoopbackPort);
    running = await runtimeModule.startLocalServer({
      host: "127.0.0.1",
      port: selectedPort,
      dataDirectory: message.dataDirectory,
      databasePath: message.databasePath,
      env: message.envAllowlist,
      disableAiEndpointValidation: true
    });
    const health = await fetch(`${running.url}/api/health`).then((response) => response.json()) as {
      data?: { status?: unknown; bootId?: unknown };
    };
    if (health.data?.status !== "ok" || typeof health.data.bootId !== "string") {
      throw new Error("Desktop local server health response is invalid");
    }
    post({
      type: "ready",
      url: running.url,
      port: running.port,
      bootId: health.data.bootId,
      schemaVersion: databaseModule.DATABASE_SCHEMA_VERSION
    });
  } catch (error) {
    await running?.close().catch(() => undefined);
    running = null;
    const startupError = typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE"
      ? new LocalServerPortUnavailableError(message.preferredPort)
      : error;
    fatal("start", startupError);
    process.exitCode = 1;
  }
}

async function provision(messageValue: unknown): Promise<void> {
  let message;
  try {
    message = parseLocalServerParentMessage(messageValue);
    if (message.type !== "provision" || !started || !running || stopping) throw new Error("invalid provision message state");
  } catch (error) {
    fatal("validate", error);
    return;
  }
  if (provisioning) {
    post({
      type: "authentication-failed",
      requestId: message.requestId,
      code: "LOCAL_PROVISION_IN_PROGRESS",
      safeMessage: "本地管理员初始化正在进行"
    });
    return;
  }
  provisioning = true;
  try {
    if (running.runtime.auth.hasUsers()) {
      post({
        type: "authentication-failed",
        requestId: message.requestId,
        code: "LOCAL_ALREADY_PROVISIONED",
        safeMessage: "本地工作区已经完成初始化，请直接登录"
      });
      return;
    }
    if (!runWithRequestActor) throw new Error("request actor context is unavailable");
    const registered = running.runtime.database.transaction(() => {
      if (running!.runtime.auth.hasUsers()) throw new Error("local workspace already provisioned");
      const registered = running!.runtime.auth.register({ username: message.username, password: message.password });
      runWithRequestActor!(registered.session.user, () => {
        running!.runtime.store.audit(null, "user.registered", "user", registered.session.user.userId, {
          role: registered.session.user.role,
          source: "desktop-provision"
        });
      });
      return registered;
    });
    if (!desktopSessionContext) throw new Error("desktop session context is unavailable");
    const result = running.runtime.auth.loginDesktop(message.username, message.password, desktopSessionContext);
    running.runtime.auth.revoke(registered.session.id);
    post({
      type: "authenticated",
      requestId: message.requestId,
      token: result.token,
      expiresAt: result.session.expiresAt,
      user: result.session.user
    });
  } catch (error) {
    const alreadyProvisioned = error instanceof Error && error.message === "local workspace already provisioned";
    post({
      type: "authentication-failed",
      requestId: message.requestId,
      code: alreadyProvisioned ? "LOCAL_ALREADY_PROVISIONED" : "LOCAL_PROVISION_FAILED",
      safeMessage: alreadyProvisioned
        ? "本地工作区已经完成初始化，请直接登录"
        : "本地管理员初始化失败，请重试"
    });
  } finally {
    provisioning = false;
  }
}

async function login(messageValue: unknown): Promise<void> {
  let message;
  try {
    message = parseLocalServerParentMessage(messageValue);
    if (message.type !== "login" || !started || !running || stopping) throw new Error("invalid login message state");
  } catch (error) {
    fatal("validate", error);
    return;
  }
  if (authenticating) {
    post({
      type: "authentication-failed",
      requestId: message.requestId,
      code: "LOCAL_LOGIN_IN_PROGRESS",
      safeMessage: "本地工作区正在登录"
    });
    return;
  }
  authenticating = true;
  try {
    if (!desktopSessionContext) throw new Error("desktop session context is unavailable");
    const result = running.runtime.auth.loginDesktop(message.username, message.password, desktopSessionContext);
    post({
      type: "authenticated",
      requestId: message.requestId,
      token: result.token,
      expiresAt: result.session.expiresAt,
      user: result.session.user
    });
  } catch {
    post({
      type: "authentication-failed",
      requestId: message.requestId,
      code: "INVALID_CREDENTIALS",
      safeMessage: "用户名或密码不正确"
    });
  } finally {
    authenticating = false;
  }
}

async function shutdown(messageValue: unknown): Promise<void> {
  let message;
  try {
    message = parseLocalServerParentMessage(messageValue);
    if (message.type !== "shutdown" || !started || !running || stopping) throw new Error("invalid shutdown message state");
  } catch (error) {
    fatal("validate", error);
    return;
  }
  stopping = true;
  try {
    await running.close();
    running = null;
    post({ type: "stopped", requestId: message.requestId });
    process.exitCode = 0;
    setImmediate(() => process.exit());
  } catch (error) {
    fatal("shutdown", error);
    process.exitCode = 1;
  }
}

process.on("uncaughtException", (error) => {
  fatal("runtime", error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  fatal("runtime", error);
  process.exit(1);
});
process.parentPort.on("message", (event) => {
  const value = event.data;
  if (!started) {
    void start(value);
    return;
  }
  if (typeof value === "object" && value !== null && "type" in value && value.type === "provision") {
    void provision(value);
    return;
  }
  if (typeof value === "object" && value !== null && "type" in value && value.type === "login") {
    void login(value);
    return;
  }
  void shutdown(value);
});
