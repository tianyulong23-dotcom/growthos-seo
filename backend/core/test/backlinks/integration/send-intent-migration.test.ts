import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backlinkRateLimitReservations,
  backlinkSendAttempts,
  backlinkSendIntents,
} from "../../../src/modules/backlinks/db/schema/send-intents.js";
import {
  backlinkSuppressionEntries,
} from "../../../src/modules/backlinks/db/schema/suppressions.js";
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
const workspace = id(2);
const project = id(3);
const otherProject = id(4);
const identity = `'${organization}', '${workspace}', '${project}'`;
const scopes =
  `'["openid","email","profile",` +
  `"https://www.googleapis.com/auth/gmail.send"]'::jsonb`;
const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};

describe("BL-AI-107 send persistence", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  const insertIntent = (
    intentId: string,
    clientKey: string,
    logicalKey: string,
    purpose = "INITIAL_OUTREACH",
    followUpIndex = 0,
  ) => client.query(`
    INSERT INTO backlink_send_intents (
      id, organization_id, workspace_id, website_project_id,
      opportunity_id, draft_id, approved_draft_version_id,
      gmail_connection_id, client_idempotency_key, logical_message_key,
      message_purpose, follow_up_index, requested_send_at,
      created_by, updated_by
    ) VALUES (
      '${intentId}', ${identity}, '${id(301)}', '${id(501)}', '${id(601)}',
      '${id(701)}', '${clientKey}', '${logicalKey}', '${purpose}',
      ${followUpIndex}, statement_timestamp(), 'test', 'test'
    )
  `);

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
    await client.query(`
      INSERT INTO backlink_prospects (
        id, organization_id, workspace_id, website_project_id,
        recommendation_context_version_id, hostname_ascii,
        registrable_domain, normalization_version, created_by, updated_by
      ) VALUES (
        '${id(101)}', ${identity}, '${id(102)}', 'www.example.com',
        'example.com', 'tldts-7.4.9-v1', 'test', 'test'
      );
      INSERT INTO backlink_recommendations (
        id, organization_id, workspace_id, website_project_id, prospect_id,
        recommendation_context_version_id, status, created_by, updated_by
      ) VALUES (
        '${id(201)}', ${identity}, '${id(101)}', '${id(102)}',
        'accepted', 'test', 'test'
      );
      INSERT INTO backlink_opportunities (
        id, organization_id, workspace_id, website_project_id,
        recommendation_id, prospect_id, recommendation_context_version_id,
        target_site_key, target_host_ascii, target_identity_rule_version,
        join_sequence, created_by, updated_by
      ) VALUES (
        '${id(301)}', ${identity}, '${id(201)}', '${id(101)}', '${id(102)}',
        'example.com', 'www.example.com', 'tldts-7.4.9-v1', 1,
        'test', 'test'
      );
      INSERT INTO backlink_evidence_snapshots (
        id, organization_id, workspace_id, website_project_id, opportunity_id,
        evidence_items, snapshot_hash, schema_version, created_by
      ) VALUES (
        '${id(401)}', ${identity}, '${id(301)}',
        '[{"id":"profile:1"}]', '${"a".repeat(64)}', 1, 'test'
      );
      INSERT INTO backlink_email_drafts (
        id, organization_id, workspace_id, website_project_id, opportunity_id,
        logical_draft_key, status, created_by, updated_by
      ) VALUES (
        '${id(501)}', ${identity}, '${id(301)}', 'send-ready', 'draft',
        'test', 'test'
      );
      INSERT INTO backlink_draft_versions (
        id, organization_id, workspace_id, website_project_id, draft_id,
        opportunity_id, version_no, source, evidence_snapshot_id,
        subject_text, body_text, structured_output, evidence_ids,
        prompt_version, output_schema_version, created_by
      ) VALUES (
        '${id(601)}', ${identity}, '${id(501)}', '${id(301)}', 1, 'MANUAL',
        '${id(401)}', 'Approved subject', 'Approved body', '{}', '[]',
        'manual.v1', 'manual.v1', 'test'
      );
      UPDATE backlink_email_drafts
      SET status = 'approved', current_version_id = '${id(601)}',
        approved_version_id = '${id(601)}', version = 2,
        updated_at = statement_timestamp(), updated_by = 'test'
      WHERE id = '${id(501)}';
      INSERT INTO backlink_secret_references (
        id, organization_id, provider, secret_kind, external_secret_id,
        external_secret_version, created_by, updated_by
      ) VALUES (
        '${id(701)}', '${organization}', 'gcp-secret-manager',
        'GMAIL_TOKEN_SET', 'projects/test/secrets/gmail-token-1', '1',
        'test', 'test'
      );
      INSERT INTO backlink_gmail_connections (
        id, organization_id, connected_by_user_id, google_subject,
        primary_email, granted_scopes, token_secret_reference_id,
        token_expires_at, created_by, updated_by
      ) VALUES
        (
          '${id(701)}', '${organization}', 'user-1', 'google-subject-1',
          'sender@example.test', ${scopes}, '${id(701)}',
          statement_timestamp() + interval '1 hour', 'test', 'test'
        ),
        (
          '${id(702)}', '${organization}', 'user-1', 'google-subject-2',
          'sender-2@example.test', ${scopes}, '${id(701)}',
          statement_timestamp() + interval '1 hour', 'test', 'test'
        );
    `);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("declares separate intent, attempt, quota, and suppression schemas", () => {
    const configs = [
      backlinkSendIntents,
      backlinkSendAttempts,
      backlinkRateLimitReservations,
      backlinkSuppressionEntries,
    ].map(getTableConfig);
    expect(configs.map(({ name }) => name)).toEqual([
      "backlink_send_intents",
      "backlink_send_attempts",
      "backlink_rate_limit_reservations",
      "backlink_suppression_entries",
    ]);
    expect(configs.flatMap(({ foreignKeys }) =>
      foreignKeys.map((key) => key.getName()),
    )).toEqual(expect.arrayContaining([
      "backlink_send_intent_opportunity_fk",
      "backlink_send_intent_draft_version_fk",
      "backlink_send_intent_connection_fk",
      "backlink_send_attempt_intent_fk",
      "backlink_rate_limit_reservation_intent_fk",
      "backlink_rate_limit_reservation_connection_fk",
    ]));
  });

  it("separates logical intents from append-only provider attempts", async () => {
    await insertIntent(id(801), "client-send-1", "b".repeat(64));
    expect((await client.query(`
      SELECT
        (SELECT count(*)::integer FROM backlink_send_intents) AS intents,
        (SELECT count(*)::integer FROM backlink_send_attempts) AS attempts
    `)).rows).toEqual([{ intents: 1, attempts: 0 }]);

    await client.query(`
      INSERT INTO backlink_send_attempts (
        id, organization_id, workspace_id, website_project_id,
        send_intent_id, attempt_no, fencing_token, rfc_message_id,
        status, started_at, created_by
      ) VALUES (
        '${id(901)}', ${identity}, '${id(801)}', 1, 1,
        '<send-1@example.test>', 'DISPATCHING', statement_timestamp(), 'test'
      )
    `);
    await expectCode(
      insertIntent(id(802), "client-send-1", "c".repeat(64)),
      "23505",
    );
    await expectCode(
      insertIntent(id(803), "client-send-2", "b".repeat(64)),
      "23505",
    );
    await expectCode(
      insertIntent(id(804), "client-send-3", "d".repeat(64), "FOLLOW_UP", 0),
      "23514",
    );
    await expectCode(client.query(`
      INSERT INTO backlink_send_attempts (
        id, organization_id, workspace_id, website_project_id,
        send_intent_id, attempt_no, fencing_token, rfc_message_id,
        status, started_at, created_by
      ) VALUES (
        '${id(902)}', ${identity}, '${id(801)}', 1, 2,
        '<send-2@example.test>', 'DISPATCHING', statement_timestamp(), 'test'
      )
    `), "23505");
    await expectCode(client.query(`
      INSERT INTO backlink_send_attempts (
        id, organization_id, workspace_id, website_project_id,
        send_intent_id, attempt_no, fencing_token, rfc_message_id,
        status, started_at, created_by
      ) VALUES (
        '${id(903)}', ${identity}, '${id(801)}', 2, 2,
        '<send-1@example.test>', 'DISPATCHING', statement_timestamp(), 'test'
      )
    `), "23505");
    await expectCode(client.query(`
      UPDATE backlink_send_attempts
      SET status = 'FAILED_RETRYABLE', completed_at = statement_timestamp(),
        provider_error_code = 'TIMEOUT'
      WHERE id = '${id(901)}'
    `), "55000");
  });

  it("enforces organization-global and project suppression keys", async () => {
    const suppress = (
      entryId: string,
      scopeType: string,
      workspaceId: string | null,
      projectId: string | null,
      targetHmac: string,
    ) => client.query(`
      INSERT INTO backlink_suppression_entries (
        id, organization_id, workspace_id, website_project_id,
        scope_type, target_type, target_hmac, hash_key_version,
        reason, created_by, updated_by
      ) VALUES (
        '${entryId}', '${organization}',
        ${workspaceId === null ? "NULL" : `'${workspaceId}'`},
        ${projectId === null ? "NULL" : `'${projectId}'`},
        '${scopeType}', 'EMAIL', '${targetHmac}', 1, 'REJECTION',
        'test', 'test'
      )
    `);
    await suppress(id(1001), "ORGANIZATION", null, null, "c".repeat(64));
    await expectCode(
      suppress(id(1002), "ORGANIZATION", null, null, "c".repeat(64)),
      "23505",
    );
    await suppress(id(1003), "WEBSITE_PROJECT", workspace, project, "c".repeat(64));
    await expectCode(
      suppress(id(1004), "WEBSITE_PROJECT", workspace, project, "c".repeat(64)),
      "23505",
    );
    await suppress(
      id(1005),
      "WEBSITE_PROJECT",
      workspace,
      otherProject,
      "c".repeat(64),
    );
    await expectCode(
      suppress(id(1006), "WEBSITE_PROJECT", null, null, "d".repeat(64)),
      "23514",
    );
    await expectCode(
      suppress(
        id(1007),
        "WEBSITE_PROJECT",
        workspace,
        project,
        "person@example.test",
      ),
      "23514",
    );

    await client.query(`
      UPDATE backlink_suppression_entries
      SET status = 'RELEASED', released_at = statement_timestamp(),
        release_reason = 'manual correction', version = 2,
        updated_at = statement_timestamp(), updated_by = 'test'
      WHERE id = '${id(1003)}'
    `);
    await suppress(id(1008), "WEBSITE_PROJECT", workspace, project, "c".repeat(64));
    await expectCode(client.query(`
      UPDATE backlink_suppression_entries
      SET status = 'ACTIVE', released_at = NULL, release_reason = NULL,
        version = 3, updated_at = statement_timestamp(), updated_by = 'test'
      WHERE id = '${id(1003)}'
    `), "55000");
  });

  it("keeps quota reservations tied to one intent and Gmail lane", async () => {
    await client.query(`
      INSERT INTO backlink_rate_limit_reservations (
        id, organization_id, workspace_id, website_project_id,
        send_intent_id, gmail_connection_id, reservation_key, lane_sequence,
        status, reserved_at, eligible_at, expires_at, created_by, updated_by
      ) VALUES (
        '${id(1101)}', ${identity}, '${id(801)}', '${id(701)}',
        '${"e".repeat(64)}', 1, 'RESERVED', statement_timestamp(),
        statement_timestamp(), statement_timestamp() + interval '10 minutes',
        'test', 'test'
      )
    `);
    await expectCode(client.query(`
      INSERT INTO backlink_rate_limit_reservations (
        id, organization_id, workspace_id, website_project_id,
        send_intent_id, gmail_connection_id, reservation_key, lane_sequence,
        status, reserved_at, eligible_at, expires_at, created_by, updated_by
      ) VALUES (
        '${id(1102)}', ${identity}, '${id(801)}', '${id(701)}',
        '${"f".repeat(64)}', 2, 'RESERVED', statement_timestamp(),
        statement_timestamp(), statement_timestamp() + interval '10 minutes',
        'test', 'test'
      )
    `), "23505");

    await insertIntent(id(805), "client-send-5", "f".repeat(64));
    await expectCode(client.query(`
      INSERT INTO backlink_rate_limit_reservations (
        id, organization_id, workspace_id, website_project_id,
        send_intent_id, gmail_connection_id, reservation_key, lane_sequence,
        status, reserved_at, eligible_at, expires_at, created_by, updated_by
      ) VALUES (
        '${id(1106)}', ${identity}, '${id(805)}', '${id(701)}',
        '${"0".repeat(64)}', 1, 'RESERVED', statement_timestamp(),
        statement_timestamp(), statement_timestamp() + interval '10 minutes',
        'test', 'test'
      )
    `), "23505");
    await expectCode(client.query(`
      INSERT INTO backlink_rate_limit_reservations (
        id, organization_id, workspace_id, website_project_id,
        send_intent_id, gmail_connection_id, reservation_key, lane_sequence,
        status, reserved_at, eligible_at, expires_at, created_by, updated_by
      ) VALUES (
        '${id(1103)}', ${identity}, '${id(805)}', '${id(702)}',
        '${"1".repeat(64)}', 2, 'RESERVED', statement_timestamp(),
        statement_timestamp(), statement_timestamp() + interval '10 minutes',
        'test', 'test'
      )
    `), "23503");
    await expectCode(client.query(`
      INSERT INTO backlink_rate_limit_reservations (
        id, organization_id, workspace_id, website_project_id,
        send_intent_id, gmail_connection_id, reservation_key, lane_sequence,
        status, reserved_at, eligible_at, expires_at, created_by, updated_by
      ) VALUES (
        '${id(1104)}', ${identity}, '${id(805)}', '${id(701)}',
        '${"2".repeat(64)}', 2, 'CONSUMED', statement_timestamp(),
        statement_timestamp(), statement_timestamp() + interval '10 minutes',
        'test', 'test'
      )
    `), "23514");
    await client.query(`
      INSERT INTO backlink_rate_limit_reservations (
        id, organization_id, workspace_id, website_project_id,
        send_intent_id, gmail_connection_id, reservation_key, lane_sequence,
        status, reserved_at, eligible_at, expires_at, created_by, updated_by
      ) VALUES (
        '${id(1105)}', ${identity}, '${id(805)}', '${id(701)}',
        '${"3".repeat(64)}', 2, 'RESERVED', statement_timestamp(),
        statement_timestamp(), statement_timestamp() + interval '10 minutes',
        'test', 'test'
      )
    `);
    await client.query(`
      UPDATE backlink_rate_limit_reservations
      SET status = 'CONSUMED', consumed_at = statement_timestamp(), version = 2,
        updated_at = statement_timestamp(), updated_by = 'test'
      WHERE id = '${id(1105)}'
    `);
    await expectCode(client.query(`
      UPDATE backlink_rate_limit_reservations
      SET status = 'RELEASED', consumed_at = NULL,
        released_at = statement_timestamp(), release_reason = 'retry',
        version = 3, updated_at = statement_timestamp(), updated_by = 'test'
      WHERE id = '${id(1105)}'
    `), "55000");
  });

  it("forces tenant RLS, append-only attempts, and HMAC-only suppression", async () => {
    expect((await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'backlinks'
        AND table_name = 'backlink_suppression_entries'
        AND column_name IN ('email', 'domain', 'target_value', 'plaintext')
    `)).rows).toEqual([]);

    expect((await client.query(`
      SELECT c.relname,
        c.relrowsecurity AND c.relforcerowsecurity AS secure,
        pg_get_userbyid(c.relowner) AS owner,
        has_table_privilege(
          'growthos_backlinks_writer', c.oid, 'SELECT,INSERT'
        ) AS writer_append,
        has_table_privilege(
          'growthos_backlinks_writer', c.oid, 'UPDATE'
        ) AS writer_update,
        has_table_privilege(
          'growthos_backlinks_writer', c.oid, 'DELETE'
        ) AS writer_delete
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'backlinks'
        AND c.relname IN (
          'backlink_send_intents', 'backlink_send_attempts',
          'backlink_rate_limit_reservations', 'backlink_suppression_entries'
        )
      ORDER BY c.relname
    `)).rows).toEqual([
      {
        relname: "backlink_rate_limit_reservations",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_update: true,
        writer_delete: false,
      },
      {
        relname: "backlink_send_attempts",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_update: false,
        writer_delete: false,
      },
      {
        relname: "backlink_send_intents",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_update: true,
        writer_delete: false,
      },
      {
        relname: "backlink_suppression_entries",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_update: true,
        writer_delete: false,
      },
    ]);

    await client.query("SET ROLE growthos_backlinks_writer");
    try {
      await client.query(`
        SELECT set_config(
            'app.current_organization_id',
            '${organization}',
            false
          ),
          set_config('app.current_workspace_id', '${workspace}', false),
          set_config('app.current_website_project_id', '${project}', false)
      `);
      expect((await client.query(`
        SELECT
          (SELECT count(*)::integer FROM backlink_send_intents) AS intents,
          (SELECT count(*)::integer FROM backlink_send_attempts) AS attempts,
          (SELECT count(*)::integer FROM backlink_rate_limit_reservations)
            AS reservations,
          (SELECT count(*)::integer FROM backlink_suppression_entries)
            AS suppressions
      `)).rows).toEqual([{
        intents: 2,
        attempts: 1,
        reservations: 2,
        suppressions: 3,
      }]);

      await client.query(`
        SELECT set_config(
          'app.current_website_project_id',
          '${otherProject}',
          false
        )
      `);
      expect((await client.query(`
        SELECT
          (SELECT count(*)::integer FROM backlink_send_intents) AS intents,
          (SELECT count(*)::integer FROM backlink_suppression_entries)
            AS suppressions
      `)).rows).toEqual([{ intents: 0, suppressions: 2 }]);
    } finally {
      await client.query("RESET ROLE");
      await client.query("RESET app.current_organization_id");
      await client.query("RESET app.current_workspace_id");
      await client.query("RESET app.current_website_project_id");
    }
  });
});
