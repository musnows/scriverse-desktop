export function isAllowedRemoteWorkspaceNavigation(target: string, workspaceUrl: string): boolean {
  let targetUrl: URL;
  let allowedUrl: URL;
  try {
    targetUrl = new URL(target);
    allowedUrl = new URL(workspaceUrl);
  } catch {
    return false;
  }
  return (targetUrl.protocol === "app:" || targetUrl.protocol === "https:" || targetUrl.protocol === "http:")
    && targetUrl.username === ""
    && targetUrl.password === ""
    && targetUrl.protocol === allowedUrl.protocol
    && targetUrl.hostname === allowedUrl.hostname
    && targetUrl.port === allowedUrl.port;
}
