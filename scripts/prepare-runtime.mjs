import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = join(root, "dist");
const overlayRoot = join(root, "runtime-overlay");
const overlayPublic = join(overlayRoot, "public");
const overlayPatch = join(overlayRoot, "web.patch");
const configuredRuntime = process.env.SCRIVERSE_RUNTIME_DIR?.trim();
const configuredSource = process.env.SCRIVERSE_SOURCE_DIR?.trim();
const source = configuredRuntime
  ? resolve(configuredRuntime)
  : configuredSource
    ? resolve(configuredSource, "dist")
    : target;
const requiredFiles = [
  "server-runtime.js",
  "database.js",
  "request-context.js",
  "public/index.html",
  "public/app.js",
  "public/vendor/vditor/dist/index.min.js"
];

for (const file of requiredFiles) {
  if (!existsSync(join(source, file))) {
    throw new Error(`Compatible Scriverse runtime is missing: ${file}. Set SCRIVERSE_RUNTIME_DIR or SCRIVERSE_SOURCE_DIR.`);
  }
}

if (!existsSync(overlayPatch) || !existsSync(join(overlayPublic, "desktop-workspace.js"))) {
  throw new Error("Scriverse Desktop Web overlay is incomplete");
}

if (!existsSync(target) || realpathSync(source) !== realpathSync(target)) {
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
}

function gitApply(...args) {
  return spawnSync("git", ["apply", "--directory=dist", ...args, overlayPatch], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  });
}

const overlayCheck = gitApply("--check");
if (overlayCheck.status === 0) {
  const applied = gitApply("--whitespace=nowarn");
  if (applied.status !== 0) {
    throw new Error(`Scriverse Desktop Web overlay failed to apply: ${applied.stderr.trim() || "unknown git apply error"}`);
  }
} else if (gitApply("--reverse", "--check").status !== 0) {
  throw new Error(`Compatible Scriverse Web assets do not match the Desktop overlay: ${overlayCheck.stderr.trim() || "git apply check failed"}`);
}

cpSync(overlayPublic, join(target, "public"), { recursive: true, force: true });
for (const file of ["desktop-workspace.js", "desktop-sync-client.js", "desktop-local-ai-offline.js", "desktop-local-ai-catalog.js"]) {
  if (!existsSync(join(target, "public", file))) throw new Error(`Desktop Web overlay output is missing: ${file}`);
}
process.stdout.write(`Scriverse runtime staged from ${source} with Desktop Web overlay\n`);
