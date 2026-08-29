import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  developmentIsolationError,
  DESKTOP_DEVELOPMENT_MODE,
  resolveDevelopmentLocalServerPort
} from "../../src/main/development-isolation.js";

describe("Desktop development isolation", () => {
  it("拒绝没有隔离模式的非打包启动", () => {
    expect(developmentIsolationError({
      env: {},
      packaged: false,
      runtimeGateRequested: false
    })).toContain("SCRIVERSE_DESKTOP_DEV_MODE=isolated");
  });

  it("要求绝对数据目录和有效的开发端口", () => {
    const base = {
      SCRIVERSE_DESKTOP_DEV_MODE: DESKTOP_DEVELOPMENT_MODE,
      SCRIVERSE_DESKTOP_DEV_PORT: "23242"
    };
    expect(developmentIsolationError({
      env: base,
      packaged: false,
      runtimeGateRequested: false
    })).toContain("absolute SCRIVERSE_DESKTOP_DATA_DIR");
    expect(developmentIsolationError({
      env: { ...base, SCRIVERSE_DESKTOP_DATA_DIR: "/tmp/scriverse-desktop-dev" },
      packaged: false,
      runtimeGateRequested: false
    })).toBeNull();
    expect(resolveDevelopmentLocalServerPort({ ...base, SCRIVERSE_DESKTOP_DATA_DIR: "/tmp/scriverse-desktop-dev" })).toBe(23_242);
  });

  it("不让打包应用或 runtime gate 读取开发实例端口", () => {
    const env = {
      SCRIVERSE_DESKTOP_DEV_MODE: DESKTOP_DEVELOPMENT_MODE,
      SCRIVERSE_DESKTOP_DATA_DIR: "/tmp/scriverse-desktop-dev",
      SCRIVERSE_DESKTOP_DEV_PORT: "23242"
    };
    expect(resolveDevelopmentLocalServerPort(env, true)).toBeNull();
    expect(developmentIsolationError({ env: {}, packaged: false, runtimeGateRequested: true })).toBeNull();
  });

  it("启动脚本会创建独立数据目录并注入隔离端口", () => {
    const source = readFileSync(join(process.cwd(), "scripts/start-dev-isolated.mjs"), "utf8");
    expect(source).toContain("mkdtempSync");
    expect(source).toContain("SCRIVERSE_DESKTOP_DEV_MODE: \"isolated\"");
    expect(source).toContain("SCRIVERSE_DESKTOP_DATA_DIR: dataDirectory");
    expect(source).toContain("SCRIVERSE_DESKTOP_DEV_PORT: String(port)");
    expect(source).toContain("node_modules");
    expect(source).not.toContain("/Applications/叙界.app");
  });
});
