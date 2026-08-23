export function normalizeLocalWorkspaceOrigin(value: string): string {
  const origin = new URL(value);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("Local workspace origin is invalid");
  }
  return origin.origin;
}

export function isAllowedWorkspaceNavigation(target: string, origin: string): boolean {
  try {
    const url = new URL(target);
    return url.origin === origin && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
