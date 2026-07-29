import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

import type { BacklinksDatabaseClient } from "../../../src/modules/backlinks/db/client/backlinks-database-config.js";
import {
  backlinksDatabaseConfigSchema,
  createBacklinksDatabaseConnectionConfig,
} from "../../../src/modules/backlinks/db/client/backlinks-database-config.js";

type PoolLike = {
  readonly options: Record<string, unknown>;
  end(): Promise<void>;
};

const require = createRequire(import.meta.url);
const { Pool } = require("pg") as {
  readonly Pool: new (config: unknown) => PoolLike;
};
const { drizzle } = require("drizzle-orm/node-postgres") as {
  readonly drizzle: (pool: PoolLike) => { readonly select: unknown };
};

const requiredConfig = {
  DATABASE_URL_SECRET_REF: "secret://growthos/backlinks/database",
  BACKLINK_DB_STATEMENT_TIMEOUT_MS: "30000",
  BACKLINK_DB_LOCK_TIMEOUT_MS: "5000",
};

describe("backlinks database connection config", () => {
  it("parses the required secret reference and finite timeouts", () => {
    expect(backlinksDatabaseConfigSchema.parse(requiredConfig)).toEqual({
      DATABASE_URL_SECRET_REF: requiredConfig.DATABASE_URL_SECRET_REF,
      BACKLINK_DB_STATEMENT_TIMEOUT_MS: 30_000,
      BACKLINK_DB_LOCK_TIMEOUT_MS: 5_000,
    });
  });

  it.each([
    ["missing secret reference", { ...requiredConfig, DATABASE_URL_SECRET_REF: "" }],
    [
      "zero statement timeout",
      { ...requiredConfig, BACKLINK_DB_STATEMENT_TIMEOUT_MS: "0" },
    ],
    [
      "decimal lock timeout",
      { ...requiredConfig, BACKLINK_DB_LOCK_TIMEOUT_MS: "1.5" },
    ],
    ["unknown privilege flag", { ...requiredConfig, BACKLINK_DB_SUPERUSER: "true" }],
    ["unknown RLS bypass flag", { ...requiredConfig, BACKLINK_DB_BYPASS_RLS: "true" }],
  ])("rejects %s", (_name, config) => {
    expect(backlinksDatabaseConfigSchema.safeParse(config).success).toBe(false);
  });

  it("builds separate least-privilege API and Worker pool contracts", () => {
    const config = backlinksDatabaseConfigSchema.parse(requiredConfig);
    const api = createBacklinksDatabaseConnectionConfig(
      "api",
      config,
      "postgresql://api-user:secret@database/backlinks",
    );
    const worker = createBacklinksDatabaseConnectionConfig(
      "worker",
      config,
      "postgresql://worker-user:secret@database/backlinks",
    );

    expect(api.role).toEqual({
      process: "api",
      privilegeRole: "growthos_backlinks_writer",
      schema: "backlinks",
      superuser: false,
      bypassRls: false,
    });
    expect(worker.role).toEqual({
      process: "worker",
      privilegeRole: "growthos_backlinks_writer",
      schema: "backlinks",
      superuser: false,
      bypassRls: false,
    });
    expect(api.pool).toMatchObject({
      application_name: "growthos-backlinks-api",
      options: "-c search_path=backlinks,pg_catalog",
      statement_timeout: 30_000,
      lock_timeout: 5_000,
    });
    expect(worker.pool).toMatchObject({
      application_name: "growthos-backlinks-worker",
      options: "-c search_path=backlinks,pg_catalog",
      statement_timeout: 30_000,
      lock_timeout: 5_000,
    });
    expect(api.pool).not.toBe(worker.pool);
  });

  it("rejects a non-PostgreSQL resolved secret", () => {
    const config = backlinksDatabaseConfigSchema.parse(requiredConfig);

    expect(() =>
      createBacklinksDatabaseConnectionConfig(
        "api",
        config,
        "mysql://api-user:secret@database/backlinks",
      ),
    ).toThrow("PostgreSQL connection string");
  });

  it("is accepted by the pinned pg pool and Drizzle driver without connecting", async () => {
    const config = backlinksDatabaseConfigSchema.parse(requiredConfig);
    const connection = createBacklinksDatabaseConnectionConfig(
      "api",
      config,
      "postgresql://api-user:secret@database/backlinks",
    );
    const pool = new Pool(connection.pool);
    const database = drizzle(pool);
    const client: BacklinksDatabaseClient<PoolLike, typeof database> = {
      role: connection.role,
      pool,
      drizzle: database,
    };

    expect(client.pool.options).toMatchObject(connection.pool);
    expect(typeof client.drizzle.select).toBe("function");
    await pool.end();
  });
});
