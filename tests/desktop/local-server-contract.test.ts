import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  filterLocalServerEnvironment,
  LOCAL_SESSION_COOKIE_NAME,
  LOCAL_SESSION_MAX_AGE_SECONDS,
  parseLocalSetupInput,
  parseLocalServerEnvironment,
  parseLocalServerParentMessage,
  parseLocalServerUtilityMessage
} from "../../src/shared/local-server-contract.js";

const root = process.platform === "win32" ? "C:\\desktop\\runtime" : "/desktop/runtime";
const publicPath = process.platform === "win32" ? "C:\\app\\dist\\public" : "/app/dist/public";

describe("Desktop 本地服务消息契约", () => {
  it("与 Server 使用同一个 HttpOnly 会话 Cookie 契约", () => {
    expect(LOCAL_SESSION_COOKIE_NAME).toBe("scriverse_session");
    expect(LOCAL_SESSION_MAX_AGE_SECONDS).toBe(30 * 24 * 60 * 60);
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
      APP_UPDATE_CHECK_RETRIES: "2"
    })).toEqual({
      NODE_ENV: "production",
      APP_ALLOW_PRIVATE_AI_ENDPOINTS: "true",
      SCRIVERSE_AI_RETRY_COUNT: "4",
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
      envAllowlist: { NODE_ENV: "production", APP_ALLOW_PRIVATE_AI_ENDPOINTS: "true" }
    })).toMatchObject({ type: "start", dataDirectory: root, databasePath: join(root, "novel.db"), preferredPort: 23_241 });
    expect(() => parseLocalServerParentMessage({
      type: "start",
      dataDirectory: root,
      databasePath: join(root, "..", "server.db"),
      publicPath,
      vditorPath: join(publicPath, "vendor", "vditor", "dist"),
      preferredPort: 23_241,
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

  it("验证 provision 响应并拒绝携带额外凭据", () => {
    const requestId = "33333333-3333-4333-8333-333333333333";
    expect(parseLocalServerUtilityMessage({
      type: "provisioned",
      requestId,
      sessionToken: "a".repeat(43),
      user: {
        userId: "44444444-4444-4444-8444-444444444444",
        username: "author",
        displayName: "author",
        role: "admin",
        status: "active",
        createdAt: "2026-08-23T00:00:00.000Z",
        avatarUrl: null,
        onboardingCompleted: false
      }
    })).toMatchObject({ type: "provisioned", requestId, user: { role: "admin" } });
    expect(() => parseLocalServerUtilityMessage({
      type: "provision-failed",
      requestId,
      code: "LOCAL_ALREADY_PROVISIONED",
      safeMessage: "already",
      password: "leak"
    })).toThrowError(/未知字段/u);
  });
});
