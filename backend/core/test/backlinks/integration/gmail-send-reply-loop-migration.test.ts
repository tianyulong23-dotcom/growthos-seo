import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};
type PgError = Error & { readonly code?: string };
const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const id = (value: number) =>
  `01900000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1);
const workspaceA = id(2);
const workspaceB = id(3);
const gmailConnectionId = id(4);
const workspaceBindingA = id(5);
const workspaceBindingB = id(6);
const tokenReferenceId = id(7);
const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};

describe("LOCAL-PRODUCT-019 Gmail send and reply loop migration", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await installBacklinksManifestAfterFoundation(client);

    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(
      `INSERT INTO backlink_secret_references (
         id,organization_id,provider,secret_kind,external_secret_id,
         external_secret_version,created_by,updated_by
       ) VALUES (
         $1,$2,'gcp-secret-manager','GMAIL_TOKEN_SET',
         'projects/test/secrets/gmail-token','1','test','test'
       )`,
      [tokenReferenceId, organizationId],
    );
    await client.query(
      `INSERT INTO backlink_gmail_connections (
         id,organization_id,connected_by_user_id,google_subject,
         primary_email,granted_scopes,token_secret_reference_id,
         token_expires_at,created_by,updated_by
       ) VALUES (
         $1,$2,'user-1','google-subject-1','sender@example.test',
         '["openid","email","profile",
           "https://www.googleapis.com/auth/gmail.send",
           "https://www.googleapis.com/auth/gmail.readonly"]'::jsonb,
         $3,statement_timestamp() + interval '1 hour','test','test'
       )`,
      [gmailConnectionId, organizationId, tokenReferenceId],
    );
    await client.query(
      `INSERT INTO backlink_gmail_workspace_bindings (
         id,organization_id,workspace_id,gmail_connection_id,
         created_by,updated_by
       ) VALUES
         ($1,$2,$3,$4,'test','test'),
         ($5,$2,$6,$4,'test','test')`,
      [
        workspaceBindingA,
        organizationId,
        workspaceA,
        gmailConnectionId,
        workspaceBindingB,
        workspaceB,
      ],
    );
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("adds approval evidence columns and the lifecycle fact foreign key", async () => {
    expect(
      (
        await client.query(
          `SELECT column_name AS "columnName"
         FROM information_schema.columns
        WHERE table_schema='backlinks'
          AND table_name='backlink_send_snapshots'
          AND column_name IN (
            'approval_fact_id','approval_actor_id','approval_recorded_at'
          )
        ORDER BY column_name`,
        )
      ).rows,
    ).toEqual([
      { columnName: "approval_actor_id" },
      { columnName: "approval_fact_id" },
      { columnName: "approval_recorded_at" },
    ]);
    expect(
      (
        await client.query(
          `SELECT conname
         FROM pg_constraint
        WHERE connamespace='backlinks'::regnamespace
          AND conrelid='backlinks.backlink_send_snapshots'::regclass
          AND conname IN (
            'backlink_send_snapshot_approval_values_check',
            'backlink_send_snapshot_approval_fact_fk'
          )
        ORDER BY conname`,
        )
      ).rows,
    ).toEqual([
      { conname: "backlink_send_snapshot_approval_fact_fk" },
      { conname: "backlink_send_snapshot_approval_values_check" },
    ]);
  });

  it("keeps one durable cursor per workspace Gmail connection", async () => {
    await client.query(
      `INSERT INTO backlink_gmail_connection_sync_cursors (
         id,organization_id,workspace_id,gmail_connection_id,
         created_by,updated_by
       ) VALUES
         ($1,$2,$3,$4,'test','test'),
         ($5,$2,$6,$4,'test','test')`,
      [
        id(20),
        organizationId,
        workspaceA,
        gmailConnectionId,
        id(21),
        workspaceB,
      ],
    );
    await expectCode(
      client.query(
        `INSERT INTO backlink_gmail_connection_sync_cursors (
         id,organization_id,workspace_id,gmail_connection_id,
         created_by,updated_by
       ) VALUES ($1,$2,$3,$4,'test','test')`,
        [id(22), organizationId, workspaceA, gmailConnectionId],
      ),
      "23505",
    );
    await expectCode(
      client.query(
        `INSERT INTO backlink_gmail_connection_sync_cursors (
         id,organization_id,workspace_id,gmail_connection_id,
         created_by,updated_by
       ) VALUES ($1,$2,$3,$4,'test','test')`,
        [id(23), organizationId, workspaceA, id(99)],
      ),
      "23503",
    );
  });

  it("isolates connection cursors by organization and workspace RLS", async () => {
    await client.query("SET ROLE growthos_backlinks_writer");
    try {
      await client.query(
        `SELECT set_config('app.current_organization_id',$1,false),
                set_config('app.current_workspace_id',$2,false)`,
        [organizationId, workspaceA],
      );
      expect(
        (
          await client.query(
            `SELECT workspace_id AS "workspaceId"
           FROM backlinks.backlink_gmail_connection_sync_cursors`,
          )
        ).rows,
      ).toEqual([{ workspaceId: workspaceA }]);
    } finally {
      await client.query("RESET ROLE");
    }
  });
});
