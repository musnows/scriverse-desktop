import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Desktop runtime gate isolation", () => {
  it("runs independently from an already open Desktop instance", () => {
    const source = readFileSync(join(process.cwd(), "src/main/main.ts"), "utf8");
    expect(source).toContain("!runtimeGateRequested && !localServerGateRequested && !app.requestSingleInstanceLock()");
  });

  it("uses the Desktop high-port scan instead of an ephemeral port", () => {
    const source = readFileSync(join(process.cwd(), "src/utility/runtime-gate.mts"), "utf8");
    expect(source).toContain("selectLocalServerPort(MIN_LOCAL_SERVER_PORT, canBindLoopbackPort)");
    expect(source).toContain("port: gatePort");
    expect(source).not.toContain("port: 0");
  });
});
