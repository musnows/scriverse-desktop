import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export const packagedElectronLocales = ["zh-CN", "zh-TW", "en-US", "en-GB"] as const;

const keptLocaleKeys = new Set(packagedElectronLocales.map(normalizeLocale));

function normalizeLocale(code: string): string {
  return code.toLowerCase().replaceAll("_", "-");
}

export function shouldRemovePackagedElectronLocale(fileName: string): boolean {
  const match = /^([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)\.(pak|lproj)$/u.exec(fileName);
  if (!match?.[1] || !match[2]) return false;
  const key = normalizeLocale(match[1]);
  if (match[2] === "lproj" && (key === "en" || key === "zh-hans")) return false;
  return !keptLocaleKeys.has(key);
}

export async function prunePackagedElectronLocales(root: string): Promise<number> {
  let removed = 0;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!shouldRemovePackagedElectronLocale(entry.name)) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(join(directory, entry.name));
        return;
      }
      await rm(join(directory, entry.name), { recursive: true, force: true });
      removed += 1;
    }));
  }

  await walk(root);
  if (removed === 0) throw new Error("Desktop packaging did not find Electron locales to prune");
  process.stdout.write(`Pruned ${removed} unused Electron locales\n`);
  return removed;
}
