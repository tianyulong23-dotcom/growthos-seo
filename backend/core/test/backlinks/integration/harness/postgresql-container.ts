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
const EXTERNAL_ADMIN_URL_ENV = "BACKLINKS_TEST_POSTGRES_ADMIN_URL";
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

async function migrateDatabase(connectionString: string): Promise<void> {
  const migration = await readFile(MIGRATION_URL, "utf8");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    await client.query(migration);
  } finally {
    await client.end();
  }
}

async function startExternalPostgresHarness(
  adminConnectionString: string,
): Promise<BacklinksPostgresHarness> {
  const databaseName = `backlinks_test_${randomBytes(8).toString("hex")}`;
  const admin = new Client({
    connectionString: adminConnectionString,
    connectionTimeoutMillis: 5_000,
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }

  const connectionUrl = new URL(adminConnectionString);
  connectionUrl.pathname = `/${databaseName}`;
  let stopped = false;

  return {
    image: "external-postgresql",
    connectionString: connectionUrl.toString(),
    async migrate() {
      await migrateDatabase(connectionUrl.toString());
    },
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      const cleanup = new Client({
        connectionString: adminConnectionString,
        connectionTimeoutMillis: 5_000,
      });
      await cleanup.connect();
      try {
        await cleanup.query(
          `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
        );
      } finally {
        await cleanup.end();
      }
    },
  };
}

export async function startBacklinksPostgresHarness(): Promise<BacklinksPostgresHarness> {
  const externalAdminUrl = process.env[EXTERNAL_ADMIN_URL_ENV]?.trim();
  if (externalAdminUrl) {
    return startExternalPostgresHarness(externalAdminUrl);
  }

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
        Wait.forLogMessage(/database system is ready to accept connections/, 2),
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
        await migrateDatabase(connectionUrl.toString());
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
