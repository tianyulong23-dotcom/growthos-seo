import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";

import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";

const POSTGRES_IMAGE =
  "postgres:18-bookworm@sha256:1961f96e6029a02c3812d7cb329a3b03a3ac2bb067058dec17b0f5596aca9296";
const POSTGRES_PORT = 5432;
const DATABASE_NAME = "backlinks_test";
const DATABASE_USER = "backlinks_test";
const MIGRATION_URL = new URL(
  "../../../../src/modules/backlinks/db/migrations/0001_backlink_foundation.sql",
  import.meta.url,
);

type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string): Promise<unknown>;
};

const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
};

export type BacklinksPostgresHarness = {
  readonly image: string;
  readonly connectionString: string;
  migrate(): Promise<void>;
  stop(): Promise<void>;
};

export async function startBacklinksPostgresHarness(): Promise<BacklinksPostgresHarness> {
  const password = randomBytes(24).toString("base64url");
  let container: StartedTestContainer | undefined;

  try {
    container = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_DB: DATABASE_NAME,
        POSTGRES_PASSWORD: password,
        POSTGRES_USER: DATABASE_USER,
      })
      .withExposedPorts(POSTGRES_PORT)
      .withWaitStrategy(
        Wait.forLogMessage(
          /database system is ready to accept connections/,
          2,
        ),
      )
      .withStartupTimeout(90_000)
      .start();

    const connectionUrl = new URL("postgresql://localhost");
    connectionUrl.hostname = container.getHost();
    connectionUrl.port = String(container.getMappedPort(POSTGRES_PORT));
    connectionUrl.username = DATABASE_USER;
    connectionUrl.password = password;
    connectionUrl.pathname = DATABASE_NAME;

    let stopped = false;
    return {
      image: POSTGRES_IMAGE,
      connectionString: connectionUrl.toString(),
      async migrate() {
        const migration = await readFile(MIGRATION_URL, "utf8");
        const client = new Client({
          connectionString: connectionUrl.toString(),
          connectionTimeoutMillis: 5_000,
        });
        await client.connect();
        try {
          await client.query(migration);
        } finally {
          await client.end();
        }
      },
      async stop() {
        if (stopped) {
          return;
        }
        stopped = true;
        await container.stop();
      },
    };
  } catch (error) {
    await container?.stop().catch(() => undefined);
    throw error;
  }
}
