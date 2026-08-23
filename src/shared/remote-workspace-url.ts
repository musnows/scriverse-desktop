import { normalizeProfileOrigin } from "./profile-url.js";

export function isAllowedRemoteWorkspaceNavigation(target: string, origin: string): boolean {
  let targetUrl: URL;
  try {
    targetUrl = new URL(target);
  } catch {
    return false;
  }
  return (targetUrl.protocol === "https:" || targetUrl.protocol === "http:")
    && targetUrl.username === ""
    && targetUrl.password === ""
    && targetUrl.origin === normalizeProfileOrigin(origin);
}
