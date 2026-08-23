import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Vitest 并行配置", () => {
  it("默认使用八个 worker 并允许测试文件并行", () => {
    const root = process.cwd();
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const configuration = readFileSync(join(root, "vitest.config.ts"), "utf8");

    expect(packageJson.scripts?.test).toBe("vitest run --maxWorkers=8");
    expect(configuration).toContain("fileParallelism: true");
    expect(configuration).toContain("maxWorkers: 8");
  });
});
