import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./postgresql-container.js";

type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string): Promise<{
    rows: Record<string, unknown>[];
    rowCount: number | null;
  }>;
};

const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
};

describe("BL-AI-035 PostgreSQL Testcontainers harness", () => {
  let harness: BacklinksPostgresHarness | undefined;

  afterEach(async () => {
    await harness?.stop();
    harness = undefined;
  });

  it("starts, migrates, and destroys isolated PostgreSQL", async () => {
    const previousDatabaseUrl = process.env.BACKLINKS_TEST_DATABASE_URL;
    const externalAdminUrl =
      process.env.BACKLINKS_TEST_POSTGRES_ADMIN_URL?.trim();
    process.env.BACKLINKS_TEST_DATABASE_URL =
      "postgresql://must-not-connect@127.0.0.1:5432/production";

    try {
      harness = await startBacklinksPostgresHarness();
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.BACKLINKS_TEST_DATABASE_URL;
      } else {
        process.env.BACKLINKS_TEST_DATABASE_URL = previousDatabaseUrl;
      }
    }

    const url = new URL(harness.connectionString);
    if (externalAdminUrl) {
      expect(url.port).toBe(new URL(externalAdminUrl).port);
      expect(harness.image).toBe("external-postgresql");
    } else {
      expect(url.port).not.toBe("5432");
      expect(harness.image).toMatch(
        /^postgres:18-bookworm@sha256:[a-f0-9]{64}$/,
      );
    }

    await harness.migrate();
    const client = new Client({
      connectionString: harness.connectionString,
      connectionTimeoutMillis: 2_000,
    });
    await client.connect();
    const version = await client.query("SHOW server_version");
    const tables = await client.query(`
      SELECT table_name
        FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name LIKE 'backlink_%'
       ORDER BY table_name
    `);
    await client.end();

    expect(version.rows[0]?.server_version).toMatch(/^18\./);
    expect(tables.rows).toHaveLength(6);

    const stoppedConnectionString = harness.connectionString;
    await harness.stop();
    harness = undefined;
    const stoppedClient = new Client({
      connectionString: stoppedConnectionString,
      connectionTimeoutMillis: 1_000,
    });
    await expect(stoppedClient.connect()).rejects.toBeInstanceOf(Error);
    await stoppedClient.end().catch(() => undefined);
  }, 120_000);
});
