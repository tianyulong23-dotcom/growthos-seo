import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type QueryResult = { readonly rows: Record<string, unknown>[] };
type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string): Promise<QueryResult>;
};
type PgError = Error & { readonly code?: string };

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};

const migrationUrl = (name: string) =>
  new URL(
    `../../../src/modules/backlinks/db/migrations/${name}`,
    import.meta.url,
  );
const sharedRoleMigrationUrl = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const publishedMigrationHashes = {
  "0001_backlink_foundation.sql":
    "F355E3489103E3A6278D63843FAEBEF91F9E65E6D9DBEBADD678C907231276E2",
  "0002_backlink_provider_seo.sql":
    "279406AE1E6ECA9D8FAAAD53C0AAD9FE13E5327F98C0B005EFDDF0BA2C9795E8",
  "0003_backlink_recommendations.sql":
    "7DA2B77F8034ABF20F2576B3538657E87394C439D8C4BE9DF3E22B36A6199AD3",
  "0004_backlink_contacts_opportunities.sql":
    "CDD2EEBA9A6FFAA68EBEF085666A7DF8225B645AE45CAA5DEDF7413FB218D4D7",
} as const;
const roleNames = [
  "growthos_platform_owner",
  "growthos_platform_writer",
  "growthos_audit_owner",
  "growthos_audit_writer",
  "growthos_keywords_owner",
  "growthos_keywords_writer",
  "growthos_content_owner",
  "growthos_content_writer",
  "growthos_backlinks_owner",
  "growthos_backlinks_writer",
  "growthos_reporting_owner",
  "growthos_reporting_reader",
  "growthos_gateway",
] as const;
const moduleSchemas = [
  "platform",
  "audit",
  "keywords",
  "content",
  "backlinks",
  "reporting",
] as const;

const expectPermissionDenied = async (query: Promise<unknown>) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code: "42501" });
};

describe("BL-AI-ARCH-005 database ownership migration history", () => {
  it("keeps all four published migrations byte-for-byte unchanged", async () => {
    for (const [name, expectedHash] of Object.entries(
      publishedMigrationHashes,
    )) {
      const sql = await readFile(migrationUrl(name));
      expect(createHash("sha256").update(sql).digest("hex").toUpperCase()).toBe(
        expectedHash,
      );
    }
  });
});

describe("BL-AI-ARCH-005 disposable PostgreSQL ownership gate", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    for (const name of [
      "0002_backlink_provider_seo.sql",
      "0003_backlink_recommendations.sql",
      "0004_backlink_contacts_opportunities.sql",
    ]) {
      await client.query(await readFile(migrationUrl(name), "utf8"));
    }
    await client.query(await readFile(sharedRoleMigrationUrl, "utf8"));
    await client.query(
      await readFile(
        migrationUrl("0005_backlink_schema_role_ownership.sql"),
        "utf8",
      ),
    );
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("creates hardened privilege roles and module-owned schemas", async () => {
    const roles = (
      await client.query(`
        SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
          rolcanlogin, rolreplication, rolbypassrls
        FROM pg_roles
        WHERE rolname IN (${roleNames.map((name) => `'${name}'`).join(", ")})
        ORDER BY rolname
      `)
    ).rows;
    expect(roles).toHaveLength(roleNames.length);
    expect(
      roles.every((role) =>
        [
          role.rolsuper,
          role.rolinherit,
          role.rolcreaterole,
          role.rolcreatedb,
          role.rolcanlogin,
          role.rolreplication,
          role.rolbypassrls,
        ].every((value) => value === false),
      ),
    ).toBe(true);

    const schemas = (
      await client.query(`
        SELECT namespace.nspname AS schema_name, owner.rolname AS owner_name
        FROM pg_namespace AS namespace
        JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
        WHERE namespace.nspname IN (
          ${moduleSchemas.map((name) => `'${name}'`).join(", ")}
        )
        ORDER BY namespace.nspname
      `)
    ).rows;
    expect(schemas).toEqual([
      { schema_name: "audit", owner_name: "growthos_audit_owner" },
      { schema_name: "backlinks", owner_name: "growthos_backlinks_owner" },
      { schema_name: "content", owner_name: "growthos_content_owner" },
      { schema_name: "keywords", owner_name: "growthos_keywords_owner" },
      { schema_name: "platform", owner_name: "growthos_platform_owner" },
      { schema_name: "reporting", owner_name: "growthos_reporting_owner" },
    ]);
  });

  it("moves all Backlinks tables and functions without weakening RLS", async () => {
    const tables = (
      await client.query(`
        SELECT table_schema, table_name
        FROM information_schema.tables
        WHERE table_name LIKE 'backlink\\_%' ESCAPE '\\'
        ORDER BY table_name
      `)
    ).rows;
    expect(tables).toHaveLength(21);
    expect(
      tables.every(({ table_schema }) => table_schema === "backlinks"),
    ).toBe(true);

    const ownership = (
      await client.query(`
        SELECT owner.rolname AS owner_name, relation.relrowsecurity,
          relation.relforcerowsecurity
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        JOIN pg_roles AS owner ON owner.oid = relation.relowner
        WHERE namespace.nspname = 'backlinks'
          AND relation.relkind = 'r'
          AND relation.relname LIKE 'backlink\\_%' ESCAPE '\\'
      `)
    ).rows;
    expect(ownership).toHaveLength(21);
    expect(
      ownership.every(
        (table) =>
          table.owner_name === "growthos_backlinks_owner" &&
          table.relrowsecurity === true &&
          table.relforcerowsecurity === true,
      ),
    ).toBe(true);

    const functions = (
      await client.query(`
        SELECT namespace.nspname AS schema_name, owner.rolname AS owner_name,
          routine.proname
        FROM pg_proc AS routine
        JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        JOIN pg_roles AS owner ON owner.oid = routine.proowner
        WHERE routine.proname LIKE 'backlink\\_%' ESCAPE '\\'
        ORDER BY routine.proname
      `)
    ).rows;
    expect(functions).toHaveLength(3);
    expect(
      functions.every(
        (routine) =>
          routine.schema_name === "backlinks" &&
          routine.owner_name === "growthos_backlinks_owner",
      ),
    ).toBe(true);
  });

  it("allows Backlinks writes only in Backlinks and keeps Gateway/reporting constrained", async () => {
    for (const schema of moduleSchemas.filter(
      (name) => name !== "reporting",
    )) {
      await client.query(`
        SET ROLE growthos_${schema}_owner;
        CREATE TABLE ${schema}.arch005_permission_probe (
          id integer PRIMARY KEY
        );
        RESET ROLE;
      `);
    }

    await client.query(`
      SET ROLE growthos_backlinks_writer;
      INSERT INTO backlinks.arch005_permission_probe (id) VALUES (1);
      RESET ROLE;
    `);
    await client.query(`
      SET ROLE growthos_backlinks_writer;
      SET search_path = backlinks, pg_catalog;
      SELECT set_config(
        'app.current_workspace_id',
        '018f0000-0000-7000-8000-000000000002',
        false
      );
      SELECT set_config(
        'app.current_website_project_id',
        '018f0000-0000-7000-8000-000000000003',
        false
      );
    `);
    expect(
      (
        await client.query(`
          INSERT INTO backlink_idempotency_records (
            id, organization_id, workspace_id, website_project_id,
            idempotency_key, command_type, request_hash, expires_at,
            created_by, updated_by
          ) VALUES (
            '018f0000-0000-7000-8000-000000000101',
            '018f0000-0000-7000-8000-000000000001',
            '018f0000-0000-7000-8000-000000000002',
            '018f0000-0000-7000-8000-000000000003',
            'arch005', 'ownership-gate', '${"a".repeat(64)}',
            now() + interval '1 hour', 'test', 'test'
          )
          RETURNING id
        `)
      ).rows,
    ).toEqual([{ id: "018f0000-0000-7000-8000-000000000101" }]);
    await expectPermissionDenied(
      client.query(
        "CREATE TABLE backlinks.arch005_writer_ddl_probe (id integer)",
      ),
    );
    await client.query(`
      RESET ROLE;
      RESET search_path;
      RESET app.current_workspace_id;
      RESET app.current_website_project_id;
    `);
    for (const schema of ["platform", "audit", "keywords", "content"]) {
      await client.query("SET ROLE growthos_backlinks_writer");
      await expectPermissionDenied(
        client.query(
          `INSERT INTO ${schema}.arch005_permission_probe (id) VALUES (1)`,
        ),
      );
      await client.query("RESET ROLE");
    }

    await client.query("SET ROLE growthos_gateway");
    await expectPermissionDenied(
      client.query(
        "INSERT INTO backlinks.arch005_permission_probe (id) VALUES (2)",
      ),
    );
    await client.query("RESET ROLE");

    await client.query("SET ROLE growthos_reporting_reader");
    expect(
      (
        await client.query(
          "SELECT id FROM backlinks.arch005_permission_probe ORDER BY id",
        )
      ).rows,
    ).toEqual([{ id: 1 }]);
    await expectPermissionDenied(
      client.query(
        "INSERT INTO backlinks.arch005_permission_probe (id) VALUES (2)",
      ),
    );
    await client.query("RESET ROLE");
  });
});
