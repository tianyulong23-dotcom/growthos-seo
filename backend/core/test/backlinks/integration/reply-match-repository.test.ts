import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresqlReplyMatchRepository,
} from "../../../src/modules/backlinks/application/services/reply-match.repository.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionQueryResult,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<BacklinkTransactionQueryResult>;
};
type RuntimePool = BacklinkTenantPool & { end(): Promise<void> };

const require = createRequire(import.meta.url);
const { Client: PgClient, Pool: PgPool } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
  readonly Pool: new (config: unknown) => RuntimePool;
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
const projectA = id(3);
const projectB = id(4);
const projectC = id(5);
const gmailConnectionId = id(501);
const inboundA = id(601);
const inboundB = id(602);
const inboundC = id(603);
const opportunityA = id(701);
const opportunityB = id(702);
const opportunityC = id(703);

describe("BL-AI-135 PostgreSQL Reply Match Repository", () => {
  const loginRole = `bl_ai_135_${process.pid}_${Date.now()}`;
  const password = randomBytes(24).toString("base64url");
  let harness: BacklinksPostgresHarness;
  let admin: RuntimeClient;
  let tenantPool: RuntimePool;
  let nextId = 800;

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
    ]) {
      await admin.query(await readFile(migration(name), "utf8"));
    }
    await admin.query(`
      CREATE ROLE "${loginRole}"
      LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
      GRANT growthos_backlinks_writer TO "${loginRole}";
    `);
    await seedProject(projectA, opportunityA, inboundA, 100);
    await seedProject(projectB, opportunityB, inboundB, 200);
    await seedProject(projectC, opportunityC, inboundC, 300);

    const tenantUrl = new URL(harness.connectionString);
    tenantUrl.username = loginRole;
    tenantUrl.password = password;
    tenantPool = new PgPool({ connectionString: tenantUrl.toString(), max: 4 });
  }, 120_000);

  afterAll(async () => {
    await tenantPool?.end();
    if (admin !== undefined) {
      await admin.query(`DROP OWNED BY "${loginRole}"`);
      await admin.query(`DROP ROLE IF EXISTS "${loginRole}"`);
      await admin.end();
    }
    await harness?.stop();
  });

  async function seedProject(
    projectId: string,
    opportunityId: string,
    inboundMessageId: string,
    offset: number,
  ): Promise<void> {
    const contextVersionId = id(offset + 1);
    const prospectId = id(offset + 2);
    const recommendationId = id(offset + 3);
    const secretId = id(offset + 4);
    const bindingId = id(offset + 5);
    const rawId = id(offset + 6);
    const threadId = id(offset + 7);
    const messageId = id(offset + 8);

    await admin.query(`
      INSERT INTO backlinks.backlink_prospects (
        id, organization_id, workspace_id, website_project_id,
        recommendation_context_version_id, hostname_ascii,
        registrable_domain, normalization_version, created_by, updated_by
      ) VALUES (
        '${prospectId}', '${organizationId}', '${workspaceId}', '${projectId}',
        '${contextVersionId}', 'publisher-${offset}.example.test',
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
        'publisher-${offset}.example.test', 'publisher-${offset}.example.test',
        'test-v1', 1, 'test', 'test'
      );
      INSERT INTO backlinks.backlink_secret_references (
        id, organization_id, provider, secret_kind, external_secret_id,
        external_secret_version, created_by, updated_by
      ) VALUES (
        '${secretId}', '${organizationId}', 'gcp-secret-manager',
        'GMAIL_TOKEN_SET', 'projects/test/secrets/reply-match-${offset}', '1',
        'test', 'test'
      ) ON CONFLICT (id) DO NOTHING;
      INSERT INTO backlinks.backlink_gmail_connections (
        id, organization_id, connected_by_user_id, google_subject,
        primary_email, granted_scopes, token_secret_reference_id,
        token_expires_at, created_by, updated_by
      ) VALUES (
        '${gmailConnectionId}', '${organizationId}', 'user-135',
        'reply-match-135', 'sender135@example.test',
        '["openid","email","profile","https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/gmail.readonly"]'::jsonb,
        '${secretId}', statement_timestamp() + interval '1 hour',
        'test', 'test'
      ) ON CONFLICT (id) DO NOTHING;
      INSERT INTO backlinks.backlink_gmail_workspace_bindings (
        id, organization_id, workspace_id, gmail_connection_id,
        created_by, updated_by
      ) VALUES (
        '${bindingId}', '${organizationId}', '${workspaceId}',
        '${gmailConnectionId}', 'test', 'test'
      ) ON CONFLICT (organization_id, workspace_id, gmail_connection_id)
        DO NOTHING;
      INSERT INTO backlinks.backlink_mail_raw_message_references (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, provider_message_id, provider_thread_id,
        history_id, raw_object_key, raw_content_sha256, raw_size_bytes,
        fetched_at, retention_expires_at, created_by
      ) VALUES (
        '${rawId}', '${organizationId}', '${workspaceId}', '${projectId}',
        '${gmailConnectionId}', 'provider-message-${offset}',
        'provider-thread-${offset}', '${offset}', 'mail/raw/${offset}',
        '${"b".repeat(64)}', 42, statement_timestamp(),
        statement_timestamp() + interval '30 days', 'test'
      );
      INSERT INTO backlinks.backlink_mail_threads (
        id, organization_id, workspace_id, website_project_id,
        gmail_connection_id, provider_thread_id, created_by, updated_by
      ) VALUES (
        '${threadId}', '${organizationId}', '${workspaceId}', '${projectId}',
        '${gmailConnectionId}', 'provider-thread-${offset}', 'test', 'test'
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
        created_by, updated_by
      ) VALUES (
        '${inboundMessageId}', '${organizationId}', '${workspaceId}',
        '${projectId}', '${gmailConnectionId}', '${messageId}',
        statement_timestamp(), 'test', 'test'
      );
    `);
  }

  const repository = () =>
    new PostgresqlReplyMatchRepository({
      pool: tenantPool,
      newId: () => id(nextId++),
    });

  it("keeps low-confidence candidates manual and invisible across projects", async () => {
    const repo = repository();
    await expect(repo.saveMatchResult({
      organizationId,
      workspaceId,
      websiteProjectId: projectA,
      gmailConnectionId,
      inboundMessageId: inboundA,
      actorId: "worker-135",
      result: {
        decision: "REVIEW_REQUIRED",
        confidence: "LOW",
        matchedOpportunityId: null,
        matchedMailThreadId: null,
        ruleVersion: "reply-matcher-v1",
        candidates: [{
          opportunityId: opportunityA,
          mailThreadId: id(107),
          confidence: "LOW",
          requiresManualConfirmation: true,
          evidence: [{
            kind: "NORMALIZED_SUBJECT",
            value: "growthos collaboration",
          }],
        }],
      },
    })).resolves.toMatchObject({
      state: "saved",
      matchStatus: "CANDIDATES_READY",
      candidates: [{
        opportunityId: opportunityA,
        requiresManualConfirmation: true,
      }],
    });

    await expect(repo.listCandidates({
      organizationId,
      workspaceId,
      websiteProjectId: projectA,
      inboundMessageId: inboundA,
    })).resolves.toMatchObject({
      state: "found",
      matchStatus: "CANDIDATES_READY",
      candidates: [{
        opportunityId: opportunityA,
        requiresManualConfirmation: true,
      }],
    });
    await expect(repo.listCandidates({
      organizationId,
      workspaceId,
      websiteProjectId: projectB,
      inboundMessageId: inboundA,
    })).resolves.toEqual({ state: "not_found" });
    await expect(repo.listCandidates({
      organizationId,
      workspaceId: id(999),
      websiteProjectId: projectA,
      inboundMessageId: inboundA,
    })).resolves.toEqual({ state: "not_found" });
    expect((await admin.query(`
      SELECT count(*)::integer AS count
      FROM backlinks.backlink_lifecycle_events
      WHERE event_type = 'reply.assignment.recorded'
        AND aggregate_id = '${inboundA}'
    `)).rows).toEqual([{ count: 0 }]);
  });

  it("confirms and unbinds with audit facts without changing business stage", async () => {
    const repo = repository();
    const stageBefore = (await admin.query(`
      SELECT business_stage AS "businessStage"
      FROM backlinks.backlink_opportunities
      WHERE id = '${opportunityA}'
    `)).rows[0]?.businessStage;
    const listed = await repo.listCandidates({
      organizationId,
      workspaceId,
      websiteProjectId: projectA,
      inboundMessageId: inboundA,
    });
    if (listed.state !== "found") throw new Error("candidate missing");
    const candidate = listed.candidates[0];
    if (candidate === undefined) throw new Error("candidate missing");

    await expect(repo.confirmCandidate({
      organizationId,
      workspaceId,
      websiteProjectId: projectA,
      inboundMessageId: inboundA,
      candidateId: candidate.id,
      expectedMatchStatus: "CANDIDATES_READY",
      actorId: "user-135",
      requestId: "request-135",
      reason: "Verified against the original outreach thread.",
    })).resolves.toMatchObject({
      state: "confirmed",
      candidateId: candidate.id,
      opportunityId: opportunityA,
      matchStatus: "MATCH_CONFIRMED",
    });
    await expect(repo.confirmCandidate({
      organizationId,
      workspaceId,
      websiteProjectId: projectA,
      inboundMessageId: inboundA,
      candidateId: candidate.id,
      expectedMatchStatus: "CANDIDATES_READY",
      actorId: "user-135",
      requestId: "request-135-stale",
      reason: "Stale duplicate confirmation.",
    })).resolves.toEqual({ state: "conflict" });

    const persisted = await admin.query(`
      SELECT inbound.match_status AS "matchStatus",
             candidate.requires_manual_confirmation AS "requiresManual",
             audit.actor_id AS "actorId", audit.reason,
             audit.before_redacted AS "beforeRedacted",
             audit.after_redacted AS "afterRedacted",
             lifecycle.event_type AS "eventType",
             lifecycle.after_state AS "assignmentFact",
             lifecycle.event_schema_version AS "eventSchemaVersion"
        FROM backlinks.backlink_inbound_messages AS inbound
        JOIN backlinks.backlink_reply_match_candidates AS candidate
          ON candidate.inbound_message_id = inbound.id
        JOIN backlinks.backlink_audit_events AS audit
          ON audit.target_id = candidate.id
        JOIN backlinks.backlink_lifecycle_events AS lifecycle
          ON lifecycle.id = audit.lifecycle_event_id
       WHERE inbound.id = '${inboundA}'
         AND audit.action = 'reply_match_candidate.confirmed'
    `);
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({
      matchStatus: "MATCH_CONFIRMED",
      requiresManual: false,
      actorId: "user-135",
      reason: "Verified against the original outreach thread.",
      eventType: "reply.assignment.recorded",
      eventSchemaVersion: 1,
      beforeRedacted: {
        matchStatus: "CANDIDATES_READY",
        requiresManualConfirmation: true,
      },
      afterRedacted: {
        matchStatus: "MATCH_CONFIRMED",
        opportunityId: opportunityA,
        requiresManualConfirmation: false,
        ruleVersion: "reply-matcher-v1",
      },
      assignmentFact: {
        inboundMessageId: inboundA,
        providerMessageId: "provider-message-100",
        providerThreadId: "provider-thread-100",
        matchCandidateId: candidate.id,
        opportunityId: opportunityA,
        matchAuthority: "MANUAL",
        confidence: 0.25,
        ruleVersion: "reply-matcher-v1",
        actorId: "user-135",
        contractVersion: "reply-assignment-fact.v1",
      },
    });
    expect(Number.isFinite(new Date(String(
      (persisted.rows[0]?.assignmentFact as Record<string, unknown>).occurredAt,
    )).getTime())).toBe(true);
    expect((await admin.query(`
      SELECT count(*)::integer AS count
      FROM backlinks.backlink_lifecycle_events
      WHERE event_type = 'reply.assignment.recorded'
        AND aggregate_id = '${inboundA}'
    `)).rows).toEqual([{ count: 1 }]);

    await expect(repo.unbindCandidate({
      organizationId,
      workspaceId,
      websiteProjectId: projectA,
      inboundMessageId: inboundA,
      expectedMatchStatus: "MATCH_CONFIRMED",
      actorId: "user-135",
      requestId: "request-135-unbind",
      reason: "The reply belongs to a different outreach thread.",
    })).resolves.toMatchObject({
      state: "unbound",
      candidateId: candidate.id,
      opportunityId: opportunityA,
      matchStatus: "CANDIDATES_READY",
    });

    const afterUnbind = await admin.query(`
      SELECT inbound.match_status AS "matchStatus",
             candidate.requires_manual_confirmation AS "requiresManual",
             opportunity.business_stage AS "businessStage",
             audit.action AS "auditAction",
             audit.reason,
             lifecycle.event_type AS "eventType",
             lifecycle.after_state AS "revocationFact"
      FROM backlinks.backlink_inbound_messages AS inbound
      JOIN backlinks.backlink_reply_match_candidates AS candidate
        ON candidate.inbound_message_id = inbound.id
       AND candidate.id = '${candidate.id}'
      JOIN backlinks.backlink_opportunities AS opportunity
        ON opportunity.id = candidate.opportunity_id
      JOIN backlinks.backlink_audit_events AS audit
        ON audit.target_id = candidate.id
       AND audit.action = 'reply_match_candidate.unbound'
      JOIN backlinks.backlink_lifecycle_events AS lifecycle
        ON lifecycle.id = audit.lifecycle_event_id
      WHERE inbound.id = '${inboundA}'
    `);
    expect(afterUnbind.rows).toHaveLength(1);
    expect(afterUnbind.rows[0]).toMatchObject({
      matchStatus: "CANDIDATES_READY",
      requiresManual: true,
      businessStage: stageBefore,
      auditAction: "reply_match_candidate.unbound",
      reason: "The reply belongs to a different outreach thread.",
      eventType: "reply.assignment.revoked",
      revocationFact: {
        inboundMessageId: inboundA,
        matchCandidateId: candidate.id,
        opportunityId: opportunityA,
        actorId: "user-135",
        contractVersion: "reply-assignment-revocation-fact.v1",
      },
    });
    expect((await admin.query(`
      SELECT count(*)::integer AS count
      FROM backlinks.backlink_lifecycle_events
      WHERE event_type = 'reply.assignment.revoked'
        AND aggregate_id = '${inboundA}'
    `)).rows).toEqual([{ count: 1 }]);
  });

  it("writes the same assignment fact for AUTO and deduplicates retries", async () => {
    const repo = repository();
    const input = {
      organizationId,
      workspaceId,
      websiteProjectId: projectB,
      gmailConnectionId,
      inboundMessageId: inboundB,
      actorId: "reply-matcher-135",
      result: {
        decision: "AUTO_MATCHED" as const,
        confidence: "HIGH" as const,
        matchedOpportunityId: opportunityB,
        matchedMailThreadId: id(207),
        ruleVersion: "reply-matcher-v1" as const,
        candidates: [{
          opportunityId: opportunityB,
          mailThreadId: id(207),
          confidence: "HIGH" as const,
          requiresManualConfirmation: false,
          evidence: [{
            kind: "PROVIDER_THREAD_EXACT" as const,
            providerThreadId: "provider-thread-200",
          }],
        }],
      },
    };
    await expect(repo.saveMatchResult(input)).resolves.toMatchObject({
      state: "saved",
      matchStatus: "MATCH_CONFIRMED",
    });
    await expect(repo.saveMatchResult(input)).resolves.toEqual({
      state: "conflict",
    });

    const persisted = (await admin.query(`
      SELECT lifecycle.after_state AS "assignmentFact",
        audit.action AS "auditAction",
        inbound.match_status AS "matchStatus",
        candidate.requires_manual_confirmation AS "requiresManual"
      FROM backlinks.backlink_lifecycle_events lifecycle
      JOIN backlinks.backlink_audit_events audit
        ON audit.lifecycle_event_id = lifecycle.id
      JOIN backlinks.backlink_inbound_messages inbound
        ON inbound.id = lifecycle.aggregate_id
      JOIN backlinks.backlink_reply_match_candidates candidate
        ON candidate.inbound_message_id = inbound.id
       AND candidate.id =
         (lifecycle.after_state->>'matchCandidateId')::uuid
      WHERE lifecycle.event_type = 'reply.assignment.recorded'
        AND lifecycle.aggregate_id = '${inboundB}'
    `)).rows;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      auditAction: "reply.assignment.recorded",
      matchStatus: "MATCH_CONFIRMED",
      requiresManual: false,
      assignmentFact: {
        inboundMessageId: inboundB,
        providerMessageId: "provider-message-200",
        providerThreadId: "provider-thread-200",
        opportunityId: opportunityB,
        matchAuthority: "AUTO",
        confidence: 1,
        ruleVersion: "reply-matcher-v1",
        actorId: "reply-matcher-135",
        contractVersion: "reply-assignment-fact.v1",
      },
    });
  });

  it("does not write an assignment fact for an UNMATCHED result", async () => {
    await expect(repository().saveMatchResult({
      organizationId,
      workspaceId,
      websiteProjectId: projectC,
      gmailConnectionId,
      inboundMessageId: inboundC,
      actorId: "reply-matcher-135",
      result: {
        decision: "UNMATCHED",
        confidence: "NONE",
        matchedOpportunityId: null,
        matchedMailThreadId: null,
        ruleVersion: "reply-matcher-v1",
        candidates: [],
      },
    })).resolves.toMatchObject({
      state: "saved",
      matchStatus: "UNMATCHED",
      candidates: [],
    });

    expect((await admin.query(`
      SELECT inbound.match_status AS "matchStatus",
        (SELECT count(*)::integer
          FROM backlinks.backlink_lifecycle_events lifecycle
          WHERE lifecycle.aggregate_id = '${inboundC}'
            AND lifecycle.event_type = 'reply.assignment.recorded')
          AS "factCount",
        (SELECT count(*)::integer
          FROM backlinks.backlink_audit_events audit
          WHERE audit.target_id = '${inboundC}'
            AND audit.action = 'reply.assignment.recorded')
          AS "auditCount"
      FROM backlinks.backlink_inbound_messages inbound
      WHERE inbound.id = '${inboundC}'
    `)).rows).toEqual([{
      matchStatus: "UNMATCHED",
      factCount: 0,
      auditCount: 0,
    }]);
  });

  it("rolls back automatic assignment when fact persistence fails", async () => {
    await admin.query(`
      CREATE FUNCTION backlinks.fail_reply_assignment_fact() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.event_type = 'reply.assignment.recorded'
           AND NEW.aggregate_id = '${inboundC}'::uuid THEN
          RAISE EXCEPTION 'forced reply assignment fact failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_reply_assignment_fact
      BEFORE INSERT ON backlinks.backlink_lifecycle_events
      FOR EACH ROW EXECUTE FUNCTION backlinks.fail_reply_assignment_fact();
    `);
    try {
      await expect(repository().saveMatchResult({
        organizationId,
        workspaceId,
        websiteProjectId: projectC,
        gmailConnectionId,
        inboundMessageId: inboundC,
        actorId: "reply-matcher-135",
        result: {
          decision: "AUTO_MATCHED",
          confidence: "HIGH",
          matchedOpportunityId: opportunityC,
          matchedMailThreadId: id(307),
          ruleVersion: "reply-matcher-v1",
          candidates: [{
            opportunityId: opportunityC,
            mailThreadId: id(307),
            confidence: "HIGH",
            requiresManualConfirmation: false,
            evidence: [{
              kind: "PROVIDER_THREAD_EXACT",
              providerThreadId: "provider-thread-300",
            }],
          }],
        },
      })).rejects.toThrow("forced reply assignment fact failure");
    } finally {
      await admin.query(`
        DROP TRIGGER fail_reply_assignment_fact
          ON backlinks.backlink_lifecycle_events;
        DROP FUNCTION backlinks.fail_reply_assignment_fact();
      `);
    }

    expect((await admin.query(`
      SELECT inbound.match_status AS "matchStatus",
        (SELECT count(*)::integer
          FROM backlinks.backlink_reply_match_candidates candidate
          WHERE candidate.inbound_message_id = '${inboundC}')
          AS "candidateCount",
        (SELECT count(*)::integer
          FROM backlinks.backlink_lifecycle_events lifecycle
          WHERE lifecycle.aggregate_id = '${inboundC}'
            AND lifecycle.event_type = 'reply.assignment.recorded')
          AS "factCount",
        (SELECT count(*)::integer
          FROM backlinks.backlink_audit_events audit
          WHERE audit.target_id = '${inboundC}'
            AND audit.action = 'reply.assignment.recorded')
          AS "auditCount"
      FROM backlinks.backlink_inbound_messages inbound
      WHERE inbound.id = '${inboundC}'
    `)).rows).toEqual([{
      matchStatus: "UNMATCHED",
      candidateCount: 0,
      factCount: 0,
      auditCount: 0,
    }]);
  });
});
