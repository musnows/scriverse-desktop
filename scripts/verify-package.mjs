import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const arch = process.argv[2] ?? process.arch;
const packageName = process.platform === "win32" ? "Scriverse Desktop" : "scriverse-desktop";
const packageDirectory = join(root, "out", `${packageName}-${process.platform}-${arch}`);
const executable = process.platform === "darwin"
  ? join(packageDirectory, "叙界.app", "Contents", "MacOS", "Scriverse Desktop")
  : process.platform === "win32"
    ? join(packageDirectory, "Scriverse Desktop.exe")
    : join(packageDirectory, "scriverse-desktop");
const gateDataDirectory = join(root, ".ai-docs", `packaged-runtime-gate-${process.platform}-${arch}`);
mkdirSync(gateDataDirectory, { recursive: true });

const result = spawnSync(executable, ["--runtime-gate"], {
  cwd: packageDirectory,
  env: { ...process.env, SCRIVERSE_DESKTOP_GATE_DATA_DIR: gateDataDirectory },
  encoding: "utf8",
  timeout: 60_000
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Packaged runtime gate failed: ${result.stderr || result.stdout}`);
const reportLine = result.stdout.split(/\r?\n/u).findLast((line) => line.trim().startsWith("{"));
if (!reportLine) {
  throw new Error(`Packaged runtime gate did not report JSON: ${result.stderr || result.stdout || "no process output"}`);
}
const report = JSON.parse(reportLine);
for (const field of ["ok", "sqlite", "sharp", "vditor", "localServer"]) {
  if (report[field] !== true) throw new Error(`Packaged runtime gate field failed: ${field}`);
}
if (process.platform === "darwin") {
  const appPath = join(packageDirectory, "叙界.app");
  const signature = spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], { encoding: "utf8" });
  if (signature.status !== 0) throw new Error(`Packaged code signature failed: ${signature.stderr}`);
  const plist = readFileSync(join(appPath, "Contents", "Info.plist"));
  if (!plist.includes(Buffer.from("top.scriverse.desktop"))) throw new Error("Packaged bundle id is missing");
  const localizedName = readFileSync(join(appPath, "Contents", "Resources", "zh-Hans.lproj", "InfoPlist.strings"), "utf8");
  if (!localizedName.includes('"CFBundleDisplayName" = "叙界";')) throw new Error("Packaged display name is not localized");
}
process.stdout.write(`${JSON.stringify(report)}\n`);
