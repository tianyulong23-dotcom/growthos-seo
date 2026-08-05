import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  renderPublicPage,
  type BrowserRenderRequest,
  workerCapabilities,
} from "./worker.js";

const host = process.env.BROWSER_WORKER_HOST ?? "127.0.0.1";
const port = Number(process.env.BROWSER_WORKER_PORT ?? "7401");
const timeoutMs = Number(process.env.BROWSER_WORKER_TIMEOUT_MS ?? "20000");
const maxHtmlBytes = Number(
  process.env.BROWSER_WORKER_MAX_HTML_BYTES ?? "2000000",
);

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.length;
    if (size > 256_000) throw new Error("BROWSER_REQUEST_TOO_LARGE");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseRequest(value: unknown): BrowserRenderRequest {
  const input = value as Partial<BrowserRenderRequest> | null;
  if (
    input === null
    || input.version !== "crawler.evidence.request.v1"
    || !["contact_enrichment", "backlink_validation"].includes(
      input.taskType ?? "",
    )
    || typeof input.requestId !== "string"
    || input.requestedBy?.moduleId !== "backlinks"
    || typeof input.requestedBy.actorId !== "string"
    || typeof input.tenant?.organizationId !== "string"
    || typeof input.tenant.workspaceId !== "string"
    || typeof input.project?.websiteProjectId !== "string"
    || !Array.isArray(input.target?.urls)
    || input.target.urls.length !== 1
    || typeof input.target.urls[0] !== "string"
  ) {
    throw new Error("BROWSER_REQUEST_INVALID");
  }
  return input as BrowserRenderRequest;
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, {
      status: "ok",
      capabilities: workerCapabilities,
      browser: "playwright-with-system-chrome-fallback",
    });
    return;
  }
  if (request.method !== "POST" || request.url !== "/render") {
    json(response, 404, { code: "NOT_FOUND" });
    return;
  }
  try {
    const input = parseRequest(await readJson(request));
    const result = await renderPublicPage(input, { timeoutMs, maxHtmlBytes });
    json(response, 200, result);
  } catch (error) {
    json(response, 422, {
      code: error instanceof Error ? error.message : "BROWSER_RENDER_FAILED",
    });
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({
    event: "browser.worker.ready",
    address: `http://${host}:${port}`,
  }));
});
