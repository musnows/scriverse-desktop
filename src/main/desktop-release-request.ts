import { net } from "electron";

export function fetchDesktopReleaseResponse(url: string, init: RequestInit): Promise<Response> {
  if (init.method !== "HEAD" || init.redirect !== "manual") return net.fetch(url, init);
  if (init.signal?.aborted) return Promise.reject(new Error("Desktop release request was aborted"));
  return new Promise<Response>((resolve, reject) => {
    const request = net.request({ url, method: "HEAD", redirect: "manual", credentials: "omit" });
    let settled = false;
    const cleanup = (): void => { init.signal?.removeEventListener("abort", abort); };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
      request.abort();
    };
    const finish = (response: Response): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(response);
      request.abort();
    };
    const abort = (): void => { fail(new Error("Desktop release request was aborted")); };
    request.once("redirect", (status, _method, location) => {
      try {
        finish(new Response(null, { status, headers: { location } }));
      } catch (error) {
        fail(error);
      }
    });
    request.once("response", (response) => {
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        finish(new Response(null, { status: response.statusCode, headers }));
      } catch (error) {
        fail(error);
      }
    });
    request.on("error", fail);
    init.signal?.addEventListener("abort", abort, { once: true });
    try {
      request.end();
    } catch (error) {
      fail(error);
    }
  });
}
