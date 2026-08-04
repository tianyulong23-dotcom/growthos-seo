import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backlinkGmailConnectionRevocations,
  backlinkGmailConnections,
  backlinkGmailSendIdentities,
  backlinkGmailWorkspaceBindings,
  backlinkOauthAttempts,
  backlinkSecretReferences,
} from "../../../src/modules/backlinks/db/schema/gmail-connections.js";
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
const otherOrganization = id(2);
const workspace = id(3);
const project = id(4);
const scopes =
  `'["openid","email","profile",` +
  `"https://www.googleapis.com/auth/gmail.send"]'::jsonb`;
const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};

describe("BL-AI-099 Gmail connection and OAuth persistence", () => {
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
      "0015_backlink_gmail_sync_capabilities.sql",
    ]) {
      await client.query(await readFile(migration(name), "utf8"));
    }
    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(`
      INSERT INTO backlink_secret_references (
        id, organization_id, provider, secret_kind, external_secret_id,
        external_secret_version, created_by, updated_by
      ) VALUES
        (
          '${id(101)}', '${organization}', 'gcp-secret-manager',
          'OAUTH_PKCE_VERIFIER', 'projects/test/secrets/pkce-1', '1',
          'test', 'test'
        ),
        (
          '${id(102)}', '${organization}', 'gcp-secret-manager',
          'OAUTH_PKCE_VERIFIER', 'projects/test/secrets/pkce-2', '1',
          'test', 'test'
        ),
        (
          '${id(103)}', '${organization}', 'gcp-secret-manager',
          'GMAIL_TOKEN_SET', 'projects/test/secrets/gmail-token-1', '1',
          'test', 'test'
        );
    `);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("declares the integrated Gmail authorization persistence schemas", () => {
    const configs = [
      backlinkSecretReferences,
      backlinkOauthAttempts,
      backlinkGmailConnections,
      backlinkGmailWorkspaceBindings,
      backlinkGmailSendIdentities,
      backlinkGmailConnectionRevocations,
    ].map(getTableConfig);
    expect(configs.map(({ name }) => name)).toEqual([
      "backlink_secret_references",
      "backlink_oauth_attempts",
      "backlink_gmail_connections",
      "backlink_gmail_workspace_bindings",
      "backlink_gmail_send_identities",
      "backlink_gmail_connection_revocations",
    ]);
    expect(
      configs.flatMap(({ foreignKeys }) =>
        foreignKeys.map((key) => key.getName()),
      ),
    ).toEqual([
      "backlink_oauth_attempt_pkce_secret_fk",
      "backlink_gmail_connection_token_secret_fk",
      "backlink_gmail_workspace_binding_connection_fk",
      "backlink_gmail_send_identity_connection_fk",
      "backlink_gmail_revocation_connection_fk",
      "backlink_gmail_revocation_token_secret_fk",
    ]);
  });

  it("allows parallel attempts but enforces hashed state, scopes, TTL, and one-time use", async () => {
    const attempt = (
      attemptId: string,
      secretReferenceId: string,
      stateHash: string,
      sessionHash: string,
    ) => `
      INSERT INTO backlink_oauth_attempts (
        id, organization_id, workspace_id, website_project_id,
        initiated_by_user_id, state_hash, session_binding_hash,
        pkce_verifier_secret_reference_id, requested_scopes, redirect_uri,
        return_path, expires_at, created_by, updated_by
      ) VALUES (
        '${attemptId}', '${organization}', '${workspace}', '${project}',
        'user-1', '${stateHash}', '${sessionHash}', '${secretReferenceId}',
        ${scopes}, 'https://app.example.test/oauth/google/callback',
        '/backlinks/settings', statement_timestamp() + interval '10 minutes',
        'user-1', 'user-1'
      )
    `;
    await client.query(
      attempt(id(201), id(101), "a".repeat(64), "c".repeat(64)),
    );
    await client.query(
      attempt(id(202), id(102), "b".repeat(64), "c".repeat(64)),
    );
    expect(
      (
        await client.query(`
          SELECT count(*)::integer AS count
          FROM backlink_oauth_attempts
          WHERE organization_id = '${organization}'
        `)
      ).rows,
    ).toEqual([{ count: 2 }]);

    await expectCode(
      client.query(attempt(id(203), id(101), "a".repeat(64), "d".repeat(64))),
      "23505",
    );
    await expectCode(
      client.query(`
        ${attempt(id(204), id(101), "e".repeat(64), "f".repeat(64))
          .replace(scopes, `'["openid","email","profile","https://www.googleapis.com/auth/gmail.modify"]'::jsonb`)}
      `),
      "23514",
    );
    await expectCode(
      client.query(
        attempt(id(205), id(101), "1".repeat(64), "2".repeat(64)).replace(
          "interval '10 minutes'",
          "interval '11 minutes'",
        ),
      ),
      "23514",
    );
    await expectCode(
      client.query(attempt(id(206), id(103), "3".repeat(64), "4".repeat(64))),
      "23503",
    );

    await client.query(`
      UPDATE backlink_oauth_attempts
      SET consumed_at = statement_timestamp(), version = 2,
        updated_at = statement_timestamp(), updated_by = 'user-1'
      WHERE id = '${id(201)}'
    `);
    await expectCode(
      client.query(`
        UPDATE backlink_oauth_attempts
        SET consumed_at = NULL, version = 3,
          updated_at = statement_timestamp(), updated_by = 'user-1'
        WHERE id = '${id(201)}'
      `),
      "55000",
    );
  });

  it("keeps Gmail connections organization-scoped and deduplicates active subjects", async () => {
    const connection = (
      connectionId: string,
      organizationId: string,
      secretReferenceId = id(103),
      googleSubject = "google-subject-1",
    ) => `
      INSERT INTO backlink_gmail_connections (
        id, organization_id, connected_by_user_id, google_subject,
        primary_email, granted_scopes, token_secret_reference_id,
        token_expires_at, created_by, updated_by
      ) VALUES (
        '${connectionId}', '${organizationId}', 'user-1', '${googleSubject}',
        'sender@example.test', ${scopes}, '${secretReferenceId}',
        statement_timestamp() + interval '1 hour', 'user-1', 'user-1'
      )
    `;
    await client.query(connection(id(301), organization));
    await client.query(`
      INSERT INTO backlink_gmail_workspace_bindings (
        id, organization_id, workspace_id, gmail_connection_id,
        created_by, updated_by
      ) VALUES (
        '${id(401)}', '${organization}', '${workspace}', '${id(301)}',
        'user-1', 'user-1'
      );
      INSERT INTO backlink_gmail_send_identities (
        id, organization_id, gmail_connection_id, normalized_email,
        is_primary, is_default, verification_status, treat_as_alias,
        source, observed_at, created_by, updated_by
      ) VALUES (
        '${id(501)}', '${organization}', '${id(301)}',
        'sender@example.test', true, true, 'accepted', false,
        'OIDC_PRIMARY', statement_timestamp(), 'user-1', 'user-1'
      );
    `);
    await expectCode(client.query(connection(id(302), organization)), "23505");
    await expectCode(
      client.query(connection(id(303), otherOrganization)),
      "23503",
    );
    await expectCode(
      client.query(
        connection(id(304), organization, id(101), "google-subject-2"),
      ),
      "23503",
    );

    await client.query(`
      UPDATE backlink_gmail_connections
      SET token_secret_reference_id = NULL, token_secret_kind = NULL,
        connection_status = 'DISCONNECTED', send_availability = 'PAUSED',
        disconnected_at = statement_timestamp(), version = 2,
        updated_at = statement_timestamp(), updated_by = 'user-1'
      WHERE id = '${id(301)}'
    `);
    await client.query(`
      UPDATE backlink_gmail_workspace_bindings
      SET binding_status = 'INACTIVE', version = 2,
        updated_at = statement_timestamp(), updated_by = 'user-1'
      WHERE id = '${id(401)}'
    `);
    await client.query(connection(id(302), organization));
    await client.query(`
      INSERT INTO backlink_gmail_workspace_bindings (
        id, organization_id, workspace_id, gmail_connection_id,
        created_by, updated_by
      ) VALUES (
        '${id(402)}', '${organization}', '${workspace}', '${id(302)}',
        'user-1', 'user-1'
      );
      INSERT INTO backlink_gmail_send_identities (
        id, organization_id, gmail_connection_id, normalized_email,
        is_primary, is_default, verification_status, treat_as_alias,
        source, observed_at, created_by, updated_by
      ) VALUES (
        '${id(502)}', '${organization}', '${id(302)}',
        'sender@example.test', true, true, 'accepted', false,
        'OIDC_PRIMARY', statement_timestamp(), 'user-1', 'user-1'
      )
    `);
  });

  it("stores only opaque references and enforces owner, forced RLS, and tenant visibility", async () => {
    const forbiddenColumns = (
      await client.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'backlinks'
          AND table_name IN (
            'backlink_secret_references',
            'backlink_oauth_attempts',
            'backlink_gmail_connections',
            'backlink_gmail_workspace_bindings',
            'backlink_gmail_send_identities',
            'backlink_gmail_connection_revocations'
          )
          AND column_name IN (
            'access_token', 'refresh_token', 'authorization_code',
            'pkce_verifier', 'token_ciphertext', 'secret_value'
          )
      `)
    ).rows;
    expect(forbiddenColumns).toEqual([]);

    const security = (
      await client.query(`
        SELECT c.relname,
          c.relrowsecurity AND c.relforcerowsecurity AS secure,
          pg_get_userbyid(c.relowner) AS owner,
          has_table_privilege(
            'growthos_backlinks_writer', c.oid, 'SELECT,INSERT,UPDATE,DELETE'
          ) AS writer_rw,
          has_table_privilege(
            'growthos_reporting_reader', c.oid, 'SELECT'
          ) AS reporting_read
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'backlinks'
          AND c.relname IN (
            'backlink_secret_references',
            'backlink_oauth_attempts',
            'backlink_gmail_connections',
            'backlink_gmail_workspace_bindings',
            'backlink_gmail_send_identities',
            'backlink_gmail_connection_revocations'
          )
        ORDER BY c.relname
      `)
    ).rows;
    expect(security).toEqual([
      {
        relname: "backlink_gmail_connection_revocations",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_rw: true,
        reporting_read: true,
      },
      {
        relname: "backlink_gmail_connections",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_rw: true,
        reporting_read: true,
      },
      {
        relname: "backlink_gmail_send_identities",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_rw: true,
        reporting_read: true,
      },
      {
        relname: "backlink_gmail_workspace_bindings",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_rw: true,
        reporting_read: true,
      },
      {
        relname: "backlink_oauth_attempts",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_rw: true,
        reporting_read: true,
      },
      {
        relname: "backlink_secret_references",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_rw: true,
        reporting_read: true,
      },
    ]);

    await client.query("SET ROLE growthos_backlinks_writer");
    try {
      await client.query(
        `SET app.current_organization_id = '${organization}'`,
      );
      await client.query(`SET app.current_workspace_id = '${workspace}'`);
      await client.query(`SET app.current_website_project_id = '${project}'`);
      expect(
        (
          await client.query(`
            SELECT
              (SELECT count(*)::integer FROM backlink_oauth_attempts)
                AS attempts,
              (SELECT count(*)::integer FROM backlink_gmail_connections)
                AS connections,
              (SELECT count(*)::integer FROM backlink_gmail_workspace_bindings)
                AS bindings,
              (SELECT count(*)::integer FROM backlink_gmail_send_identities)
                AS identities
          `)
        ).rows,
      ).toEqual([{ attempts: 2, connections: 2, bindings: 2, identities: 2 }]);

      await client.query(`SET app.current_workspace_id = '${id(999)}'`);
      expect(
        (
          await client.query(`
            SELECT
              (SELECT count(*)::integer FROM backlink_oauth_attempts)
                AS attempts,
              (SELECT count(*)::integer FROM backlink_gmail_connections)
                AS connections,
              (SELECT count(*)::integer FROM backlink_gmail_workspace_bindings)
                AS bindings,
              (SELECT count(*)::integer FROM backlink_gmail_send_identities)
                AS identities
          `)
        ).rows,
      ).toEqual([{ attempts: 0, connections: 2, bindings: 0, identities: 2 }]);
    } finally {
      await client.query("RESET ROLE");
    }
  });
});
