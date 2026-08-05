import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
const migration = (name: string) =>
  new URL(
    `../../../src/modules/backlinks/db/migrations/${name}`,
    import.meta.url,
  );
const roles = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organization = id(1);
const sendScopes =
  `'["openid","email","profile",` +
  `"https://www.googleapis.com/auth/gmail.send"]'::jsonb`;
const readSyncScopes =
  `'["openid","email","profile",` +
  `"https://www.googleapis.com/auth/gmail.send",` +
  `"https://www.googleapis.com/auth/gmail.readonly"]'::jsonb`;

const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};

describe("BL-AI-124 Gmail mail sync capability migration", () => {
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
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query(await readFile(roles, "utf8"));
    for (const name of [
      "0005_backlink_schema_role_ownership.sql",
      "0006_backlink_opportunities.sql",
      "0007_backlink_opportunity_counter.sql",
      "0010_backlink_assessments.sql",
      "0011_backlink_contact_purpose_correction.sql",
      "0012_backlink_gmail_connections.sql",
      "0013_backlink_drafts.sql",
      "0014_backlink_send_intents.sql",
      "0015_backlink_gmail_sync_capabilities.sql",
    ]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query("SET search_path = backlinks, pg_catalog");
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("derives the capability marker exactly from the readonly scope while retaining legacy send-only connections", async () => {
    const insert = (
      connectionId: string,
      secretId: string,
      scopes: string,
      subject: string,
    ) => client.query(`
      WITH secret_reference AS (
        INSERT INTO backlink_secret_references (
          id, organization_id, provider, secret_kind, external_secret_id,
          external_secret_version, created_by, updated_by
        ) VALUES (
          '${secretId}', '${organization}', 'gcp-secret-manager',
          'GMAIL_TOKEN_SET', 'projects/test/secrets/${subject}', '1',
          'test', 'test'
        )
      )
      INSERT INTO backlink_gmail_connections (
        id, organization_id, connected_by_user_id, google_subject,
        primary_email, granted_scopes, token_secret_reference_id,
        token_secret_kind, token_expires_at, created_by, updated_by
      ) VALUES (
        '${connectionId}', '${organization}', 'test', '${subject}',
        '${subject}@example.test', ${scopes}, '${secretId}',
        'GMAIL_TOKEN_SET', '2026-07-28T06:00:00.000Z', 'test', 'test'
      );
    `);

    await insert(id(101), id(201), sendScopes, "legacy-send");
    await insert(id(102), id(202), readSyncScopes, "read-sync");

    const result = await client.query(`
      SELECT google_subject AS "googleSubject",
        mail_sync_capability AS "mailSyncCapability"
      FROM backlink_gmail_connections
      ORDER BY google_subject;
    `);

    expect(result.rows).toEqual([
      { googleSubject: "legacy-send", mailSyncCapability: false },
      { googleSubject: "read-sync", mailSyncCapability: true },
    ]);

    await client.query(`
      UPDATE backlink_gmail_connections
      SET granted_scopes = ${readSyncScopes}
      WHERE id = '${id(101)}';
    `);
    await expect(
      client.query(`
        SELECT mail_sync_capability AS "mailSyncCapability"
        FROM backlink_gmail_connections
        WHERE id = '${id(101)}';
      `),
    ).resolves.toMatchObject({
      rows: [{ mailSyncCapability: true }],
    });
  });

  it("permits only the minimal readonly scope addition for OAuth attempts and Gmail connections", async () => {
    await client.query(`
      INSERT INTO backlink_secret_references (
        id, organization_id, provider, secret_kind, external_secret_id,
        external_secret_version, created_by, updated_by
      ) VALUES (
        '${id(302)}', '${organization}', 'gcp-secret-manager',
        'GMAIL_TOKEN_SET', 'projects/test/secrets/oauth-attempt', '1',
        'test', 'test'
      );
    `);

    await expectCode(
      client.query(`
        INSERT INTO backlink_oauth_attempts (
          id, organization_id, workspace_id, website_project_id,
          initiated_by_user_id, state_hash, session_binding_hash,
          pkce_verifier_secret_reference_id, requested_scopes, redirect_uri,
          expires_at, created_by, updated_by
        ) VALUES (
          '${id(301)}', '${organization}', '${id(3)}', '${id(4)}',
          'test', '${"a".repeat(64)}', '${"b".repeat(64)}',
          '${id(302)}',
          '["openid","email","profile",` +
            `"https://www.googleapis.com/auth/gmail.send",` +
            `"https://www.googleapis.com/auth/gmail.modify"]'::jsonb,
          'https://app.example.test/oauth/google/callback',
          now() + interval '5 minutes', 'test', 'test'
        );
      `),
      "23514",
    );
  });
});
