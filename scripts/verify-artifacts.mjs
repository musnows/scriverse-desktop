import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const makeRoot = join(root, "out", "make");

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

const artifacts = files(makeRoot).filter((path) => statSync(path).size > 0);
const expected = process.platform === "darwin"
  ? [/\.dmg$/u, /\.zip$/u]
  : process.platform === "win32"
    ? [/Setup\.exe$/u, /-full\.nupkg$/u, /(?:[\\/]|-)RELEASES$/u]
    : [/\.deb$/u, /\.rpm$/u, /\.zip$/u];
for (const pattern of expected) {
  if (!artifacts.some((path) => pattern.test(path))) throw new Error(`Missing Desktop artifact: ${pattern}`);
}
process.stdout.write(`${JSON.stringify({ platform: process.platform, artifacts: artifacts.map((path) => path.slice(makeRoot.length + 1)) })}\n`);
