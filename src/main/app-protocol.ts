import { protocol } from "electron";
import { readFile } from "node:fs/promises";
import { SELECTOR_CSP, resolveSelectorAsset } from "../shared/selector-assets.js";

export function registerDesktopScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }]);
}

export function registerSelectorProtocol(rendererRoot: string): void {
  protocol.handle("app", async (request) => {
    const asset = resolveSelectorAsset(request.url, rendererRoot);
    if (!asset) {
      process.stderr.write("Selector protocol denied a non-whitelisted resource\n");
      return new Response("Not found", {
        status: 404,
        headers: {
          "Content-Security-Policy": SELECTOR_CSP,
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }
    try {
      return new Response(await readFile(asset.path), {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Security-Policy": SELECTOR_CSP,
          "Content-Type": asset.contentType,
          "X-Content-Type-Options": "nosniff"
        }
      });
    } catch (error) {
      process.stderr.write(`Selector asset read failed: ${error instanceof Error ? error.message : String(error)}\n`);
      return new Response("Not found", {
        status: 404,
        headers: {
          "Content-Security-Policy": SELECTOR_CSP,
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }
  });
}
