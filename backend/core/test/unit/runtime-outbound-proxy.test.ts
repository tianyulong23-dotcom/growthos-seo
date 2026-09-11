import { readFile } from "node:fs/promises";
import { createServer } from "node:net";

import { describe, expect, it, vi } from "vitest";

import {
  assertBacklinksOutboundProxyReady,
} from "../../src/runtime-outbound-proxy.js";

describe("Backlinks outbound proxy startup guard", () => {
  it("is enforced by the shared API and Worker entrypoint", async () => {
    const source = await readFile(
      new URL("../../src/index.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "await assertBacklinksOutboundProxyReady(process.env);",
    );
  });

  it("does nothing when environment proxying or external providers are off", async () => {
    const connector = vi.fn();

    await assertBacklinksOutboundProxyReady(
      {
        NODE_USE_ENV_PROXY: "0",
        GMAIL_SEND_ENABLED: "true",
        HTTPS_PROXY: "http://127.0.0.1:7897",
      },
      connector,
    );
    await assertBacklinksOutboundProxyReady(
      {
        NODE_USE_ENV_PROXY: "1",
        GMAIL_SEND_ENABLED: "false",
        HTTPS_PROXY: "http://127.0.0.1:7897",
      },
      connector,
    );

    expect(connector).not.toHaveBeenCalled();
  });

  it("checks each effective proxy endpoint once", async () => {
    const connector = vi.fn().mockResolvedValue(undefined);

    await assertBacklinksOutboundProxyReady(
      {
        NODE_USE_ENV_PROXY: "1",
        GMAIL_SEND_ENABLED: "true",
        http_proxy: "http://127.0.0.1:33210",
        HTTP_PROXY: "http://127.0.0.1:7897",
        HTTPS_PROXY: "http://127.0.0.1:33210",
      },
      connector,
      750,
    );

    expect(connector).toHaveBeenCalledTimes(1);
    expect(connector).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 33210 }),
      750,
    );
  });

  it("accepts a proxy endpoint with a live TCP listener", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("TEST_PROXY_LISTENER_ADDRESS_INVALID");
    }

    try {
      await expect(assertBacklinksOutboundProxyReady({
        NODE_USE_ENV_PROXY: "1",
        GMAIL_SYNC_ENABLED: "true",
        HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
      })).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error === undefined ? resolve() : reject(error));
      });
    }
  });

  it("fails closed before startup when the configured proxy is unreachable", async () => {
    const connector = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(assertBacklinksOutboundProxyReady(
      {
        NODE_USE_ENV_PROXY: "1",
        GOOGLE_OAUTH_ENABLED: "true",
        HTTPS_PROXY: "http://user:secret@127.0.0.1:7897",
      },
      connector,
    )).rejects.toThrow(
      "BACKLINKS_OUTBOUND_PROXY_UNREACHABLE:http://127.0.0.1:7897",
    );
  });

  it("rejects an invalid proxy URL before any connection attempt", async () => {
    const connector = vi.fn();

    await expect(assertBacklinksOutboundProxyReady(
      {
        NODE_USE_ENV_PROXY: "1",
        AI_PROVIDER_ENABLED: "true",
        HTTPS_PROXY: "not-a-proxy-url",
      },
      connector,
    )).rejects.toThrow(
      "BACKLINKS_OUTBOUND_PROXY_URL_INVALID:HTTPS_PROXY",
    );
    expect(connector).not.toHaveBeenCalled();
  });
});
