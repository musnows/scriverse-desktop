import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDirectory = mkdtempSync(join(tmpdir(), "scriverse-desktop-dev-"));
const minimumPort = 20_001;
const maximumPort = 60_000;

function canBindPort(port) {
  return new Promise((resolveResult, reject) => {
    const probe = createServer();
    let settled = false;
    const finish = (available, error = null) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolveResult(available);
    };
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") finish(false);
      else finish(false, error);
    });
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close((error) => error ? finish(false, error) : finish(true));
    });
  });
}

async function findDevelopmentPort() {
  const range = maximumPort - minimumPort + 1;
  const firstPort = minimumPort + (process.pid % range);
  for (let offset = 0; offset < range; offset += 1) {
    const port = minimumPort + ((firstPort - minimumPort + offset) % range);
    if (await canBindPort(port)) return port;
  }
  throw new Error("No isolated Desktop development port is available");
}

const port = await findDevelopmentPort();
const electronBinary = join(root, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
const mainEntry = join(root, "build", "main", "main.js");
const child = spawn(electronBinary, [mainEntry, ...process.argv.slice(2)], {
  cwd: root,
  env: {
    ...process.env,
    SCRIVERSE_DESKTOP_DEV_MODE: "isolated",
    SCRIVERSE_DESKTOP_DATA_DIR: dataDirectory,
    SCRIVERSE_DESKTOP_DEV_PORT: String(port)
  },
  stdio: "inherit"
});

process.stdout.write(`Starting isolated Desktop development instance with data directory ${dataDirectory} and port ${port}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.once("error", (error) => {
  process.stderr.write(`Isolated Desktop development instance failed to start: ${error.message}\n`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
