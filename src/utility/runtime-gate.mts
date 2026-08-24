import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MIN_LOCAL_SERVER_PORT, selectLocalServerPort } from "../shared/desktop-settings-contract.js";

type RunningServer = {
  url: string;
  close: () => Promise<void>;
};

type StartLocalServer = (options: {
  host: string;
  port: number;
  dataDirectory: string;
  databasePath: string;
  env: NodeJS.ProcessEnv;
}) => Promise<RunningServer>;

type RuntimeGateResult = {
  ok: boolean;
  electronVersion: string;
  nodeVersion: string;
  sqlite: boolean;
  sharp: boolean;
  vditor: boolean;
  localServer: boolean;
  error?: string;
};

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

async function inspectRuntime(): Promise<RuntimeGateResult> {
  process.stdout.write("Desktop runtime gate started\n");
  const result: RuntimeGateResult = {
    ok: false,
    electronVersion: process.versions.electron ?? "unknown",
    nodeVersion: process.versions.node,
    sqlite: false,
    sharp: false,
    vditor: false,
    localServer: false
  };
  let running: RunningServer | null = null;
  try {
    const appRoot = process.env.SCRIVERSE_DESKTOP_APP_ROOT;
    const dataDirectory = process.env.SCRIVERSE_DESKTOP_GATE_DATA_DIR;
    if (!appRoot || !dataDirectory) throw new Error("Desktop runtime gate paths are unavailable");

    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("CREATE TABLE runtime_gate (value INTEGER NOT NULL); INSERT INTO runtime_gate VALUES (1)");
    result.sqlite = Number(sqlite.prepare("SELECT value FROM runtime_gate").get()?.value) === 1;
    sqlite.close();
    process.stdout.write("Desktop runtime gate verified node:sqlite\n");

    const { default: sharp } = await import(pathToFileURL(join(appRoot, "node_modules", "sharp", "dist", "index.mjs")).href) as {
      default: typeof import("sharp").default;
    };
    const image = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 24, g: 34, b: 48, alpha: 1 } }
    }).png().toBuffer();
    result.sharp = image.byteLength > 0;
    process.stdout.write("Desktop runtime gate verified sharp\n");

    result.vditor = existsSync(join(appRoot, "dist", "public", "vendor", "vditor", "dist", "index.min.js"));
    process.stdout.write("Desktop runtime gate verified Vditor assets\n");

    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    process.stdout.write("Desktop runtime gate loading local server\n");
    const runtimeModule = await import(pathToFileURL(join(appRoot, "dist", "server-runtime.js")).href) as {
      startLocalServer: StartLocalServer;
    };
    const gatePort = await selectLocalServerPort(MIN_LOCAL_SERVER_PORT, canBindLoopbackPort);
    running = await runtimeModule.startLocalServer({
      host: "127.0.0.1",
      port: gatePort,
      dataDirectory,
      databasePath: join(dataDirectory, "novel.db"),
      env: { NODE_ENV: "production" }
    });
    process.stdout.write("Desktop runtime gate started local server\n");
    const health = await fetch(`${running.url}/api/health`).then((response) => response.json()) as {
      data?: { status?: unknown };
    };
    result.localServer = health.data?.status === "ok";
    result.ok = result.sqlite && result.sharp && result.vditor && result.localServer;
    return result;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    await running?.close();
  }
}

inspectRuntime().then((result) => {
  process.parentPort.postMessage(result);
}).catch((error: unknown) => {
  process.parentPort.postMessage({
    ok: false,
    electronVersion: process.versions.electron ?? "unknown",
    nodeVersion: process.versions.node,
    sqlite: false,
    sharp: false,
    vditor: false,
    localServer: false,
    error: error instanceof Error ? error.message : String(error)
  } satisfies RuntimeGateResult);
});
