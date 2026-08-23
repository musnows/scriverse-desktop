import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    pool: "forks",
    fileParallelism: true,
    maxWorkers: 8,
    include: ["tests/**/*.test.ts"],
    exclude: ["build/**", "dist/**", "node_modules/**"],
    coverage: {
      reporter: ["text", "json-summary"]
    }
  }
});
