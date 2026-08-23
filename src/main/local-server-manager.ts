import { utilityProcess, type UtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { DesktopPaths } from "./app-paths.js";
import { acquireLocalVaultLock, type LocalVaultLock } from "./vault-lock.js";
import {
  filterLocalServerEnvironment,
  LOCAL_SERVER_HEALTH_MAX_BYTES,
  LOCAL_SERVER_HEALTH_TIMEOUT_MS,
  LOCAL_SERVER_SHUTDOWN_TIMEOUT_MS,
  LOCAL_SERVER_START_TIMEOUT_MS,
  parseLocalSetupInput,
  parseLocalServerUtilityMessage,
  type LocalProvisionedUser,
  type LocalServerPublicStatus,
  type LocalServerReadyMessage,
  type LocalServerStartMessage
} from "../shared/local-server-contract.js";

export type LocalServerReady = LocalServerReadyMessage & {
  setupRequired: boolean;
};

export type LocalProvisionResult = {
  user: LocalProvisionedUser;
  sessionToken: string;
  url: string;
};

type PendingProvision = {
  requestId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (result: LocalProvisionResult) => void;
  reject: (error: LocalServerManagerError) => void;
};

export class LocalServerManagerError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "LocalServerManagerError";
  }
}

type LocalServerManagerOptions = {
  paths: DesktopPaths;
  desktopId: string;
  applicationRoot: string;
  desktopRoot: string;
  utilityWorkingDirectory: string;
  environment?: NodeJS.ProcessEnv;
};

async function readBoundedJson(response: globalThis.Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new LocalServerManagerError("LOCAL_HEALTH_FAILED", "本地服务健康检查失败");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > LOCAL_SERVER_HEALTH_MAX_BYTES) {
      await reader.cancel();
      throw new LocalServerManagerError("LOCAL_HEALTH_TOO_LARGE", "本地服务健康响应超过大小上限");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new LocalServerManagerError("LOCAL_HEALTH_INVALID", "本地服务健康响应不是有效 JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class LocalServerManager {
  private child: UtilityProcess | null = null;
  private lock: LocalVaultLock | null = null;
  private ready: LocalServerReady | null = null;
  private status: LocalServerPublicStatus = { phase: "stopped", setupRequired: null, errorCode: null };
  private startPromise: Promise<LocalServerReady> | null = null;
  private stopPromise: Promise<void> | null = null;
  private shutdownResolve: (() => void) | null = null;
  private shutdownRequestId: string | null = null;
  private provisionPromise: Promise<LocalProvisionResult> | null = null;
  private pendingProvision: PendingProvision | null = null;
  private readonly utilityLogRemainders = { stdout: "", stderr: "" };
  private readonly listeners = new Set<(status: LocalServerPublicStatus) => void>();

  constructor(private readonly options: LocalServerManagerOptions) {}

  getStatus(): LocalServerPublicStatus {
    return { ...this.status };
  }

  onStatus(listener: (status: LocalServerPublicStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setStatus(status: LocalServerPublicStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(this.getStatus());
  }

  private rejectPendingProvision(error: LocalServerManagerError): void {
    const pending = this.pendingProvision;
    if (!pending) return;
    this.pendingProvision = null;
    clearTimeout(pending.timeout);
    pending.reject(error);
  }

  private handleProvisionMessage(message: Extract<ReturnType<typeof parseLocalServerUtilityMessage>, {
    type: "provisioned" | "provision-failed";
  }>): void {
    const pending = this.pendingProvision;
    if (!pending || pending.requestId !== message.requestId) {
      this.beginUnexpectedStop("LOCAL_MESSAGE_INVALID");
      return;
    }
    this.pendingProvision = null;
    clearTimeout(pending.timeout);
    if (message.type === "provision-failed") {
      pending.reject(new LocalServerManagerError(message.code, message.safeMessage));
      return;
    }
    if (!this.ready) {
      pending.reject(new LocalServerManagerError("LOCAL_SERVER_NOT_RUNNING", "本地服务尚未启动"));
      return;
    }
    this.ready = { ...this.ready, setupRequired: false };
    this.setStatus({ phase: "running", setupRequired: false, errorCode: null });
    pending.resolve({ user: message.user, sessionToken: message.sessionToken, url: this.ready.url });
  }

  private releaseLock(): void {
    const lock = this.lock;
    this.lock = null;
    try {
      lock?.release();
    } catch (error) {
      process.stderr.write(`Local vault lock release failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  private async terminateChild(child: UtilityProcess): Promise<boolean> {
    if (child.pid === undefined) return true;
    let exited = false;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, 3_000);
      child.once("exit", () => {
        exited = true;
        finish();
      });
      child.kill();
    });
    return exited || child.pid === undefined;
  }

  private redactUtilityLog(output: string): string {
    const pathsToRedact = [
      this.options.applicationRoot,
      this.options.paths.root,
      this.options.paths.localRuntime,
      join(this.options.paths.localRuntime, "novel.db")
    ].toSorted((left, right) => right.length - left.length);
    for (const path of pathsToRedact) output = output.split(path).join("[desktop-path]");
    return output;
  }

  private writeUtilityLog(chunk: Buffer | string, stream: "stdout" | "stderr"): void {
    const combined = `${this.utilityLogRemainders[stream]}${String(chunk)}`;
    const lines = combined.split("\n");
    this.utilityLogRemainders[stream] = lines.pop() ?? "";
    if (this.utilityLogRemainders[stream].length > 100_000) {
      this.utilityLogRemainders[stream] = "[oversized local log line omitted]";
    }
    const output = lines.map((line) => `${line}\n`).join("");
    if (output) process.stderr.write(this.redactUtilityLog(output));
  }

  private flushUtilityLogs(): void {
    const output = `${this.utilityLogRemainders.stdout}${this.utilityLogRemainders.stderr}`;
    this.utilityLogRemainders.stdout = "";
    this.utilityLogRemainders.stderr = "";
    if (!output) return;
    process.stderr.write(this.redactUtilityLog(output));
  }

  private async verifyReady(message: LocalServerReadyMessage): Promise<LocalServerReady> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOCAL_SERVER_HEALTH_TIMEOUT_MS);
    try {
      const [healthValue, sessionValue] = await Promise.all([
        fetch(`${message.url}/api/health`, { signal: controller.signal, redirect: "error" }).then(readBoundedJson),
        fetch(`${message.url}/api/auth/session`, { signal: controller.signal, redirect: "error" }).then(readBoundedJson)
      ]);
      if (!isRecord(healthValue) || !isRecord(healthValue.data)) {
        throw new LocalServerManagerError("LOCAL_HEALTH_INVALID", "本地服务健康响应格式无效");
      }
      if (healthValue.data.status !== "ok" || healthValue.data.bootId !== message.bootId) {
        throw new LocalServerManagerError("LOCAL_BOOT_ID_MISMATCH", "本地服务实例校验失败");
      }
      if (!isRecord(sessionValue) || !isRecord(sessionValue.data)) {
        throw new LocalServerManagerError("LOCAL_SESSION_INVALID", "本地服务会话状态响应无效");
      }
      if (sessionValue.data.bootId !== message.bootId || typeof sessionValue.data.setupRequired !== "boolean") {
        throw new LocalServerManagerError("LOCAL_SESSION_INVALID", "本地服务会话状态校验失败");
      }
      return { ...message, setupRequired: sessionValue.data.setupRequired };
    } catch (error) {
      if (error instanceof LocalServerManagerError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new LocalServerManagerError("LOCAL_HEALTH_TIMEOUT", "本地服务健康检查超时");
      }
      throw new LocalServerManagerError("LOCAL_HEALTH_FAILED", "本地服务健康检查失败");
    } finally {
      clearTimeout(timeout);
    }
  }

  start(): Promise<LocalServerReady> {
    if (this.ready && this.status.phase === "running") return Promise.resolve({ ...this.ready });
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.launch().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async launch(): Promise<LocalServerReady> {
    if (this.stopPromise) await this.stopPromise;
    this.setStatus({ phase: "starting", setupRequired: null, errorCode: null });
    try {
      this.lock = acquireLocalVaultLock({
        lockPath: this.options.paths.localVaultLock,
        databasePath: join(this.options.paths.localRuntime, "novel.db"),
        desktopId: this.options.desktopId
      });
      const child = utilityProcess.fork(join(this.options.desktopRoot, "utility", "local-server.mjs"), [], {
        cwd: this.options.utilityWorkingDirectory,
        env: {
          NODE_ENV: "production",
          SCRIVERSE_DESKTOP_APP_ROOT: this.options.applicationRoot
        },
        serviceName: "Scriverse Desktop Local Server",
        stdio: "pipe"
      });
      this.child = child;
      child.stdout?.on("data", (chunk: Buffer | string) => this.writeUtilityLog(chunk, "stdout"));
      child.stderr?.on("data", (chunk: Buffer | string) => this.writeUtilityLog(chunk, "stderr"));
      const startMessage: LocalServerStartMessage = {
        type: "start",
        dataDirectory: this.options.paths.localRuntime,
        databasePath: join(this.options.paths.localRuntime, "novel.db"),
        publicPath: join(this.options.applicationRoot, "dist", "public"),
        vditorPath: join(this.options.applicationRoot, "dist", "public", "vendor", "vditor", "dist"),
        envAllowlist: filterLocalServerEnvironment(this.options.environment ?? process.env)
      };
      const ready = await new Promise<LocalServerReady>((resolve, reject) => {
        let settled = false;
        const finishError = (error: LocalServerManagerError): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(error);
        };
        const timeout = setTimeout(() => finishError(new LocalServerManagerError(
          "LOCAL_START_TIMEOUT",
          "本地服务启动超时"
        )), LOCAL_SERVER_START_TIMEOUT_MS);
        child.once("spawn", () => child.postMessage(startMessage));
        child.on("message", (value: unknown) => {
          let message;
          try {
            message = parseLocalServerUtilityMessage(value);
          } catch {
            finishError(new LocalServerManagerError("LOCAL_MESSAGE_INVALID", "本地服务返回了无效消息"));
            return;
          }
          if (message.type === "provisioned" || message.type === "provision-failed") {
            this.handleProvisionMessage(message);
            return;
          }
          if (message.type === "fatal") {
            if (!settled) finishError(new LocalServerManagerError(message.code, message.safeMessage));
            else this.beginUnexpectedStop(message.code);
            return;
          }
          if (message.type === "stopped") {
            if (message.requestId !== this.shutdownRequestId) {
              if (!settled) finishError(new LocalServerManagerError("LOCAL_MESSAGE_INVALID", "本地服务返回了不匹配的停止响应"));
              else this.beginUnexpectedStop("LOCAL_MESSAGE_INVALID");
              return;
            }
            this.shutdownResolve?.();
            return;
          }
          if (settled) return;
          void this.verifyReady(message).then((verified) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            resolve(verified);
          }, (error: unknown) => finishError(error instanceof LocalServerManagerError
            ? error
            : new LocalServerManagerError("LOCAL_HEALTH_FAILED", "本地服务健康检查失败")));
        });
        child.once("error", () => {
          if (!settled) finishError(new LocalServerManagerError("LOCAL_PROCESS_FAILED", "本地服务进程启动失败"));
          else this.beginUnexpectedStop("LOCAL_PROCESS_FAILED");
        });
        child.once("exit", () => {
          this.flushUtilityLogs();
          if (!settled) finishError(new LocalServerManagerError("LOCAL_PROCESS_EXITED", "本地服务进程在启动完成前退出"));
          else if (this.child === child && this.status.phase !== "stopping") this.finalizeUnexpectedStop("LOCAL_PROCESS_EXITED");
          else this.shutdownResolve?.();
        });
      });
      if (this.child !== child) throw new LocalServerManagerError("LOCAL_PROCESS_EXITED", "本地服务进程已停止");
      this.ready = ready;
      this.setStatus({ phase: "running", setupRequired: ready.setupRequired, errorCode: null });
      return { ...ready };
    } catch (error) {
      const managerError = error instanceof LocalServerManagerError
        ? error
        : new LocalServerManagerError(
          error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "LOCAL_SERVER_START_FAILED",
          error instanceof Error ? error.message : "本地服务启动失败"
        );
      const child = this.child;
      this.child = null;
      const terminated = child ? await this.terminateChild(child) : true;
      if (!terminated) this.child = child;
      this.ready = null;
      this.rejectPendingProvision(new LocalServerManagerError("LOCAL_PROCESS_EXITED", "本地服务进程已停止"));
      if (terminated) this.releaseLock();
      const finalError = terminated
        ? managerError
        : new LocalServerManagerError("LOCAL_PROCESS_STUCK", "本地服务进程未能退出，Desktop 已保留数据锁");
      this.setStatus({ phase: "failed", setupRequired: null, errorCode: finalError.code });
      throw finalError;
    }
  }

  private beginUnexpectedStop(errorCode: string): void {
    this.ready = null;
    this.rejectPendingProvision(new LocalServerManagerError(errorCode, "本地服务进程已停止"));
    this.setStatus({ phase: "failed", setupRequired: null, errorCode });
    this.child?.kill();
  }

  private finalizeUnexpectedStop(errorCode: string): void {
    const resolvedErrorCode = this.status.errorCode ?? errorCode;
    this.child = null;
    this.ready = null;
    this.rejectPendingProvision(new LocalServerManagerError(resolvedErrorCode, "本地服务进程已停止"));
    this.releaseLock();
    this.setStatus({ phase: "failed", setupRequired: null, errorCode: resolvedErrorCode });
    this.shutdownResolve?.();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.shutdown().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  provision(input: unknown): Promise<LocalProvisionResult> {
    if (!this.child || !this.ready || this.status.phase !== "running") {
      return Promise.reject(new LocalServerManagerError("LOCAL_SERVER_NOT_RUNNING", "本地服务尚未启动"));
    }
    if (!this.ready.setupRequired) {
      return Promise.reject(new LocalServerManagerError("LOCAL_ALREADY_PROVISIONED", "本地工作区已经完成初始化，请直接登录"));
    }
    if (this.provisionPromise) {
      return Promise.reject(new LocalServerManagerError("LOCAL_PROVISION_IN_PROGRESS", "本地管理员初始化正在进行"));
    }
    let parsed: { username: string; password: string };
    try {
      parsed = parseLocalSetupInput(input);
    } catch (error) {
      return Promise.reject(error);
    }
    const requestId = randomUUID();
    this.provisionPromise = new Promise<LocalProvisionResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pendingProvision?.requestId !== requestId) return;
        this.pendingProvision = null;
        reject(new LocalServerManagerError("LOCAL_PROVISION_TIMEOUT", "本地管理员初始化超时"));
      }, LOCAL_SERVER_START_TIMEOUT_MS);
      this.pendingProvision = { requestId, timeout, resolve, reject };
      try {
        this.child!.postMessage({ type: "provision", requestId, ...parsed });
      } catch {
        this.pendingProvision = null;
        clearTimeout(timeout);
        reject(new LocalServerManagerError("LOCAL_PROVISION_FAILED", "本地管理员初始化请求发送失败"));
      }
    }).finally(() => {
      this.provisionPromise = null;
    });
    return this.provisionPromise;
  }

  private async shutdown(): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    if (this.provisionPromise) await this.provisionPromise.catch(() => undefined);
    const child = this.child;
    if (!child) {
      this.ready = null;
      this.releaseLock();
      this.setStatus({ phase: "stopped", setupRequired: null, errorCode: null });
      return;
    }
    this.setStatus({ phase: "stopping", setupRequired: this.ready?.setupRequired ?? null, errorCode: null });
    const requestId = randomUUID();
    this.shutdownRequestId = requestId;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let stoppedGracefully = false;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.shutdownResolve = null;
        this.shutdownRequestId = null;
        resolve();
      };
      this.shutdownResolve = () => {
        stoppedGracefully = true;
        finish();
      };
      timeout = setTimeout(() => {
        child.kill();
        finish();
      }, LOCAL_SERVER_SHUTDOWN_TIMEOUT_MS);
      child.postMessage({ type: "shutdown", requestId });
    });
    const terminated = stoppedGracefully || await this.terminateChild(child);
    if (!terminated) {
      this.child = child;
      this.ready = null;
      this.setStatus({ phase: "failed", setupRequired: null, errorCode: "LOCAL_PROCESS_STUCK" });
      return;
    }
    if (this.child === child) this.child = null;
    this.ready = null;
    this.releaseLock();
    this.setStatus({ phase: "stopped", setupRequired: null, errorCode: null });
  }
}
