import { cpSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const target = join(root, "dist");
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
  "public/desktop-workspace.js",
  "public/vendor/vditor/dist/index.min.js"
];

for (const file of requiredFiles) {
  if (!existsSync(join(source, file))) {
    throw new Error(`Compatible Scriverse runtime is missing: ${file}. Set SCRIVERSE_RUNTIME_DIR or SCRIVERSE_SOURCE_DIR.`);
  }
}

if (existsSync(target) && realpathSync(source) === realpathSync(target)) {
  process.stdout.write("Scriverse runtime already staged\n");
  process.exit(0);
}

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true, force: true });
process.stdout.write(`Scriverse runtime staged from ${source}\n`);
