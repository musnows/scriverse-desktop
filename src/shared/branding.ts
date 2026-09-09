export const DESKTOP_DISPLAY_NAME = "叙界";

export function desktopBuildIconName(env: NodeJS.ProcessEnv = process.env): "icon" | "icon-dev" {
  return env.GITHUB_ACTIONS === "true" ? "icon" : "icon-dev";
}
