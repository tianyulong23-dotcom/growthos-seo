import { beginCapture, captureConfig } from "./spool.js";

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function archiveDataForSeoFetch(
  fetchImplementation: Fetch,
  component: string,
  environment: NodeJS.ProcessEnv = process.env,
): Fetch {
  return async (input, init) => {
    const config = captureConfig(environment);
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (config === null || url.pathname.startsWith("/v3/appendix/")) {
      return fetchImplementation(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (!url.pathname.startsWith("/v3/") || (method !== "GET" && method !== "POST") ||
        (init?.body != null && typeof init.body !== "string")) {
      throw new Error("ARCHIVE_UNSUPPORTED_REQUEST");
    }
    const requestBody = typeof init?.body === "string" ? init.body :
      input instanceof Request && method === "POST" ? await input.clone().text() : null;
    // A failed preflight prevents dispatch; a post-response capture error must not
    // turn a successful paid request into a retryable provider failure.
    const capture = await beginCapture(config, { component, endpoint: url.pathname, method, requestBody });
    let response: Response;
    try {
      response = await fetchImplementation(input, init);
    } catch (error) {
      try { await capture.finish(Buffer.alloc(0), null); } catch {
        console.error(JSON.stringify({ code: "ARCHIVE_CAPTURE_GAP", eventId: capture.eventId }));
      }
      throw error;
    }
    try {
      await capture.finish(Buffer.from(await response.clone().arrayBuffer()), response.status);
    } catch {
      console.error(JSON.stringify({ code: "ARCHIVE_CAPTURE_GAP", eventId: capture.eventId }));
    }
    return response;
  };
}
