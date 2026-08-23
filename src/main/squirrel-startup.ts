import { app } from "electron";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { parseSquirrelCommand } from "../shared/squirrel-command.js";

export function handleSquirrelStartup(): boolean {
  const command = parseSquirrelCommand();
  if (!command) return false;
  if (command === "obsolete") {
    app.quit();
    return true;
  }
  const updateExecutable = resolve(dirname(process.execPath), "..", "Update.exe");
  const shortcutArgument = command === "uninstall" ? "--removeShortcut" : "--createShortcut";
  try {
    const child = spawn(updateExecutable, [`${shortcutArgument}=${basename(process.execPath)}`], {
      detached: true,
      stdio: "ignore"
    });
    child.once("close", () => app.quit());
    child.once("error", () => app.quit());
    child.unref();
  } catch {
    app.quit();
  }
  return true;
}
