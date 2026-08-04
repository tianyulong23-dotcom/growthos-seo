import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  backlinkInboundMessages,
  backlinkMailMessages,
  backlinkMailRawMessageReferences,
  backlinkMailSyncCursors,
  backlinkMailThreads,
  backlinkReplyMatchCandidates,
} from "../../../src/modules/backlinks/db/schema/mail-sync.js";
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
const readSyncScopes =
  `'["openid","email","profile",` +
  `"https://www.googleapis.com/auth/gmail.send",` +
  `"https://www.googleapis.com/auth/gmail.readonly"]'::jsonb`;
const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};

describe("BL-AI-125 mail sync persistence migration", () => {
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
      "0016_backlink_mail_sync.sql",
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
        '${id(101)}', ${identity}, '${id(102)}', 'www.example.test',
        'example.test', 'tldts-7.4.9-v1', 'test', 'test'
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
        'example.test', 'www.example.test', 'tldts-7.4.9-v1', 1,
        'test', 'test'
      );
      INSERT INTO backlink_secret_references (
        id, organization_id, provider, secret_kind, external_secret_id,
        external_secret_version, created_by, updated_by
      ) VALUES (
        '${id(401)}', '${organization}', 'gcp-secret-manager',
        'GMAIL_TOKEN_SET', 'projects/test/secrets/mail-sync-token', '1',
        'test', 'test'
      );
      INSERT INTO backlink_gmail_connections (
        id, organization_id, connected_by_user_id, google_subject,
        primary_email, granted_scopes, token_secret_reference_id,
        token_expires_at, created_by, updated_by
      ) VALUES (
        '${id(501)}', '${organization}', 'user-1', 'mail-sync-subject',
        'sender@example.test', ${readSyncScopes}, '${id(401)}',
        statement_timestamp() + interval '1 hour', 'test', 'test'
      );
    `);
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("declares the cursor, raw reference, message, reply, and match schemas", () => {
    const configs = [
      backlinkMailSyncCursors,
      backlinkMailRawMessageReferences,
      backlinkMailThreads,
      backlinkMailMessages,
      backlinkInboundMessages,
      backlinkReplyMatchCandidates,
    ].map(getTableConfig);

    expect(configs.map(({ name }) => name)).toEqual([
      "backlink_mail_sync_cursors",
      "backlink_mail_raw_message_references",
      "backlink_mail_threads",
      "backlink_mail_messages",
      "backlink_inbound_messages",
      "backlink_reply_match_candidates",
    ]);
    expect(configs.flatMap(({ foreignKeys }) =>
      foreignKeys.map((key) => key.getName()),
    )).toEqual(expect.arrayContaining([
      "backlink_mail_sync_cursor_connection_fk",
      "backlink_mail_message_raw_reference_fk",
      "backlink_mail_message_thread_fk",
      "backlink_inbound_message_mail_message_fk",
      "backlink_reply_match_candidate_inbound_fk",
      "backlink_reply_match_candidate_opportunity_fk",
    ]));
  });

  it("enforces history cursors, raw-reference retention, and message deduplication", async () => {
    await client.query(`
      INSERT INTO backlink_mail_sync_cursors (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, history_id, next_page_token,
        created_by, updated_by
      ) VALUES (
        '${id(601)}', ${identity}, '${id(501)}', '12345', 'page-1',
        'test', 'test'
      );
    `);
    await expectCode(client.query(`
      INSERT INTO backlink_mail_sync_cursors (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, created_by, updated_by
      ) VALUES (
        '${id(602)}', ${identity}, '${id(501)}', 'test', 'test'
      );
    `), "23505");
    await expectCode(client.query(`
      INSERT INTO backlink_mail_sync_cursors (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, history_id, created_by, updated_by
      ) VALUES (
        '${id(603)}', ${identity}, '${id(501)}', 'history-not-numeric',
        'test', 'test'
      );
    `), "23514");

    await client.query(`
      INSERT INTO backlink_mail_raw_message_references (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, provider_message_id, provider_thread_id,
        history_id, raw_object_key, raw_content_sha256, raw_size_bytes,
        fetched_at, retention_expires_at, created_by
      ) VALUES (
        '${id(701)}', ${identity}, '${id(501)}', 'gmail-message-1',
        'gmail-thread-1', '12345', 'mail/raw/018f-message-1',
        '${"a".repeat(64)}', 42, statement_timestamp(),
        statement_timestamp() + interval '30 days', 'test'
      );
      INSERT INTO backlink_mail_threads (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, provider_thread_id, message_count,
        created_by, updated_by
      ) VALUES (
        '${id(702)}', ${identity}, '${id(501)}', 'gmail-thread-1', 1,
        'test', 'test'
      );
      INSERT INTO backlink_mail_messages (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, raw_message_reference_id, mail_thread_id,
        rfc_message_id, reference_message_ids, from_address, to_addresses,
        subject_text, received_at, direction, parse_status, parsed_at,
        created_by, updated_by
      ) VALUES (
        '${id(703)}', ${identity}, '${id(501)}', '${id(701)}', '${id(702)}',
        '<reply-1@example.test>', '["<outbound-1@example.test>"]'::jsonb,
        'publisher@example.test', '["sender@example.test"]'::jsonb,
        'Re: Example', statement_timestamp(), 'INBOUND', 'PARSED',
        statement_timestamp(), 'test', 'test'
      );
      INSERT INTO backlink_inbound_messages (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, mail_message_id, received_at, created_by, updated_by
      ) VALUES (
        '${id(704)}', ${identity}, '${id(501)}', '${id(703)}',
        statement_timestamp(), 'test', 'test'
      );
      INSERT INTO backlink_reply_match_candidates (
        id, organization_id, workspace_id, website_project_id,
        inbound_message_id, opportunity_id, candidate_rank, confidence_score,
        reason_codes, created_by
      ) VALUES (
        '${id(705)}', ${identity}, '${id(704)}', '${id(301)}', 1, 0.7500,
        '["gmail_thread_id","in_reply_to"]'::jsonb, 'test'
      );
    `);

    await expectCode(client.query(`
      INSERT INTO backlink_mail_raw_message_references (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, provider_message_id, provider_thread_id,
        raw_object_key, raw_content_sha256, raw_size_bytes,
        fetched_at, retention_expires_at, created_by
      ) VALUES (
        '${id(706)}', ${identity}, '${id(501)}', 'gmail-message-1',
        'gmail-thread-1', 'mail/raw/duplicate', '${"b".repeat(64)}', 1,
        statement_timestamp(), statement_timestamp() + interval '30 days',
        'test'
      );
    `), "23505");
    await expectCode(client.query(`
      INSERT INTO backlink_mail_raw_message_references (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, provider_message_id, provider_thread_id,
        raw_object_key, raw_content_sha256, raw_size_bytes,
        fetched_at, retention_expires_at, created_by
      ) VALUES (
        '${id(707)}', ${identity}, '${id(501)}', 'gmail-message-expired',
        'gmail-thread-1', 'mail/raw/expired', '${"c".repeat(64)}', 1,
        statement_timestamp(), statement_timestamp(), 'test'
      );
    `), "23514");

    expect((await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'backlinks'
        AND table_name = 'backlink_mail_raw_message_references'
        AND column_name IN ('raw_mime', 'raw_html', 'body_html', 'body_text')
    `)).rows).toEqual([]);
    expect((await client.query(`
      SELECT requires_manual_confirmation AS "requiresManualConfirmation"
      FROM backlink_reply_match_candidates
      WHERE id = '${id(705)}'
    `)).rows).toEqual([{ requiresManualConfirmation: true }]);
  });

  it("forces project RLS and grants no delete privilege", async () => {
    expect((await client.query(`
      SELECT c.relname,
        c.relrowsecurity AND c.relforcerowsecurity AS secure,
        pg_get_userbyid(c.relowner) AS owner,
        has_table_privilege(
          'growthos_backlinks_writer', c.oid, 'SELECT,INSERT,UPDATE'
        ) AS writer_mutates,
        has_table_privilege(
          'growthos_backlinks_writer', c.oid, 'DELETE'
        ) AS writer_deletes
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'backlinks'
        AND c.relname IN (
          'backlink_mail_sync_cursors',
          'backlink_mail_raw_message_references',
          'backlink_mail_threads',
          'backlink_mail_messages',
          'backlink_inbound_messages',
          'backlink_reply_match_candidates'
        )
      ORDER BY c.relname
    `)).rows).toEqual([
      {
        relname: "backlink_inbound_messages",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_mutates: true,
        writer_deletes: false,
      },
      {
        relname: "backlink_mail_messages",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_mutates: true,
        writer_deletes: false,
      },
      {
        relname: "backlink_mail_raw_message_references",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_mutates: true,
        writer_deletes: false,
      },
      {
        relname: "backlink_mail_sync_cursors",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_mutates: true,
        writer_deletes: false,
      },
      {
        relname: "backlink_mail_threads",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_mutates: true,
        writer_deletes: false,
      },
      {
        relname: "backlink_reply_match_candidates",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_mutates: true,
        writer_deletes: false,
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
          (SELECT count(*)::integer FROM backlink_mail_sync_cursors) AS cursors,
          (SELECT count(*)::integer FROM backlink_mail_raw_message_references)
            AS raw_references,
          (SELECT count(*)::integer FROM backlink_mail_threads) AS threads,
          (SELECT count(*)::integer FROM backlink_mail_messages) AS messages,
          (SELECT count(*)::integer FROM backlink_inbound_messages) AS replies,
          (SELECT count(*)::integer FROM backlink_reply_match_candidates)
            AS candidates
      `)).rows).toEqual([{
        cursors: 1,
        raw_references: 1,
        threads: 1,
        messages: 1,
        replies: 1,
        candidates: 1,
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
          (SELECT count(*)::integer FROM backlink_mail_sync_cursors) AS cursors,
          (SELECT count(*)::integer FROM backlink_mail_raw_message_references)
            AS raw_references,
          (SELECT count(*)::integer FROM backlink_mail_threads) AS threads,
          (SELECT count(*)::integer FROM backlink_mail_messages) AS messages,
          (SELECT count(*)::integer FROM backlink_inbound_messages) AS replies,
          (SELECT count(*)::integer FROM backlink_reply_match_candidates)
            AS candidates
      `)).rows).toEqual([{
        cursors: 0,
        raw_references: 0,
        threads: 0,
        messages: 0,
        replies: 0,
        candidates: 0,
      }]);
    } finally {
      await client.query("RESET ROLE");
      await client.query("RESET app.current_organization_id");
      await client.query("RESET app.current_workspace_id");
      await client.query("RESET app.current_website_project_id");
    }
  });
});
