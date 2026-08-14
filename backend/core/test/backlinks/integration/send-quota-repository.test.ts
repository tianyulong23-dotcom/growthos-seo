import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GmailDailyQuotaExceededError,
  PostgresqlGmailDailyQuotaRepository,
} from "../../../src/modules/backlinks/application/services/send-quota.repository.js";
import {
  PostgresqlSendIntentRepository,
  type CreateSendIntentRecordInput,
} from "../../../src/modules/backlinks/application/services/send-intent.repository.js";
import {
  PostgresqlSendAttemptRepository,
} from "../../../src/modules/backlinks/application/services/send-attempt.repository.js";
import {
  PostgresqlSendReconciliationRepository,
} from "../../../src/modules/backlinks/application/services/send-reconciliation.repository.js";
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

type RuntimePool = BacklinkTenantPool & {
  end(): Promise<void>;
};

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
const firstProjectId = id(3);
const secondProjectId = id(4);
const gmailConnectionId = id(701);
const secondGmailConnectionId = id(704);
const gmailIdentityId = id(703);
const secondGmailIdentityId = id(706);
const firstContext = {
  organizationId,
  workspaceId,
  websiteProjectId: firstProjectId,
};
const secondContext = {
  organizationId,
  workspaceId,
  websiteProjectId: secondProjectId,
};
const scopes =
  '["openid","email","profile",' +
  '"https://www.googleapis.com/auth/gmail.send"]';
const intentIds = Array.from({ length: 24 }, (_, index) => id(800 + index));
const atomicIntentIds = Array.from({ length: 16 }, (_, index) => id(900 + index));
const atomicReservationIds =
  Array.from({ length: 16 }, (_, index) => id(920 + index));
const atomicOutboxIds =
  Array.from({ length: 16 }, (_, index) => id(940 + index));
const atomicSnapshotIds =
  Array.from({ length: 16 }, (_, index) => id(960 + index));

describe("BL-AI-109 PostgreSQL Gmail daily quota repository", () => {
  const loginRole = `bl_ai_109_${process.pid}_${Date.now()}`;
  const password = randomBytes(24).toString("base64url");
  let harness: BacklinksPostgresHarness;
  let admin: RuntimeClient;
  let tenantPool: RuntimePool;
  let publishedPolicies: readonly Record<string, unknown>[];
  let forwardPolicies: readonly Record<string, unknown>[];

  const insertProjectFixture = async (
    websiteProjectId: string,
    seed: number,
    hostname: string,
  ): Promise<void> => {
    const prospectId = id(seed + 1);
    const contextVersionId = id(seed + 2);
    const recommendationId = id(seed + 3);
    const opportunityId = id(seed + 4);
    const evidenceId = id(seed + 5);
    const draftId = id(seed + 6);
    const draftVersionId = id(seed + 7);
    const contactCandidateId = id(seed + 8);
    const contactId = id(seed + 9);
    await admin.query(
      `INSERT INTO backlinks.backlink_prospects (
         id, organization_id, workspace_id, website_project_id,
         recommendation_context_version_id, hostname_ascii,
         registrable_domain, normalization_version, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $6, 'tldts-7.4.9-v1', 'test', 'test'
       )`,
      [
        prospectId,
        organizationId,
        workspaceId,
        websiteProjectId,
        contextVersionId,
        hostname,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_recommendations (
         id, organization_id, workspace_id, website_project_id, prospect_id,
         recommendation_context_version_id, status, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'accepted', 'test', 'test'
       )`,
      [
        recommendationId,
        organizationId,
        workspaceId,
        websiteProjectId,
        prospectId,
        contextVersionId,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_opportunities (
         id, organization_id, workspace_id, website_project_id,
         recommendation_id, prospect_id, recommendation_context_version_id,
         target_site_key, target_host_ascii, target_identity_rule_version,
         join_sequence, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $8, 'tldts-7.4.9-v1', 1,
         'test', 'test'
       )`,
      [
        opportunityId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationId,
        prospectId,
        contextVersionId,
        hostname,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_contact_candidates (
         id, organization_id, workspace_id, website_project_id, prospect_id,
         recommendation_context_version_id, normalized_email,
         email_domain_ascii, domain_relation, syntax_validator_version,
         confidence, guessed, status, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         'same_registrable_domain', 'validator.v1', 100, false, 'promoted',
         'test', 'test'
       )`,
      [
        contactCandidateId,
        organizationId,
        workspaceId,
        websiteProjectId,
        prospectId,
        contextVersionId,
        `recipient-${seed}@${hostname}`,
        hostname,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_contacts (
         id, organization_id, workspace_id, website_project_id, prospect_id,
         recommendation_context_version_id, source_candidate_id,
         normalized_email, contact_role, confidence, guessed,
         confirmed_at, confirmed_by, status, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'editorial', 100, false,
         statement_timestamp(), 'test', 'active', 'test', 'test'
       )`,
      [
        contactId,
        organizationId,
        workspaceId,
        websiteProjectId,
        prospectId,
        contextVersionId,
        contactCandidateId,
        `recipient-${seed}@${hostname}`,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_evidence_snapshots (
         id, organization_id, workspace_id, website_project_id,
         opportunity_id, evidence_items, snapshot_hash, schema_version,
         created_by
       ) VALUES (
         $1, $2, $3, $4, $5, '[{"id":"quota:1"}]', $6, 1, 'test'
       )`,
      [
        evidenceId,
        organizationId,
        workspaceId,
        websiteProjectId,
        opportunityId,
        "a".repeat(64),
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_email_drafts (
         id, organization_id, workspace_id, website_project_id,
         opportunity_id, logical_draft_key, status, contact_id,
         contact_version, created_by, updated_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 'draft', $7, 1, 'test', 'test'
       )`,
      [
        draftId,
        organizationId,
        workspaceId,
        websiteProjectId,
        opportunityId,
        `quota-draft-${seed}`,
        contactId,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_draft_versions (
         id, organization_id, workspace_id, website_project_id, draft_id,
         opportunity_id, version_no, source, evidence_snapshot_id,
         subject_text, body_text, structured_output, evidence_ids,
         prompt_version, output_schema_version, contact_id, contact_version,
         created_by
       ) VALUES (
         $1, $2, $3, $4, $5, $6, 1, 'MANUAL', $7,
         'Approved subject', 'Approved body', '{}', '[]',
         'manual.v1', 'manual.v1', $8, 1, 'test'
       )`,
      [
        draftVersionId,
        organizationId,
        workspaceId,
        websiteProjectId,
        draftId,
        opportunityId,
        evidenceId,
        contactId,
      ],
    );
    await admin.query(
      `UPDATE backlinks.backlink_email_drafts
          SET status = 'approved',
              current_version_id = $1,
              approved_version_id = $1,
              version = 2,
              updated_at = statement_timestamp(),
              updated_by = 'test'
        WHERE id = $2`,
      [draftVersionId, draftId],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_lifecycle_events (
         id, organization_id, workspace_id, website_project_id,
         aggregate_type, aggregate_id, sequence, aggregate_version,
         event_type, actor_type, actor_id, after_state, reason,
         correlation_id, idempotency_key
       ) VALUES (
         $1, $2, $3, $4, 'email_draft', $5, 1, 2,
         'draft.approval.recorded', 'user', 'test',
         jsonb_build_object(
           'approvedVersionId', $6::text,
           'occurredAt', statement_timestamp()
         ),
         'test approval', $7, $8
       )`,
      [
        id(seed + 10),
        organizationId,
        workspaceId,
        websiteProjectId,
        draftId,
        draftVersionId,
        `quota-approval-${seed}`,
        `quota-approval:${seed}`,
      ],
    );
  };

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
    ]) {
      await admin.query(await readFile(migration(name), "utf8"));
    }
    publishedPolicies = (
      await admin.query(
        `SELECT policyname AS "policyName", cmd
         FROM pg_policies
        WHERE schemaname = 'backlinks'
          AND tablename = 'backlink_rate_limit_reservations'
        ORDER BY policyname`,
      )
    ).rows;
    for (const name of [
      "0022_backlink_draft_documents.sql",
      "0023_backlink_send_quota_connection_scope.sql",
      "0024_backlink_send_attempt_settlement.sql",
      "0025_backlink_send_reconciliation.sql",
      "0033_backlink_runtime_governance.sql",
      "0035_backlink_contact_send_snapshots.sql",
      "0041_backlink_gmail_project_bindings.sql",
    ]) {
      await admin.query(await readFile(migration(name), "utf8"));
    }
    forwardPolicies = (
      await admin.query(
        `SELECT policyname AS "policyName", cmd
         FROM pg_policies
        WHERE schemaname = 'backlinks'
          AND tablename = 'backlink_rate_limit_reservations'
        ORDER BY policyname`,
      )
    ).rows;
    await admin.query(`
      CREATE ROLE "${loginRole}"
      LOGIN PASSWORD '${password}'
      NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;
      GRANT growthos_backlinks_writer TO "${loginRole}";
    `);

    await insertProjectFixture(firstProjectId, 100, "first.example");
    await insertProjectFixture(secondProjectId, 200, "second.example");
    await admin.query(
      `INSERT INTO backlinks.backlink_secret_references (
         id, organization_id, provider, secret_kind, external_secret_id,
         external_secret_version, created_by, updated_by
       ) VALUES
       (
         $1, $2, 'gcp-secret-manager', 'GMAIL_TOKEN_SET',
         'projects/test/secrets/gmail-token-quota', '1', 'test', 'test'
       ),
       (
         $3, $2, 'gcp-secret-manager', 'GMAIL_TOKEN_SET',
         'projects/test/secrets/gmail-token-quota-second', '1', 'test', 'test'
       )`,
      [id(700), organizationId, id(705)],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_gmail_connections (
         id, organization_id, connected_by_user_id, google_subject,
         primary_email, granted_scopes, token_secret_reference_id,
         token_expires_at, created_by, updated_by
       ) VALUES
       (
         $1, $2, 'user-quota', 'google-subject-quota',
         'quota-sender@example.test', $3::jsonb, $4,
         statement_timestamp() + interval '1 hour', 'test', 'test'
       ),
       (
         $5, $2, 'user-quota', 'google-subject-quota-second',
         'quota-sender-second@example.test', $3::jsonb, $6,
         statement_timestamp() + interval '1 hour', 'test', 'test'
       )`,
      [
        gmailConnectionId,
        organizationId,
        scopes,
        id(700),
        secondGmailConnectionId,
        id(705),
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_gmail_workspace_bindings (
         id, organization_id, workspace_id, website_project_id,
         gmail_connection_id,
         binding_status, is_primary, created_by, updated_by
       ) VALUES
       (
         $1, $2, $3, $4, $5, 'ACTIVE', true, 'test', 'test'
       ),
       (
         $6, $2, $3, $7, $8, 'ACTIVE', true, 'test', 'test'
       )`,
      [
        id(702),
        organizationId,
        workspaceId,
        firstProjectId,
        gmailConnectionId,
        id(707),
        secondProjectId,
        secondGmailConnectionId,
      ],
    );
    await admin.query(
      `INSERT INTO backlinks.backlink_gmail_send_identities (
         id, organization_id, gmail_connection_id, normalized_email,
         is_primary, is_default, verification_status, treat_as_alias,
         source, observed_at, created_by, updated_by
       ) VALUES
       (
         $1, $2, $3, 'quota-sender@example.test',
         true, true, 'accepted', false, 'OIDC_PRIMARY',
         statement_timestamp(), 'test', 'test'
       ),
       (
         $4, $2, $5, 'quota-sender-second@example.test',
         true, true, 'accepted', false, 'OIDC_PRIMARY',
         statement_timestamp(), 'test', 'test'
       )`,
      [
        gmailIdentityId,
        organizationId,
        gmailConnectionId,
        secondGmailIdentityId,
        secondGmailConnectionId,
      ],
    );
    for (const name of [
      "0047_backlink_gmail_organization_reuse.sql",
      "0048_backlink_draft_request_snapshots.sql",
      "0049_backlink_gmail_send_reply_loop.sql",
    ]) {
      await admin.query(await readFile(migration(name), "utf8"));
    }
    await admin.query(
      `INSERT INTO backlinks.backlink_kill_switch_versions (
         id, organization_id, workspace_id, website_project_id,
         layer, capability, provider, version, blocked, reason, created_by
       ) VALUES
       (
         $1, $2, $3, $4, 'project', 'GMAIL_SEND', NULL, 1, false,
         'integration test send preflight enabled', 'test'
       ),
       (
         $5, $2, $3, $6, 'project', 'GMAIL_SEND', NULL, 1, false,
         'integration test send preflight enabled', 'test'
       )`,
      [
        id(708),
        organizationId,
        workspaceId,
        firstProjectId,
        id(709),
        secondProjectId,
      ],
    );

    for (const [index, sendIntentId] of intentIds.entries()) {
      const websiteProjectId =
        index % 2 === 0 ? firstProjectId : secondProjectId;
      const connectionId =
        index % 2 === 0 ? gmailConnectionId : secondGmailConnectionId;
      const fixtureSeed = index % 2 === 0 ? 100 : 200;
      await admin.query(
        `INSERT INTO backlinks.backlink_send_intents (
           id, organization_id, workspace_id, website_project_id,
           opportunity_id, draft_id, approved_draft_version_id,
           gmail_connection_id, client_idempotency_key, logical_message_key,
           message_purpose, follow_up_index, requested_send_at,
           created_by, updated_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           'INITIAL_OUTREACH', 0, statement_timestamp(), 'test', 'test'
         )`,
        [
          sendIntentId,
          organizationId,
          workspaceId,
          websiteProjectId,
          id(fixtureSeed + 4),
          id(fixtureSeed + 6),
          id(fixtureSeed + 7),
          connectionId,
          `quota-client-${index}`,
          index.toString(16).padStart(64, "0"),
        ],
      );
    }

    const tenantUrl = new URL(harness.connectionString);
    tenantUrl.username = loginRole;
    tenantUrl.password = password;
    tenantPool = new PgPool({
      connectionString: tenantUrl.toString(),
      max: 24,
    });
  }, 120_000);

  beforeEach(async () => {
    await admin.query("TRUNCATE backlinks.backlink_send_reconciliations");
    await admin.query("TRUNCATE backlinks.backlink_rate_limit_reservations");
    await admin.query("TRUNCATE backlinks.backlink_send_snapshots");
    await admin.query(
      `DELETE FROM backlinks.backlink_outbox_events
        WHERE id = ANY($1::uuid[])`,
      [atomicOutboxIds],
    );
    await admin.query(
      `DELETE FROM backlinks.backlink_send_intents
        WHERE id = ANY($1::uuid[])`,
      [atomicIntentIds],
    );
  });

  afterAll(async () => {
    await tenantPool?.end();
    if (admin !== undefined) {
      await admin.query(`DROP OWNED BY "${loginRole}"`);
      await admin.query(`DROP ROLE IF EXISTS "${loginRole}"`);
      await admin.end();
    }
    await harness?.stop();
  });

  const repository = () =>
    new PostgresqlGmailDailyQuotaRepository({ pool: tenantPool });

  const reserveInput = (
    index: number,
    dailyLimit: number,
    reservedAt: Date,
  ) => ({
    ...(index % 2 === 0 ? firstContext : secondContext),
    sendIntentId: intentIds[index] ?? "",
    gmailConnectionId:
      index % 2 === 0 ? gmailConnectionId : secondGmailConnectionId,
    dailyLimit,
    reservedAt,
    eligibleAt: reservedAt,
    expiresAt: new Date(reservedAt.getTime() + 10 * 60_000),
    actorId: "user-bl-ai-109",
  });
  const atomicInput = (
    index: number,
    overrides: Partial<CreateSendIntentRecordInput> = {},
  ): CreateSendIntentRecordInput => ({
    ...firstContext,
    sendIntentId: atomicIntentIds[index] ?? "",
    sendSnapshotId: atomicSnapshotIds[index] ?? "",
    quotaReservationId: atomicReservationIds[index] ?? "",
    outboxEventId: atomicOutboxIds[index] ?? "",
    draftId: id(106),
    approvedDraftVersionId: id(107),
    contactId: id(109),
    contactVersion: 1,
    gmailConnectionId,
    clientIdempotencyKey: `atomic-client-${index}`,
    logicalMessageKey: (1000 + index).toString(16).padStart(64, "0"),
    messagePurpose: "INITIAL_OUTREACH",
    followUpIndex: 0,
    requestedSendAt: new Date("2026-07-27T10:15:00.000Z"),
    rolling24HourSendLimit: 5,
    minimumIntervalSeconds: 300,
    reservationTtlSeconds: 600,
    actorId: "user-bl-ai-115",
    ...overrides,
  });

  it("upgrades the published 0014 quota policy through forward migration 0023", () => {
    expect(publishedPolicies).toEqual([
      {
        policyName: "backlink_rate_limit_reservation_tenant_policy",
        cmd: "ALL",
      },
    ]);
    expect(forwardPolicies).toEqual([
      {
        policyName: "backlink_rate_limit_reservation_insert_policy",
        cmd: "INSERT",
      },
      {
        policyName: "backlink_rate_limit_reservation_select_policy",
        cmd: "SELECT",
      },
      {
        policyName: "backlink_rate_limit_reservation_update_policy",
        cmd: "UPDATE",
      },
    ]);
  });

  it("claims once, persists the Gmail Message ID, and replays without another Attempt", async () => {
    const now = new Date();
    const sendIntentId = intentIds[20] ?? "";
    const attemptId = id(1180);
    await repository().reserve(reserveInput(20, 5, now));
    const attempts = new PostgresqlSendAttemptRepository({
      pool: tenantPool,
      newId: () => attemptId,
    });
    const claimInput = {
      ...firstContext,
      gmailConnectionId,
      sendIntentId,
      maxAttempts: 3,
      claimedAt: new Date(now.getTime() + 1_000),
      actorId: "worker-bl-ai-118",
    };

    const claimed = await attempts.claim(claimInput);
    expect(claimed).toEqual({
      state: "claimed",
      attempt: {
        sendIntentId,
        attemptId,
        attemptNo: 1,
        fencingToken: 1,
        rfcMessageId:
          `<${sendIntentId}.1@send.growthos.invalid>`,
      },
    });
    if (claimed.state !== "claimed") {
      throw new Error("Expected a claimed Send Attempt.");
    }

    await expect(attempts.settle({
      ...firstContext,
      gmailConnectionId,
      actorId: "worker-bl-ai-118",
      ...claimed.attempt,
      status: "PROVIDER_ACCEPTED",
      providerMessageId: "gmail-message-118",
      providerThreadId: "gmail-thread-118",
      errorCode: null,
      completedAt: new Date(now.getTime() + 2_000),
      retryEligibleAt: null,
    })).resolves.toEqual({
      state: "completed",
      providerMessageId: "gmail-message-118",
      providerThreadId: "gmail-thread-118",
      rfcMessageId: claimed.attempt.rfcMessageId,
    });
    await expect(attempts.claim({
      ...claimInput,
      claimedAt: new Date(now.getTime() + 3_000),
    })).resolves.toEqual({
      state: "already_completed",
      providerMessageId: "gmail-message-118",
      providerThreadId: "gmail-thread-118",
      rfcMessageId: claimed.attempt.rfcMessageId,
    });

    expect((await admin.query(
      `SELECT
         attempt.status,
         attempt.provider_message_id AS "providerMessageId",
         attempt.provider_thread_id AS "providerThreadId",
         reservation.status AS "reservationStatus"
       FROM backlinks.backlink_send_attempts AS attempt
       JOIN backlinks.backlink_rate_limit_reservations AS reservation
         ON reservation.send_intent_id = attempt.send_intent_id
      WHERE attempt.send_intent_id = $1`,
      [sendIntentId],
    )).rows).toEqual([{
      status: "PROVIDER_ACCEPTED",
      providerMessageId: "gmail-message-118",
      providerThreadId: "gmail-thread-118",
      reservationStatus: "CONSUMED",
    }]);
    await expect(admin.query(
      `UPDATE backlinks.backlink_send_attempts
          SET provider_message_id = 'gmail-message-mutated'
        WHERE id = $1`,
      [attemptId],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("persists retry eligibility and never retries an unknown acceptance", async () => {
    const now = new Date();
    const retryIntentId = intentIds[21] ?? "";
    const unknownIntentId = intentIds[22] ?? "";
    await repository().reserve(reserveInput(21, 5, now));
    await repository().reserve(reserveInput(22, 5, now));
    const ids = [id(1181), id(1182), id(1183)];
    const attempts = new PostgresqlSendAttemptRepository({
      pool: tenantPool,
      newId: () => ids.shift() ?? id(1199),
    });
    const retryContext = {
      ...secondContext,
      gmailConnectionId: secondGmailConnectionId,
      sendIntentId: retryIntentId,
      maxAttempts: 3,
      actorId: "worker-bl-ai-118",
    };
    const firstClaim = await attempts.claim({
      ...retryContext,
      claimedAt: new Date(now.getTime() + 1_000),
    });
    if (firstClaim.state !== "claimed") {
      throw new Error("Expected the first retryable Attempt.");
    }
    await attempts.settle({
      ...secondContext,
      gmailConnectionId: secondGmailConnectionId,
      actorId: "worker-bl-ai-118",
      ...firstClaim.attempt,
      status: "FAILED_RETRYABLE",
      providerMessageId: null,
      providerThreadId: null,
      errorCode: "GMAIL_SEND_RATE_LIMITED",
      completedAt: new Date(now.getTime() + 2_000),
      retryEligibleAt: new Date(now.getTime() + 32_000),
    });
    await expect(attempts.claim({
      ...retryContext,
      claimedAt: new Date(now.getTime() + 12_000),
    })).resolves.toEqual({
      state: "wait",
      retryAfterSeconds: 20,
    });
    await expect(attempts.claim({
      ...retryContext,
      claimedAt: new Date(now.getTime() + 33_000),
    })).resolves.toMatchObject({
      state: "claimed",
      attempt: {
        sendIntentId: retryIntentId,
        attemptNo: 2,
        fencingToken: 2,
      },
    });

    const unknownContext = {
      ...firstContext,
      gmailConnectionId,
      sendIntentId: unknownIntentId,
      maxAttempts: 3,
      actorId: "worker-bl-ai-118",
    };
    const unknownClaim = await attempts.claim({
      ...unknownContext,
      claimedAt: new Date(now.getTime() + 1_000),
    });
    if (unknownClaim.state !== "claimed") {
      throw new Error("Expected the unknown-delivery Attempt.");
    }
    await attempts.settle({
      ...firstContext,
      gmailConnectionId,
      actorId: "worker-bl-ai-118",
      ...unknownClaim.attempt,
      status: "DELIVERY_UNKNOWN",
      providerMessageId: null,
      providerThreadId: null,
      errorCode: "GMAIL_SEND_TIMEOUT",
      completedAt: new Date(now.getTime() + 2_000),
      retryEligibleAt: null,
    });
    await expect(attempts.claim({
      ...unknownContext,
      claimedAt: new Date(now.getTime() + 60_000),
    })).resolves.toEqual({
      state: "reconciliation_required",
      attemptId: unknownClaim.attempt.attemptId,
      rfcMessageId: unknownClaim.attempt.rfcMessageId,
      status: "DELIVERY_UNKNOWN",
      errorCode: "GMAIL_SEND_TIMEOUT",
    });
  });

  it("appends a reconciliation fact, ends the Intent, and retains the unknown Attempt quota", async () => {
    const now = new Date();
    const sendIntentId = intentIds[23] ?? "";
    const attemptId = id(1184);
    const reconciliationId = id(1284);
    await repository().reserve(reserveInput(23, 5, now));
    const attempts = new PostgresqlSendAttemptRepository({
      pool: tenantPool,
      newId: () => attemptId,
    });
    const claimed = await attempts.claim({
      ...secondContext,
      gmailConnectionId: secondGmailConnectionId,
      sendIntentId,
      maxAttempts: 3,
      claimedAt: new Date(now.getTime() + 1_000),
      actorId: "worker-bl-ai-118",
    });
    if (claimed.state !== "claimed") {
      throw new Error("Expected the unknown-delivery Attempt.");
    }
    await attempts.settle({
      ...secondContext,
      gmailConnectionId: secondGmailConnectionId,
      actorId: "worker-bl-ai-118",
      ...claimed.attempt,
      status: "DELIVERY_UNKNOWN",
      providerMessageId: null,
      providerThreadId: null,
      errorCode: "GMAIL_SEND_TIMEOUT",
      completedAt: new Date(now.getTime() + 2_000),
      retryEligibleAt: null,
    });
    const reconciliations = new PostgresqlSendReconciliationRepository({
      pool: tenantPool,
      newId: () => reconciliationId,
    });
    const context = {
      ...secondContext,
      gmailConnectionId: secondGmailConnectionId,
      actorId: "operator-bl-ai-119",
      sendIntentId,
    };

    await expect(reconciliations.load(context)).resolves.toEqual({
      state: "pending",
      attempt: {
        sendIntentId,
        attemptId,
        rfcMessageId: claimed.attempt.rfcMessageId,
        errorCode: "GMAIL_SEND_TIMEOUT",
      },
    });
    await expect(reconciliations.reconcile({
      ...context,
      attempt: {
        sendIntentId,
        attemptId,
        rfcMessageId: claimed.attempt.rfcMessageId,
        errorCode: "GMAIL_SEND_TIMEOUT",
      },
      decision: {
        outcome: "PROVIDER_ACCEPTED",
        providerMessageId: "gmail-message-119",
        providerThreadId: "gmail-thread-119",
        evidenceReference: "gmail:message/gmail-message-119",
      },
      reconciledAt: new Date(now.getTime() + 3_000),
    })).resolves.toEqual({
      outcome: "completed",
      providerMessageId: "gmail-message-119",
      providerThreadId: "gmail-thread-119",
      rfcMessageId: claimed.attempt.rfcMessageId,
    });
    await expect(reconciliations.load(context)).resolves.toEqual({
      state: "reconciled",
      outcome: "completed",
      providerMessageId: "gmail-message-119",
      providerThreadId: "gmail-thread-119",
      rfcMessageId: claimed.attempt.rfcMessageId,
    });
    await expect(reconciliations.reconcile({
      ...context,
      attempt: {
        sendIntentId,
        attemptId,
        rfcMessageId: claimed.attempt.rfcMessageId,
        errorCode: "GMAIL_SEND_TIMEOUT",
      },
      decision: {
        outcome: "CONFIRMED_NOT_SENT",
        evidenceReference: "case:conflicting-decision",
      },
      reconciledAt: new Date(now.getTime() + 4_000),
    })).rejects.toThrow("Send result has already been reconciled.");

    expect((await admin.query(
      `SELECT
         attempt.status AS "attemptStatus",
         intent.status AS "intentStatus",
         reservation.status AS "reservationStatus",
         reconciliation.outcome,
         reconciliation.provider_message_id AS "providerMessageId"
       FROM backlinks.backlink_send_attempts AS attempt
       JOIN backlinks.backlink_send_intents AS intent
         ON intent.id = attempt.send_intent_id
       JOIN backlinks.backlink_rate_limit_reservations AS reservation
         ON reservation.send_intent_id = intent.id
       JOIN backlinks.backlink_send_reconciliations AS reconciliation
         ON reconciliation.send_attempt_id = attempt.id
      WHERE attempt.id = $1`,
      [attemptId],
    )).rows).toEqual([{
      attemptStatus: "DELIVERY_UNKNOWN",
      intentStatus: "PROVIDER_ACCEPTED",
      reservationStatus: "CONSUMED",
      outcome: "PROVIDER_ACCEPTED",
      providerMessageId: "gmail-message-119",
    }]);
    await expect(admin.query(
      `UPDATE backlinks.backlink_send_reconciliations
          SET evidence_reference = 'mutated'
        WHERE id = $1`,
      [reconciliationId],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("serializes each project connection without sharing quota lanes", async () => {
    const repo = repository();
    const reservedAt = new Date("2026-07-27T08:00:00.000Z");
    const outcomes = await Promise.allSettled(
      intentIds
        .slice(0, 20)
        .map((_, index) => repo.reserve(reserveInput(index, 5, reservedAt))),
    );
    const fulfilled = outcomes.flatMap((outcome) =>
      outcome.status === "fulfilled" ? [outcome.value] : [],
    );
    const rejected = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );

    expect(fulfilled).toHaveLength(10);
    expect(rejected).toHaveLength(10);
    expect(
      rejected.every((error) => error instanceof GmailDailyQuotaExceededError),
    ).toBe(true);
    expect(
      fulfilled
        .map(({ laneSequence }) => laneSequence)
        .sort((left, right) => left - right),
    ).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);

    const persisted = await admin.query(
      `SELECT count(*)::integer AS total,
              count(DISTINCT website_project_id)::integer AS projects,
              array_agg(lane_sequence ORDER BY lane_sequence) AS lanes
         FROM backlinks.backlink_rate_limit_reservations`,
    );
    expect(persisted.rows).toEqual([
      {
        total: 10,
        projects: 2,
        lanes: [1, 1, 2, 2, 3, 3, 4, 4, 5, 5],
      },
    ]);
  });

  it("releases confirmed failures but keeps unknown delivery in the rolling window", async () => {
    const repo = repository();
    const firstReservedAt = new Date("2026-07-27T08:00:00.000Z");
    const first = await repo.reserve(reserveInput(20, 1, firstReservedAt));
    const released = await repo.releaseConfirmedNotSent({
      ...firstContext,
      reservationId: first.reservationId,
      gmailConnectionId,
      releasedAt: new Date("2026-07-27T08:01:00.000Z"),
      reason: "provider confirmed request was not accepted",
      actorId: "user-bl-ai-109",
    });
    expect(released).toMatchObject({
      status: "RELEASED",
      version: 2,
    });

    const secondReservedAt = new Date("2026-07-27T08:02:00.000Z");
    const second = await repo.reserve(reserveInput(21, 1, secondReservedAt));
    const unknown = await repo.consume({
      ...secondContext,
      reservationId: second.reservationId,
      gmailConnectionId: secondGmailConnectionId,
      outcome: "DELIVERY_UNKNOWN",
      consumedAt: new Date("2026-07-27T08:03:00.000Z"),
      actorId: "user-bl-ai-109",
    });
    expect(unknown).toMatchObject({
      status: "CONSUMED",
      consumedAt: "2026-07-27T08:03:00.000Z",
      version: 2,
    });

    await expect(
      repo.reserve(reserveInput(22, 1, new Date("2026-07-27T08:04:00.000Z"))),
    ).resolves.toMatchObject({
      status: "RESERVED",
      laneSequence: 2,
    });

    await expect(
      repo.reserve(reserveInput(23, 1, new Date("2026-07-27T08:04:00.000Z"))),
    ).rejects.toMatchObject({
      code: "GMAIL_DAILY_QUOTA_EXCEEDED",
      retryAt: "2026-07-28T08:03:00.000Z",
    });

    await expect(
      repo.reserve(reserveInput(23, 1, new Date("2026-07-28T08:03:00.001Z"))),
    ).resolves.toMatchObject({
      status: "RESERVED",
      laneSequence: 2,
    });
  });

  it("allows cross-project quota reads without allowing cross-project updates", async () => {
    const repo = repository();
    const reservation = await repo.reserve(
      reserveInput(23, 1, new Date("2026-07-27T09:00:00.000Z")),
    );
    const client = await tenantPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT set_config('app.current_organization_id', $1, true),
                set_config('app.current_workspace_id', $2, true),
                set_config('app.current_website_project_id', $3, true),
                set_config('app.current_gmail_connection_id', $4, true)`,
        [organizationId, workspaceId, firstProjectId, gmailConnectionId],
      );
      const visible = await client.query(
        `SELECT id
           FROM backlinks.backlink_rate_limit_reservations
          WHERE id = $1`,
        [reservation.reservationId],
      );
      const forbiddenUpdate = await client.query(
        `UPDATE backlinks.backlink_rate_limit_reservations
            SET updated_by = 'forbidden'
          WHERE id = $1`,
        [reservation.reservationId],
      );

      expect(visible.rows).toEqual([]);
      expect(forbiddenUpdate.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  describe("BL-AI-115 atomic Send Intent creation", () => {
    it("preflights the approved draft without persisting a Send Intent", async () => {
      const repo = new PostgresqlSendIntentRepository({ pool: tenantPool });
      const before = await admin.query(
        `SELECT count(*)::integer AS total
           FROM backlinks.backlink_send_intents`,
      );

      await expect(repo.preflight({
        ...firstContext,
        draftId: id(106),
        approvedDraftVersionId: id(107),
        contactId: id(109),
        contactVersion: 1,
        gmailConnectionId,
        messagePurpose: "INITIAL_OUTREACH",
        followUpIndex: 0,
        checkedAt: new Date("2026-07-27T10:15:00.000Z"),
        rolling24HourSendLimit: 100,
      })).resolves.toMatchObject({
        state: "allowed",
        gmail: {
          connectionId: gmailConnectionId,
          primaryEmail: "quota-sender@example.test",
          connectionStatus: "CONNECTED",
          sendAvailability: "AVAILABLE",
          mailSyncCapability: expect.any(Boolean),
        },
      });

      const after = await admin.query(
        `SELECT count(*)::integer AS total
           FROM backlinks.backlink_send_intents`,
      );
      expect(after.rows).toEqual(before.rows);
    });

    it("serializes retries and persists one Intent, Reservation, and Outbox event", async () => {
      const repo = new PostgresqlSendIntentRepository({ pool: tenantPool });
      const shared = {
        clientIdempotencyKey: "atomic-replay-client",
        logicalMessageKey: "f".repeat(64),
      };
      const results = await Promise.all(
        atomicIntentIds.slice(0, 12).map((_, index) =>
          repo.create(atomicInput(index, shared))),
      );

      expect(results.filter(({ state }) => state === "created")).toHaveLength(1);
      expect(results.filter(({ state }) => state === "replayed")).toHaveLength(11);
      const persistedIds = new Set(results.flatMap((result) =>
        result.state === "created" || result.state === "replayed"
          ? [result.intent.sendIntentId]
          : []));
      expect(persistedIds.size).toBe(1);

      const persisted = await admin.query(
        `SELECT
           (SELECT count(*)::integer
              FROM backlinks.backlink_send_intents
             WHERE client_idempotency_key = $1) AS intents,
           (SELECT count(*)::integer
              FROM backlinks.backlink_rate_limit_reservations AS reservation
              JOIN backlinks.backlink_send_intents AS intent
                ON intent.id = reservation.send_intent_id
             WHERE intent.client_idempotency_key = $1) AS reservations,
           (SELECT count(*)::integer
              FROM backlinks.backlink_outbox_events
              WHERE event_type = 'backlinks.send-intent.created.v1'
                AND aggregate_id = (
                 SELECT id
                   FROM backlinks.backlink_send_intents
                  WHERE client_idempotency_key = $1
                )) AS outbox_events,
           (SELECT count(*)::integer
              FROM backlinks.backlink_send_snapshots AS snapshot
              JOIN backlinks.backlink_send_intents AS intent
                ON intent.id = snapshot.send_intent_id
             WHERE intent.client_idempotency_key = $1) AS snapshots`,
        [shared.clientIdempotencyKey],
      );
      expect(persisted.rows).toEqual([{
        intents: 1,
        reservations: 1,
        outbox_events: 1,
        snapshots: 1,
      }]);
      const snapshot = await admin.query(
        `SELECT snapshot.id,
                snapshot.contact_id AS "contactId",
                snapshot.contact_version AS "contactVersion",
                snapshot.recipient,
                snapshot.recipient_hash AS "recipientHash",
                snapshot.content_hash AS "contentHash",
                snapshot.gmail_identity_id AS "gmailIdentityId"
           FROM backlinks.backlink_send_snapshots AS snapshot
           JOIN backlinks.backlink_send_intents AS intent
             ON intent.id = snapshot.send_intent_id
          WHERE intent.client_idempotency_key = $1`,
        [shared.clientIdempotencyKey],
      );
      expect(snapshot.rows).toEqual([{
        id: results[0]?.intent.sendSnapshotId,
        contactId: id(109),
        contactVersion: 1,
        recipient: "recipient-100@first.example",
        recipientHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        gmailIdentityId,
      }]);
      await expect(admin.query(
        `UPDATE backlinks.backlink_send_snapshots
            SET subject_text = 'mutated'
          WHERE id = $1`,
        [snapshot.rows[0]?.id],
      )).rejects.toMatchObject({ code: "55000" });
    });

    it("rolls back earlier writes when Reservation or Outbox insertion fails", async () => {
      const repo = new PostgresqlSendIntentRepository({ pool: tenantPool });
      await expect(repo.create(atomicInput(0))).resolves.toMatchObject({
        state: "created",
      });

      await expect(repo.create(atomicInput(1, {
        quotaReservationId: atomicReservationIds[0] ?? "",
        messagePurpose: "FOLLOW_UP",
        followUpIndex: 1,
      }))).resolves.toEqual({ state: "conflict" });
      await expect(repo.create(atomicInput(2, {
        outboxEventId: atomicOutboxIds[0] ?? "",
        messagePurpose: "FOLLOW_UP",
        followUpIndex: 2,
      }))).resolves.toEqual({ state: "conflict" });

      const persisted = await admin.query(
        `SELECT
           (SELECT count(*)::integer
              FROM backlinks.backlink_send_intents
             WHERE id = ANY($1::uuid[])) AS intents,
           (SELECT count(*)::integer
              FROM backlinks.backlink_rate_limit_reservations
             WHERE send_intent_id = ANY($1::uuid[])) AS reservations`,
        [[atomicIntentIds[1], atomicIntentIds[2]]],
      );
      expect(persisted.rows).toEqual([{
        intents: 0,
        reservations: 0,
      }]);
    });

    it("does not persist an Intent after the rolling quota is exhausted", async () => {
      const repo = new PostgresqlSendIntentRepository({ pool: tenantPool });
      await expect(repo.create(atomicInput(3, {
        rolling24HourSendLimit: 1,
      }))).resolves.toMatchObject({ state: "created" });

      await expect(repo.create(atomicInput(4, {
        rolling24HourSendLimit: 1,
        messagePurpose: "FOLLOW_UP",
        followUpIndex: 1,
      }))).resolves.toEqual({
        state: "quota_exceeded",
        dailyLimit: 1,
        retryAt: "2026-07-27T10:25:00.000Z",
      });
      const persisted = await admin.query(
        `SELECT count(*)::integer AS total
           FROM backlinks.backlink_send_intents
          WHERE id = $1`,
        [atomicIntentIds[4]],
      );
      expect(persisted.rows).toEqual([{ total: 0 }]);
    });

    it("enforces the 30-day initial outreach limit for the same Workspace and Contact", async () => {
      const repo = new PostgresqlSendIntentRepository({ pool: tenantPool });
      await expect(repo.create(atomicInput(5))).resolves.toMatchObject({
        state: "created",
      });
      await admin.query(
        `INSERT INTO backlinks.backlink_email_drafts (
           id, organization_id, workspace_id, website_project_id,
           opportunity_id, logical_draft_key, status, contact_id,
           contact_version, created_by, updated_by
         ) VALUES (
           $1, $2, $3, $4, $5, 'quota-draft-cooldown',
           'draft', $6, 1, 'test', 'test'
         )`,
        [
          id(1306),
          organizationId,
          workspaceId,
          firstProjectId,
          id(104),
          id(109),
        ],
      );
      await admin.query(
        `INSERT INTO backlinks.backlink_draft_versions (
           id, organization_id, workspace_id, website_project_id, draft_id,
           opportunity_id, version_no, source, evidence_snapshot_id,
           subject_text, body_text, structured_output, evidence_ids,
           prompt_version, output_schema_version, contact_id, contact_version,
           created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, 1, 'MANUAL', $7,
           'Second approved subject', 'Second approved body', '{}', '[]',
           'manual.v1', 'manual.v1', $8, 1, 'test'
         )`,
        [
          id(1307),
          organizationId,
          workspaceId,
          firstProjectId,
          id(1306),
          id(104),
          id(105),
          id(109),
        ],
      );
      await admin.query(
        `UPDATE backlinks.backlink_email_drafts
            SET status = 'approved',
                current_version_id = $1,
                approved_version_id = $1,
                version = 2,
                updated_at = statement_timestamp(),
                updated_by = 'test'
          WHERE id = $2`,
        [id(1307), id(1306)],
      );
      await admin.query(
        `INSERT INTO backlinks.backlink_lifecycle_events (
           id, organization_id, workspace_id, website_project_id,
           aggregate_type, aggregate_id, sequence, aggregate_version,
           event_type, actor_type, actor_id, after_state, reason,
           correlation_id, idempotency_key
         ) VALUES (
           $1, $2, $3, $4, 'email_draft', $5, 1, 2,
           'draft.approval.recorded', 'user', 'test',
           jsonb_build_object(
             'approvedVersionId', $6::text,
             'occurredAt', statement_timestamp()
           ),
           'test approval', $7, $8
         )`,
        [
          id(1310),
          organizationId,
          workspaceId,
          firstProjectId,
          id(1306),
          id(1307),
          "quota-approval-cooldown",
          "quota-approval:cooldown",
        ],
      );
      await expect(repo.create(atomicInput(6, {
        draftId: id(1306),
        approvedDraftVersionId: id(1307),
        requestedSendAt: new Date("2026-07-28T10:15:00.000Z"),
      }))).resolves.toEqual({
        state: "initial_outreach_cooldown",
        retryAt: "2026-08-26T10:15:00.000Z",
      });
    });

    it("hides immutable Send Snapshots across Website Projects under RLS", async () => {
      const repo = new PostgresqlSendIntentRepository({ pool: tenantPool });
      const created = await repo.create(atomicInput(7));
      expect(created).toMatchObject({ state: "created" });
      const client = await tenantPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `SELECT set_config('app.current_organization_id', $1, true),
                  set_config('app.current_workspace_id', $2, true),
                  set_config('app.current_website_project_id', $3, true)`,
          [organizationId, workspaceId, secondProjectId],
        );
        const hidden = await client.query(
          `SELECT id
             FROM backlinks.backlink_send_snapshots
            WHERE id = $1`,
          [atomicSnapshotIds[7]],
        );
        expect(hidden.rows).toEqual([]);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
    });

    it("invalidates approval when the bound Contact version changes", async () => {
      await admin.query("BEGIN");
      try {
        await admin.query(
          `UPDATE backlinks.backlink_contacts
              SET version = version + 1,
                  updated_at = statement_timestamp(),
                  updated_by = 'contact-change'
            WHERE id = $1`,
          [id(109)],
        );
        const draft = await admin.query(
          `SELECT status, approved_version_id AS "approvedVersionId"
             FROM backlinks.backlink_email_drafts
            WHERE id = $1`,
          [id(106)],
        );
        expect(draft.rows).toEqual([{
          status: "draft",
          approvedVersionId: null,
        }]);
      } finally {
        await admin.query("ROLLBACK");
      }
    });
  });
});
