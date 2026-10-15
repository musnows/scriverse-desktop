import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LocalServerPortUnavailableError } from "../../src/shared/desktop-settings-contract.js";
import {
  describeLocalServerStartupFailure,
  filterLocalServerEnvironment,
  formatLocalServerFatalLog,
  parseLocalLoginInput,
  parseLocalSetupInput,
  parseLocalServerEnvironment,
  parseLocalServerParentMessage,
  parseLocalServerUtilityMessage,
  shouldReportAsPortUnavailable
} from "../../src/shared/local-server-contract.js";

const root = process.platform === "win32" ? "C:\\desktop\\runtime" : "/desktop/runtime";
const publicPath = process.platform === "win32" ? "C:\\app\\dist\\public" : "/app/dist/public";
const startMessage = {
  type: "start",
  dataDirectory: root,
  databasePath: join(root, "novel.db"),
  publicPath,
  vditorPath: join(publicPath, "vendor", "vditor", "dist"),
  preferredPort: 23_241,
  desktopId: "11111111-1111-4111-8111-111111111111",
  profileId: "22222222-2222-4222-8222-222222222222",
  envAllowlist: { NODE_ENV: "production", APP_ALLOW_PRIVATE_AI_ENDPOINTS: "true" }
};

describe("Desktop 本地服务消息契约", () => {
  it.each(["1.1.6", "1.1.7.1", "1.1.10.0", "1.2.0.0", "1.2.0.1", "1.2.0.2", "1.2.0-beta.1", "1.2.0.1-beta.1"])("启动时接受并保留 Desktop 版本 %s", (clientVersion) => {
    expect(parseLocalServerParentMessage({ ...startMessage, clientVersion })).toMatchObject({ type: "start", clientVersion });
  });

  it("启动时接受包元数据中的实际 Desktop 版本", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(parseLocalServerParentMessage({ ...startMessage, clientVersion: manifest.version })).toMatchObject({ clientVersion: manifest.version });
  });

  it.each([undefined, null, 1.2, "", "1.2", "1.2.0.", "1.2.0.a", "1.2.0.-1", "1.2.0.0.1", "v1.2.0.1"])("启动时拒绝无效 Desktop 版本 %s", (clientVersion) => {
    expect(() => parseLocalServerParentMessage({ ...startMessage, clientVersion })).toThrowError(/Desktop 版本无效/u);
  });

  it("把常见本地启动失败映射成选择页可直接显示的中文说明", () => {
    const invalid = describeLocalServerStartupFailure(new Error("Desktop 版本无效"), "validate");
    expect(invalid).toEqual({
      code: "LOCAL_START_MESSAGE_INVALID",
      safeMessage: "本地服务启动参数无效。请重新打开叙界；若刚升级过，请重新安装当前 Desktop 版本后再进入本地工作区。"
    });
    expect(describeLocalServerStartupFailure(new Error("invalid start message state"), "validate").safeMessage).toBe(invalid.safeMessage);

    const exhausted = new LocalServerPortUnavailableError(23_241);
    expect(describeLocalServerStartupFailure(exhausted, "start")).toEqual({
      code: "LOCAL_PORT_UNAVAILABLE",
      safeMessage: exhausted.message
    });
    expect(exhausted.message).toContain("系统设置");
    expect(exhausted.message).toContain("排除范围之外");

    const listenEacces = Object.assign(new Error("listen EACCES: permission denied 127.0.0.1:23241"), {
      code: "EACCES",
      syscall: "listen",
      port: 23_241
    });
    const listenInUse = Object.assign(new Error("listen EADDRINUSE: address already in use 127.0.0.1:23241"), {
      code: "EADDRINUSE",
      syscall: "listen",
      port: 23_241
    });
    const listenEperm = Object.assign(new Error("listen EPERM: operation not permitted 127.0.0.1:23241"), {
      code: "EPERM",
      syscall: "listen",
      port: 23_241
    });
    for (const error of [listenEacces, listenInUse, listenEperm]) {
      expect(shouldReportAsPortUnavailable(error)).toBe(true);
      expect(describeLocalServerStartupFailure(error, "start")).toEqual({
        code: "LOCAL_PORT_UNAVAILABLE",
        safeMessage: exhausted.message
      });
    }

    const storage = new Error("非空目录缺少可验证的 Scriverse Server 数据库，已拒绝认领");
    storage.name = "StorageManifestError";
    Object.assign(storage, { code: "STORAGE_DIRECTORY_UNCLAIMED" });
    expect(describeLocalServerStartupFailure(storage, "start")).toEqual({
      code: "LOCAL_STORAGE_INVALID",
      safeMessage: "本地工作区目录校验失败，已停止启动。请确认本地工作区目录完整且没有被其他程序占用后再试。"
    });
    expect(describeLocalServerStartupFailure(new Error("存储清单格式无效"), "start").code).toBe("LOCAL_STORAGE_INVALID");

    const databasePermission = Object.assign(
      new Error("EPERM: operation not permitted, chmod 'C:\\\\Users\\\\author\\\\novel.db-shm'"),
      { code: "EPERM", syscall: "chmod", path: "C:\\Users\\author\\AppData\\Local\\Scriverse Desktop\\data\\local-vault\\runtime\\novel.db-shm" }
    );
    const databaseOpen = Object.assign(new Error("unable to open database file"), { code: "ERR_SQLITE_ERROR" });
    const databaseSentence = "本地数据库无法打开。若日志显示 novel.db-wal 或 novel.db-shm 权限错误，请关闭占用这些文件的程序后重试。";
    expect(shouldReportAsPortUnavailable(databasePermission)).toBe(false);
    expect(describeLocalServerStartupFailure(databasePermission, "start")).toEqual({
      code: "LOCAL_DATABASE_OPEN_FAILED",
      safeMessage: databaseSentence
    });
    expect(describeLocalServerStartupFailure(databaseOpen, "start").safeMessage).toBe(databaseSentence);
    expect(describeLocalServerStartupFailure(new Error("EPERM: operation not permitted, chmod '/data/novel.db-wal'"), "start").code).toBe("LOCAL_DATABASE_OPEN_FAILED");

    const retry = describeLocalServerStartupFailure(
      new Error("Startup retry limit reached (2); fix the previous initialization error and remove C:\\data\\.startup-retry.json before restarting"),
      "start"
    );
    expect(retry).toEqual({
      code: "LOCAL_STARTUP_RETRY_LIMIT",
      safeMessage: "本地服务连续启动失败次数已达到上限。请先根据 Desktop 日志处理上一次启动错误，再重新进入本地工作区。"
    });
    expect(retry.safeMessage).not.toContain("删除");
    expect(retry.safeMessage).not.toContain(".startup-retry.json");

    const unknown = describeLocalServerStartupFailure(new Error("Desktop resource paths do not match the packaged application"), "start");
    expect(unknown).toEqual({
      code: "LOCAL_SERVER_START_FAILED",
      safeMessage: "本地服务启动失败，请查看 Desktop 日志"
    });
    expect(describeLocalServerStartupFailure(new Error("close failed"), "shutdown")).toEqual({
      code: "LOCAL_SERVER_SHUTDOWN_FAILED",
      safeMessage: "本地服务未能正常关闭"
    });

    for (const failure of [invalid, { code: exhausted.code, safeMessage: exhausted.message }, retry, unknown]) {
      expect(failure.safeMessage.length).toBeLessThanOrEqual(300);
      const log = formatLocalServerFatalLog("start", failure.code, "listen EACCES: permission denied 127.0.0.1:23241");
      expect(log.startsWith(`Desktop local server fatal phase=start code=${failure.code}: `)).toBe(true);
      expect(log).toContain("listen EACCES: permission denied 127.0.0.1:23241");
      expect(log).not.toContain(failure.safeMessage);
    }
  });

  it("本地服务把技术原因先写入日志，再把中文说明交给选择页", () => {
    const utilitySource = readFileSync(new URL("../../src/utility/local-server.mts", import.meta.url), "utf8");
    const gateSource = readFileSync(new URL("../../src/utility/runtime-gate.mts", import.meta.url), "utf8");
    const fatalSource = utilitySource.slice(utilitySource.indexOf("function fatal"), utilitySource.indexOf("function canBindLoopbackPort"));
    expect(fatalSource.indexOf("process.stderr.write")).toBeGreaterThan(-1);
    expect(fatalSource.indexOf("post(")).toBeGreaterThan(fatalSource.indexOf("process.stderr.write"));
    expect(utilitySource).toContain("shouldReportAsPortUnavailable");
    expect(utilitySource).toContain("isLocalPortUnbindableError");
    expect(gateSource).toContain("isLocalPortUnbindableError");
    expect(utilitySource).not.toContain('error.code === "EADDRINUSE"');
    expect(gateSource).not.toContain('error.code === "EADDRINUSE"');
  });

  it("仅在 Desktop 本地嵌入运行时完全禁用 AI endpoint validator", () => {
    const utilitySource = readFileSync(new URL("../../src/utility/local-server.mts", import.meta.url), "utf8");
    expect(utilitySource).toContain("disableAiEndpointValidation: true");
    expect(utilitySource).not.toContain("trustAiEndpointNetwork");
  });

  it("本地登录只接受软件内 Bearer 凭据", () => {
    expect(parseLocalLoginInput({ username: " author ", password: "local-password" })).toEqual({
      username: "author",
      password: "local-password"
    });
    expect(() => parseLocalLoginInput({ username: "author", password: "", cookie: "forbidden" })).toThrowError(/未知字段/u);
  });

  it("严格校验首次管理员凭据且不接受未知字段", () => {
    expect(parseLocalSetupInput({ username: " 作者_admin ", password: "long-password" })).toEqual({
      username: "作者_admin",
      password: "long-password"
    });
    expect(() => parseLocalSetupInput({ username: "ab", password: "long-password" })).toThrowError(/3 到 40/u);
    expect(() => parseLocalSetupInput({ username: "author", password: "short" })).toThrowError(/10 到 200/u);
    expect(() => parseLocalSetupInput({ username: "author", password: "long-password", setupToken: "secret" })).toThrowError(/未知字段/u);
  });

  it("只传递明确允许的环境变量", () => {
    expect(filterLocalServerEnvironment({
      NODE_ENV: "development",
      DATA_DIR: "/server-data",
      DATABASE_PATH: "/server.db",
      PORT: "13210",
      APP_DEV_SKIP_AUTH: "true",
      APP_AUTH_PASSWORD: "secret",
      SCRIVERSE_AI_RETRY_COUNT: "4",
      SCRIVERSE_AI_RESPONSE_MAX_BYTES: "0",
      APP_UPDATE_CHECK_RETRIES: "2"
    })).toEqual({
      NODE_ENV: "production",
      APP_ALLOW_PRIVATE_AI_ENDPOINTS: "true",
      SCRIVERSE_AI_RETRY_COUNT: "4",
      SCRIVERSE_AI_RESPONSE_MAX_BYTES: "0",
      APP_UPDATE_CHECK_RETRIES: "2"
    });
    expect(() => parseLocalServerEnvironment({
      NODE_ENV: "production",
      APP_ALLOW_PRIVATE_AI_ENDPOINTS: "true",
      DATA_DIR: "/server-data"
    })).toThrowError(/允许列表/u);
    expect(() => parseLocalServerEnvironment({
      NODE_ENV: "production",
      APP_ALLOW_PRIVATE_AI_ENDPOINTS: "false"
    })).toThrowError(/局域网 AI/u);
  });

  it("要求数据库和静态资源使用绝对受控路径", () => {
    expect(parseLocalServerParentMessage({
      type: "start",
      dataDirectory: root,
      databasePath: join(root, "novel.db"),
      publicPath,
      vditorPath: join(publicPath, "vendor", "vditor", "dist"),
      preferredPort: 23_241,
      desktopId: "11111111-1111-4111-8111-111111111111",
      profileId: "22222222-2222-4222-8222-222222222222",
      clientVersion: "0.1.0",
      envAllowlist: { NODE_ENV: "production", APP_ALLOW_PRIVATE_AI_ENDPOINTS: "true" }
    })).toMatchObject({ type: "start", dataDirectory: root, databasePath: join(root, "novel.db"), preferredPort: 23_241 });
    expect(() => parseLocalServerParentMessage({
      type: "start",
      dataDirectory: root,
      databasePath: join(root, "..", "server.db"),
      publicPath,
      vditorPath: join(publicPath, "vendor", "vditor", "dist"),
      preferredPort: 23_241,
      desktopId: "11111111-1111-4111-8111-111111111111",
      profileId: "22222222-2222-4222-8222-222222222222",
      clientVersion: "0.1.0",
      envAllowlist: { NODE_ENV: "production", APP_ALLOW_PRIVATE_AI_ENDPOINTS: "true" }
    })).toThrowError(/runtime 目录/u);
  });

  it("拒绝非回环 ready 响应和未知 fatal 字段", () => {
    expect(parseLocalServerUtilityMessage({
      type: "ready",
      url: "http://127.0.0.1:24321",
      port: 24321,
      bootId: "11111111-1111-4111-8111-111111111111",
      schemaVersion: 114
    })).toMatchObject({ type: "ready", port: 24321, schemaVersion: 114 });
    expect(() => parseLocalServerUtilityMessage({
      type: "ready",
      url: "http://192.168.1.20:24321",
      port: 24321,
      bootId: "11111111-1111-4111-8111-111111111111",
      schemaVersion: 114
    })).toThrowError(/回环/u);
    expect(() => parseLocalServerUtilityMessage({
      type: "fatal",
      phase: "start",
      code: "LOCAL_FAILED",
      safeMessage: "failed",
      detail: "/private/data"
    })).toThrowError(/未知字段/u);
  });

  it("验证 Desktop Bearer 响应并拒绝携带额外凭据", () => {
    const requestId = "33333333-3333-4333-8333-333333333333";
    expect(parseLocalServerUtilityMessage({
      type: "authenticated",
      requestId,
      token: `scrvd_${"a".repeat(43)}`,
      expiresAt: "2026-09-23T00:00:00.000Z",
      user: {
        userId: "44444444-4444-4444-8444-444444444444",
        username: "author",
        displayName: "author",
        role: "admin",
        status: "active",
        createdAt: "2026-08-23T00:00:00.000Z",
        avatarUrl: null,
        onboardingCompleted: false,
        isSystemAdmin: true
      }
    })).toMatchObject({ type: "authenticated", requestId, user: { role: "admin", isSystemAdmin: true } });
    expect(() => parseLocalServerUtilityMessage({
      type: "authenticated",
      requestId,
      token: `scrvd_${"a".repeat(43)}`,
      expiresAt: "2026-09-23T00:00:00.000Z",
      user: {
        userId: "44444444-4444-4444-8444-444444444444",
        username: "author",
        displayName: "author",
        role: "admin",
        status: "active",
        createdAt: "2026-08-23T00:00:00.000Z",
        avatarUrl: null,
        onboardingCompleted: false,
        isSystemAdmin: false
      }
    })).toThrowError(/用户字段/u);
    expect(() => parseLocalServerUtilityMessage({
      type: "authentication-failed",
      requestId,
      code: "LOCAL_ALREADY_PROVISIONED",
      safeMessage: "already",
      password: "leak"
    })).toThrowError(/未知字段/u);
  });
});
