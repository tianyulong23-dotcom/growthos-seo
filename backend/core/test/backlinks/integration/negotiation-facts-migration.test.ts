import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  backlinkNegotiationFactVersions,
  backlinkReplyClassificationVersions,
} from "../../../src/modules/backlinks/db/schema/negotiation-facts.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type QueryResult = { rows: Record<string, unknown>[] };
type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
};
type PgError = Error & { readonly code?: string };

const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
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
const organizationId = id(1);
const workspaceId = id(2);
const projectId = id(3);
const otherProjectId = id(4);
const gmailConnectionId = id(10);
const inboundMessageId = id(20);
const opportunityId = id(30);
const classificationV1Id = id(40);
const classificationV2Id = id(41);
const manualFactId = id(50);
const inferredFactId = id(51);

const expectCode = async (query: Promise<unknown>, code: string) => {
  const error = await query.catch((caught: unknown) => caught as PgError);
  expect(error).toMatchObject({ code });
};

describe("BL-AI-136 negotiation facts migration", () => {
  const loginRole = `bl_ai_136_${process.pid}_${Date.now()}`;
  const password = randomBytes(24).toString("base64url");
  let harness: BacklinksPostgresHarness;
  let admin: RuntimeClient;
  let tenant: RuntimeClient;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    admin = new PgClient({ connectionString: harness.connectionString });
    await admin.connect();
    for (const name of [
      "0002_backlink_provider_seo.sql",
      "0003_backlink_recommendations.sql",
      "0004_backlink_contacts_opportunities.sql",
    ]) {
      await admin.query(await readFile(migration(name), "utf8"));
    }
    await admin.query(await readFile(roles, "utf8"));
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
      "0027_backlink_negotiation_facts.sql",
    ]) {
      await admin.query(await readFile(migration(name), "utf8"));
    }
    await admin.query(`
      CREATE ROLE "${loginRole}"
      LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
      GRANT growthos_backlinks_writer TO "${loginRole}";
    `);
    await seedProject();

    const tenantUrl = new URL(harness.connectionString);
    tenantUrl.username = loginRole;
    tenantUrl.password = password;
    tenant = new PgClient({ connectionString: tenantUrl.toString() });
    await tenant.connect();
  }, 120_000);

  afterAll(async () => {
    await tenant?.end();
    if (admin !== undefined) {
      await admin.query(`DROP OWNED BY "${loginRole}"`);
      await admin.query(`DROP ROLE IF EXISTS "${loginRole}"`);
      await admin.end();
    }
    await harness?.stop();
  });

  async function seedProject(): Promise<void> {
    const contextVersionId = id(101);
    const prospectId = id(102);
    const recommendationId = id(103);
    const secretId = id(104);
    const bindingId = id(105);
    const rawId = id(106);
    const threadId = id(107);
    const messageId = id(108);

    await admin.query(`
      INSERT INTO backlinks.backlink_prospects (
        id, organization_id, workspace_id, website_project_id,
        recommendation_context_version_id, hostname_ascii,
        registrable_domain, normalization_version, created_by, updated_by
      ) VALUES (
        '${prospectId}', '${organizationId}', '${workspaceId}', '${projectId}',
        '${contextVersionId}', 'publisher.example.test',
        'example.test', 'test-v1', 'test', 'test'
      );
      INSERT INTO backlinks.backlink_recommendations (
        id, organization_id, workspace_id, website_project_id, prospect_id,
        recommendation_context_version_id, status, created_by, updated_by
      ) VALUES (
        '${recommendationId}', '${organizationId}', '${workspaceId}',
        '${projectId}', '${prospectId}', '${contextVersionId}',
        'accepted', 'test', 'test'
      );
      INSERT INTO backlinks.backlink_opportunities (
        id, organization_id, workspace_id, website_project_id,
        recommendation_id, prospect_id, recommendation_context_version_id,
        target_site_key, target_host_ascii, target_identity_rule_version,
        join_sequence, created_by, updated_by
      ) VALUES (
        '${opportunityId}', '${organizationId}', '${workspaceId}', '${projectId}',
        '${recommendationId}', '${prospectId}', '${contextVersionId}',
        'publisher.example.test', 'publisher.example.test',
        'test-v1', 1, 'test', 'test'
      );
      INSERT INTO backlinks.backlink_secret_references (
        id, organization_id, provider, secret_kind, external_secret_id,
        external_secret_version, created_by, updated_by
      ) VALUES (
        '${secretId}', '${organizationId}', 'gcp-secret-manager',
        'GMAIL_TOKEN_SET', 'projects/test/secrets/bl-ai-136', '1',
        'test', 'test'
      );
      INSERT INTO backlinks.backlink_gmail_connections (
        id, organization_id, connected_by_user_id, google_subject,
        primary_email, granted_scopes, token_secret_reference_id,
        token_expires_at, created_by, updated_by
      ) VALUES (
        '${gmailConnectionId}', '${organizationId}', 'user-136',
        'reply-facts-136', 'sender136@example.test',
        '["openid","email","profile","https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/gmail.readonly"]'::jsonb,
        '${secretId}', statement_timestamp() + interval '1 hour',
        'test', 'test'
      );
      INSERT INTO backlinks.backlink_gmail_workspace_bindings (
        id, organization_id, workspace_id, gmail_connection_id,
        created_by, updated_by
      ) VALUES (
        '${bindingId}', '${organizationId}', '${workspaceId}',
        '${gmailConnectionId}', 'test', 'test'
      );
      INSERT INTO backlinks.backlink_mail_raw_message_references (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, provider_message_id, provider_thread_id,
        history_id, raw_object_key, raw_content_sha256, raw_size_bytes,
        fetched_at, retention_expires_at, created_by
      ) VALUES (
        '${rawId}', '${organizationId}', '${workspaceId}', '${projectId}',
        '${gmailConnectionId}', 'provider-message-136',
        'provider-thread-136', '136', 'mail/raw/136',
        '${"b".repeat(64)}', 42, statement_timestamp(),
        statement_timestamp() + interval '30 days', 'test'
      );
      INSERT INTO backlinks.backlink_mail_threads (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, provider_thread_id, created_by, updated_by
      ) VALUES (
        '${threadId}', '${organizationId}', '${workspaceId}', '${projectId}',
        '${gmailConnectionId}', 'provider-thread-136', 'test', 'test'
      );
      INSERT INTO backlinks.backlink_mail_messages (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, raw_message_reference_id, mail_thread_id,
        direction, parse_status, parsed_at, created_by, updated_by
      ) VALUES (
        '${messageId}', '${organizationId}', '${workspaceId}', '${projectId}',
        '${gmailConnectionId}', '${rawId}', '${threadId}',
        'INBOUND', 'PARSED', statement_timestamp(), 'test', 'test'
      );
      INSERT INTO backlinks.backlink_inbound_messages (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, mail_message_id, received_at,
        match_status, created_by, updated_by
      ) VALUES (
        '${inboundMessageId}', '${organizationId}', '${workspaceId}',
        '${projectId}', '${gmailConnectionId}', '${messageId}',
        statement_timestamp(), 'MATCH_CONFIRMED', 'test', 'test'
      );
    `);
  }

  async function tenantQuery(
    websiteProjectId: string,
    sql: string,
  ): Promise<QueryResult> {
    await tenant.query("BEGIN");
    try {
      await tenant.query(
        "SELECT set_config('app.current_organization_id', $1, true)",
        [organizationId],
      );
      await tenant.query(
        "SELECT set_config('app.current_workspace_id', $1, true)",
        [workspaceId],
      );
      await tenant.query(
        "SELECT set_config('app.current_website_project_id', $1, true)",
        [websiteProjectId],
      );
      const result = await tenant.query(sql);
      await tenant.query("COMMIT");
      return result;
    } catch (error) {
      await tenant.query("ROLLBACK");
      throw error;
    }
  }

  it("declares two tenant-safe version tables", () => {
    const configs = [
      backlinkReplyClassificationVersions,
      backlinkNegotiationFactVersions,
    ].map(getTableConfig);
    expect(configs.map(({ name }) => name)).toEqual([
      "backlink_reply_classification_versions",
      "backlink_negotiation_fact_versions",
    ]);
    expect(
      configs.flatMap(({ foreignKeys }) =>
        foreignKeys.map((key) => key.getName()),
      ),
    ).toEqual([
      "backlink_reply_classification_inbound_fk",
      "backlink_negotiation_fact_inbound_fk",
      "backlink_negotiation_fact_opportunity_fk",
      "backlink_negotiation_fact_supersedes_fk",
    ]);
  });

  it("keeps classifications rerunnable without replacing manual facts", async () => {
    await tenantQuery(projectId, `
      INSERT INTO backlinks.backlink_reply_classification_versions (
        id, organization_id, workspace_id, website_project_id,
        inbound_message_id, classification_version, classification_code,
        classifier_type, classifier_version, confidence_score,
        evidence, classified_at, schema_version, created_by
      ) VALUES (
        '${classificationV1Id}', '${organizationId}', '${workspaceId}',
        '${projectId}', '${inboundMessageId}', 1, 'QUESTION',
        'RULE', 'reply-rules-v1', 0.8000,
        '[{"reason":"question_mark"}]'::jsonb,
        statement_timestamp(), 1, 'classifier'
      );
      INSERT INTO backlinks.backlink_negotiation_fact_versions (
        id, organization_id, workspace_id, website_project_id,
        inbound_message_id, opportunity_id, fact_key, fact_version,
        fact_type, raw_value, normalized_value, fact_authority,
        review_status, extractor_type, extractor_version, confidence_score,
        evidence_text, evidence_start, evidence_end, decided_by, decided_at,
        schema_version, created_by
      ) VALUES (
        '${manualFactId}', '${organizationId}', '${workspaceId}', '${projectId}',
        '${inboundMessageId}', '${opportunityId}', 'price', 1,
        'PRICE', '$150', '{"currency":"USD","amount":150}'::jsonb,
        'MANUAL', 'CONFIRMED', 'MANUAL', 'human-v1', 1.0000,
        'Our fee is $150.', 11, 15, 'reviewer-136',
        statement_timestamp(), 1, 'reviewer-136'
      );
    `);

    await tenantQuery(projectId, `
      INSERT INTO backlinks.backlink_reply_classification_versions (
        id, organization_id, workspace_id, website_project_id,
        inbound_message_id, classification_version, classification_code,
        classifier_type, classifier_version, confidence_score,
        evidence, classified_at, schema_version, created_by
      ) VALUES (
        '${classificationV2Id}', '${organizationId}', '${workspaceId}',
        '${projectId}', '${inboundMessageId}', 2, 'PRICE_QUOTE',
        'RULE', 'reply-rules-v2', 0.9200,
        '[{"reason":"currency_amount"}]'::jsonb,
        statement_timestamp(), 1, 'classifier'
      );
      INSERT INTO backlinks.backlink_negotiation_fact_versions (
        id, organization_id, workspace_id, website_project_id,
        inbound_message_id, opportunity_id, fact_key, fact_version,
        fact_type, raw_value, normalized_value, fact_authority,
        review_status, extractor_type, extractor_version, confidence_score,
        evidence_text, evidence_start, evidence_end,
        schema_version, created_by
      ) VALUES (
        '${inferredFactId}', '${organizationId}', '${workspaceId}', '${projectId}',
        '${inboundMessageId}', '${opportunityId}', 'price', 2,
        'PRICE', '$175', '{"currency":"USD","amount":175}'::jsonb,
        'INFERRED', 'PENDING', 'RULE', 'fact-rules-v2', 0.8500,
        'Maybe $175 with edits.', 6, 10, 1, 'classifier'
      );
    `);

    const rows = (
      await tenantQuery(projectId, `
        SELECT fact_version AS "factVersion", raw_value AS "rawValue",
          fact_authority AS authority, review_status AS status
        FROM backlinks.backlink_negotiation_fact_versions
        WHERE fact_key = 'price'
        ORDER BY fact_version
      `)
    ).rows;
    expect(rows).toEqual([
      {
        factVersion: 1,
        rawValue: "$150",
        authority: "MANUAL",
        status: "CONFIRMED",
      },
      {
        factVersion: 2,
        rawValue: "$175",
        authority: "INFERRED",
        status: "PENDING",
      },
    ]);
  });

  it("rejects mutation and hides rows outside the project scope", async () => {
    await expectCode(
      tenantQuery(projectId, `
        UPDATE backlinks.backlink_negotiation_fact_versions
        SET raw_value = '$1'
        WHERE id = '${manualFactId}'
      `),
      "42501",
    );
    expect(
      (
        await tenantQuery(otherProjectId, `
          SELECT id
          FROM backlinks.backlink_negotiation_fact_versions
          WHERE id = '${manualFactId}'
        `)
      ).rows,
    ).toEqual([]);
  });

  it("enforces forced RLS and append-only writer privileges", async () => {
    const rows = (
      await admin.query(`
        SELECT c.relname,
          c.relrowsecurity AND c.relforcerowsecurity AS secure,
          pg_get_userbyid(c.relowner) AS owner,
          has_table_privilege(
            'growthos_backlinks_writer', c.oid, 'SELECT,INSERT'
          ) AS writer_append,
          has_table_privilege(
            'growthos_backlinks_writer', c.oid, 'UPDATE,DELETE'
          ) AS writer_mutation
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'backlinks'
          AND c.relname IN (
            'backlink_reply_classification_versions',
            'backlink_negotiation_fact_versions'
          )
        ORDER BY c.relname
      `)
    ).rows;
    expect(rows).toEqual([
      {
        relname: "backlink_negotiation_fact_versions",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_mutation: false,
      },
      {
        relname: "backlink_reply_classification_versions",
        secure: true,
        owner: "growthos_backlinks_owner",
        writer_append: true,
        writer_mutation: false,
      },
    ]);
  });
});
