import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Desktop runtime gate isolation", () => {
  it("runs independently from an already open Desktop instance", () => {
    const source = readFileSync(join(process.cwd(), "src/main/main.ts"), "utf8");
    expect(source).toContain("initializeDesktopRuntime();");
    expect(source).toContain("return app.requestSingleInstanceLock();");
  });

  it("uses the Desktop high-port scan instead of an ephemeral port", () => {
    const source = readFileSync(join(process.cwd(), "src/utility/runtime-gate.mts"), "utf8");
    expect(source).toContain("selectLocalServerPort(MIN_LOCAL_SERVER_PORT, canBindLoopbackPort)");
    expect(source).toContain("port: gatePort");
    expect(source).not.toContain("port: 0");
  });

  it("allows Windows CI to skip only the local bind check", () => {
    const mainSource = readFileSync(join(process.cwd(), "src/main/main.ts"), "utf8");
    const utilitySource = readFileSync(join(process.cwd(), "src/utility/runtime-gate.mts"), "utf8");
    const verifierSource = readFileSync(join(process.cwd(), "scripts/verify-package.mjs"), "utf8");
    expect(mainSource).toContain('SCRIVERSE_DESKTOP_GATE_SKIP_LOCAL_SERVER === "true" ? "true" : "false"');
    expect(utilitySource).toContain('process.env.SCRIVERSE_DESKTOP_GATE_SKIP_LOCAL_SERVER === "true"');
    expect(verifierSource).toContain('process.platform === "win32"');
    expect(verifierSource).toContain("report.localServerSkipped === true");
  });
});
