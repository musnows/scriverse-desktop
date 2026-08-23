export type SquirrelCommand = "install" | "updated" | "uninstall" | "obsolete";

export function parseSquirrelCommand(
  argv: readonly string[] = process.argv,
  platform: NodeJS.Platform = process.platform
): SquirrelCommand | null {
  if (platform !== "win32") return null;
  const value = argv[1];
  if (value === "--squirrel-install") return "install";
  if (value === "--squirrel-updated") return "updated";
  if (value === "--squirrel-uninstall") return "uninstall";
  if (value === "--squirrel-obsolete") return "obsolete";
  return null;
}
