import { describe, expect, it } from "vitest";

import {
  PostgresqlSendIntentRepository,
  type CreateSendIntentRecordInput,
} from "../../src/modules/backlinks/application/services/send-intent.repository.js";
import {
  createGmailSendReadinessSnapshot,
} from "../../src/modules/backlinks/application/services/send-policy-gate.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionQueryResult,
} from "../../src/modules/backlinks/db/tenant-transaction.js";

const approvalFactId = "018f0000-0000-7000-8000-000000000417";
const gmailIdentityId = "018f0000-0000-7000-8000-000000000515";
const readinessSnapshot = createGmailSendReadinessSnapshot({
  evaluatedAt: new Date("2026-07-27T10:13:30.000Z"),
  ttlSeconds: 600,
  conditions: [
    {
      code: "DRAFT_APPROVAL",
      revision:
        "018f0000-0000-7000-8000-000000000414:"
        + approvalFactId,
    },
    {
      code: "CONTACT_VERSION",
      revision: "018f0000-0000-7000-8000-000000000415:3",
    },
    {
      code: "GMAIL_BINDING",
      revision:
        "018f0000-0000-7000-8000-000000000514:2:3:4:v1",
    },
    {
      code: "GMAIL_IDENTITY",
      revision: `${gmailIdentityId}:4`,
    },
    { code: "SUPPRESSION", revision: "CLEAR" },
    { code: "KILL_SWITCH", revision: "8:OPEN" },
    { code: "COOLDOWN", revision: "CLEAR" },
    { code: "QUOTA", revision: "0/5" },
  ],
});

const input: CreateSendIntentRecordInput = {
  organizationId: "organization-114",
  workspaceId: "workspace-114",
  websiteProjectId: "project-114",
  sendIntentId: "018f0000-0000-7000-8000-000000000114",
  sendSnapshotId: "018f0000-0000-7000-8000-000000000115",
  quotaReservationId: "018f0000-0000-7000-8000-000000000215",
  outboxEventId: "018f0000-0000-7000-8000-000000000214",
  draftId: "018f0000-0000-7000-8000-000000000314",
  approvedDraftVersionId: "018f0000-0000-7000-8000-000000000414",
  contactId: "018f0000-0000-7000-8000-000000000415",
  contactVersion: 3,
  gmailConnectionId: "018f0000-0000-7000-8000-000000000514",
  clientIdempotencyKey: "send-intent-114",
  logicalMessageKey:
    "d87f7e0c5f7aa0f7f7f45c928da2fd9c885c031472c9af17b48d22f81609fb65",
  messagePurpose: "FOLLOW_UP",
  followUpIndex: 1,
  requestedSendAt: new Date("2026-07-27T10:14:00.000Z"),
  rolling24HourSendLimit: 5,
  minimumIntervalSeconds: 300,
  reservationTtlSeconds: 600,
  actorId: "user-114",
  readinessSnapshot,
  humanConfirmation: {
    confirmed: true,
    confirmedAt: new Date("2026-07-27T10:13:45.000Z"),
    readinessSnapshotVersion: readinessSnapshot.snapshotVersion,
  },
};
const persistedIntent = {
  sendIntentId: input.sendIntentId,
  sendSnapshotId: input.sendSnapshotId,
  draftId: input.draftId,
  approvedDraftVersionId: input.approvedDraftVersionId,
  contactId: input.contactId,
  contactVersion: input.contactVersion,
  status: "READY",
  version: 1,
  requestedSendAt: input.requestedSendAt,
};
const defaultDraft = {
  opportunityId: "018f0000-0000-7000-8000-000000000614",
  opportunityVersion: 2,
  prospectId: "018f0000-0000-7000-8000-000000000615",
  recommendationContextVersionId:
    "018f0000-0000-7000-8000-000000000616",
  status: "approved",
  currentVersionId: input.approvedDraftVersionId,
  approvedVersionId: input.approvedDraftVersionId,
  draftContactId: input.contactId,
  draftContactVersion: input.contactVersion,
  versionContactId: input.contactId,
  versionContactVersion: input.contactVersion,
  draftVersionNo: 1,
  draftSource: "MODEL",
  subjectText: "A relevant collaboration idea",
  bodyText: "Hello, this is an approved draft.",
  bodyDocument: null,
};

type FakePoolOptions = Readonly<{
  draft?: Record<string, unknown>;
  approvalFact?: Record<string, unknown>;
  bindingAvailable?: boolean;
  failOutbox?: boolean;
  failReservation?: boolean;
  conflictIntent?: boolean;
  existingIntent?: Record<string, unknown>;
  companionsAvailable?: boolean;
  usedSlots?: number;
}>;

const createFakePool = (options: FakePoolOptions = {}) => {
  const queries: string[] = [];
  let released = false;
  const result = (
    rows: Record<string, unknown>[] = [],
  ): BacklinkTransactionQueryResult => ({
    rows,
    rowCount: rows.length,
  });
  const pool: BacklinkTenantPool = {
    async connect() {
      return {
        async query(text) {
          const sql = text.replace(/\s+/g, " ").trim();
          queries.push(sql);
          if (
            sql.includes("FROM backlinks.backlink_send_intents AS intent")
            && sql.endsWith("FOR UPDATE OF intent")
          ) {
            return result(options.existingIntent === undefined
              ? []
              : [options.existingIntent]);
          }
          if (
            sql.includes("AS \"hasReservation\"")
            && sql.includes("AS \"hasOutboxEvent\"")
          ) {
            return result([{
              hasSendSnapshot: options.companionsAvailable !== false,
              hasReservation: options.companionsAvailable !== false,
              hasOutboxEvent: options.companionsAvailable !== false,
            }]);
          }
          if (sql.includes("FROM backlinks.backlink_email_drafts")) {
            return result(options.draft === undefined
              ? [defaultDraft]
              : [options.draft]);
          }
          if (sql.includes("FROM backlinks.backlink_lifecycle_events")) {
            return result([options.approvalFact ?? {
              approvalFactId,
              approvalActorId: input.actorId,
              approvalRecordedAt:
                new Date("2026-07-27T10:13:00.000Z"),
            }]);
          }
          if (sql.includes("FROM backlinks.backlink_contacts AS contact")) {
            return result([{
              contactId: input.contactId,
              contactVersion: input.contactVersion,
              normalizedEmail: "confirmed-contact@example.test",
            }]);
          }
          if (
            sql.includes(
              "FROM backlinks.backlink_gmail_workspace_bindings",
            )
          ) {
            return result(options.bindingAvailable === false
              ? []
              : [{
                  gmailConnectionVersion: 2,
                  connectionVersion: 2,
                  workspaceBindingVersion: 3,
                  projectBindingVersion: 4,
                  externalSecretVersion: "v1",
                  gmailIdentityId,
                  gmailIdentityVersion: 4,
                }]);
          }
          if (
            sql.includes(
              "FROM backlinks.backlink_suppression_entries AS entry",
            )
            && !sql.includes(
              "FROM backlinks.backlink_rate_limit_reservations AS reservation",
            )
          ) {
            return result([{
              suppressed: false,
              suppressionRevision: null,
              sendBlocked: false,
              sendBlockVersion: 8,
            }]);
          }
          if (
            sql.includes(
              "FROM backlinks.backlink_rate_limit_reservations AS reservation",
            )
            && sql.includes("AS \"usedSlots\"")
          ) {
            return result([{
              usedSlots: options.usedSlots ?? 0,
              nextSlotAt: options.usedSlots === undefined
                ? null
                : new Date("2026-07-28T10:14:00.000Z"),
              lastLaneSequence: 0,
              lastEligibleAt: null,
            }]);
          }
          if (sql.startsWith(
            "INSERT INTO backlinks.backlink_send_intents",
          )) {
            if (options.conflictIntent === true) {
              throw Object.assign(new Error("duplicate"), { code: "23505" });
            }
            return result([{ id: input.sendIntentId }]);
          }
          if (sql.startsWith(
            "INSERT INTO backlinks.backlink_rate_limit_reservations",
          )) {
            if (options.failReservation === true) {
              throw new Error("reservation unavailable");
            }
            return result([{ id: input.quotaReservationId }]);
          }
          if (sql.startsWith(
            "INSERT INTO backlinks.backlink_send_snapshots",
          )) {
            return result([{ id: input.sendSnapshotId }]);
          }
          if (sql.startsWith(
            "INSERT INTO backlinks.backlink_outbox_events",
          )) {
            if (options.failOutbox === true) {
              throw new Error("outbox unavailable");
            }
            return result([{ id: input.outboxEventId }]);
          }
          return result();
        },
        release() {
          released = true;
        },
      };
    },
  };
  return {
    pool,
    queries,
    released: () => released,
  };
};

describe("BL-AI-114/115 Send Intent repository transaction", () => {
  it("locks the Gmail lane and writes Intent, Reservation, and Outbox before commit", async () => {
    const fake = createFakePool();
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).resolves.toEqual({
      state: "created",
      intent: {
        ...persistedIntent,
        requestedSendAt: input.requestedSendAt.toISOString(),
      },
    });
    expect(fake.queries[0]).toBe("BEGIN");
    expect(fake.queries.some((sql) =>
      sql.includes("pg_advisory_xact_lock")
      && sql.includes("hashtextextended"))).toBe(true);
    expect(fake.queries.some((sql) =>
      sql.includes("FROM backlinks.backlink_email_drafts")
      && sql.endsWith("FOR UPDATE OF draft, opportunity"))).toBe(true);
    expect(fake.queries.some((sql) =>
      sql.includes("JOIN backlinks.backlink_secret_references AS secret")
      && sql.includes("secret.status = 'ACTIVE'"))).toBe(true);
    expect(fake.queries.some((sql) =>
      sql.includes("FROM backlinks.backlink_lifecycle_events")
      && sql.includes("draft.approval.recorded"))).toBe(true);
    const intentInsert = fake.queries.findIndex((sql) =>
      sql.startsWith("INSERT INTO backlinks.backlink_send_intents"));
    const snapshotInsert = fake.queries.findIndex((sql) =>
      sql.startsWith("INSERT INTO backlinks.backlink_send_snapshots"));
    const reservationInsert = fake.queries.findIndex((sql) =>
      sql.startsWith(
        "INSERT INTO backlinks.backlink_rate_limit_reservations",
      ));
    const outboxInsert = fake.queries.findIndex((sql) =>
      sql.startsWith("INSERT INTO backlinks.backlink_outbox_events"));
    expect(intentInsert).toBeGreaterThan(0);
    expect(snapshotInsert).toBeGreaterThan(intentInsert);
    expect(fake.queries[snapshotInsert]).toContain("approval_fact_id");
    expect(fake.queries[snapshotInsert]).toContain("approval_actor_id");
    expect(fake.queries[snapshotInsert]).toContain("approval_recorded_at");
    expect(reservationInsert).toBeGreaterThan(snapshotInsert);
    expect(outboxInsert).toBeGreaterThan(reservationInsert);
    expect(fake.queries.at(-1)).toBe("COMMIT");
    expect(fake.released()).toBe(true);
  });

  it("does not write when the requested Version is not the exact approval", async () => {
    const fake = createFakePool({
      draft: {
        opportunityId: "018f0000-0000-7000-8000-000000000614",
        status: "approved",
        currentVersionId: "018f0000-0000-7000-8000-000000000714",
        approvedVersionId: "018f0000-0000-7000-8000-000000000714",
        draftContactId: input.contactId,
        draftContactVersion: input.contactVersion,
        versionContactId: input.contactId,
        versionContactVersion: input.contactVersion,
      },
    });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).resolves.toEqual({
      state: "readiness_changed",
      changedConditions: [{
        code: "DRAFT_APPROVAL",
        reason: "MISSING",
        expectedRevision:
          `${input.approvedDraftVersionId}:${approvalFactId}`,
        currentRevision: null,
        retryable: true,
        recoveryAction: "REAPPROVE_CURRENT_DRAFT",
      }],
    });
    expect(fake.queries.some((sql) => sql.startsWith("INSERT INTO"))).toBe(
      false,
    );
    expect(fake.queries.at(-1)).toBe("COMMIT");
  });

  it("does not create an Intent for a diagnostic template fallback", async () => {
    const fake = createFakePool({
      draft: {
        ...defaultDraft,
        draftSource: "TEMPLATE_FALLBACK",
      },
    });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).resolves.toEqual({
      state: "readiness_changed",
      changedConditions: [{
        code: "DRAFT_APPROVAL",
        reason: "MISSING",
        expectedRevision:
          `${input.approvedDraftVersionId}:${approvalFactId}`,
        currentRevision: null,
        retryable: true,
        recoveryAction: "REAPPROVE_CURRENT_DRAFT",
      }],
    });
    expect(fake.queries.some((sql) => sql.startsWith("INSERT INTO"))).toBe(
      false,
    );
    expect(fake.queries.at(-1)).toBe("COMMIT");
  });

  it("does not create an Intent containing internal Evidence metadata", async () => {
    const fake = createFakePool({
      draft: {
        ...defaultDraft,
        bodyText:
          "Hello, this is an approved draft. [profile:current, opportunity:current]",
      },
    });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).resolves.toEqual({
      state: "send_policy_rejected",
      message:
        "The approved Draft contains internal evidence metadata. Edit and reapprove it before sending.",
      retryAt: null,
    });
    expect(fake.queries.some((sql) => sql.startsWith("INSERT INTO"))).toBe(
      false,
    );
    expect(fake.queries.at(-1)).toBe("COMMIT");
  });

  it("rolls back the Intent when the Outbox insert fails", async () => {
    const fake = createFakePool({ failOutbox: true });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).rejects.toThrow(
      "outbox unavailable",
    );
    expect(fake.queries).toContain("ROLLBACK");
    expect(fake.queries).not.toContain("COMMIT");
    expect(fake.released()).toBe(true);
  });

  it("rolls back the Intent when the Reservation insert fails", async () => {
    const fake = createFakePool({ failReservation: true });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).rejects.toThrow(
      "reservation unavailable",
    );
    expect(fake.queries).toContain("ROLLBACK");
    expect(fake.queries).not.toContain("COMMIT");
    expect(fake.released()).toBe(true);
  });

  it("replays the first complete atomic write without another insert", async () => {
    const fake = createFakePool({
      existingIntent: {
        ...persistedIntent,
        sendSnapshotId: input.sendSnapshotId,
        contactId: input.contactId,
        contactVersion: input.contactVersion,
        gmailConnectionId: input.gmailConnectionId,
        clientIdempotencyKey: input.clientIdempotencyKey,
        logicalMessageKey: input.logicalMessageKey,
        messagePurpose: input.messagePurpose,
        followUpIndex: input.followUpIndex,
      },
    });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create({
      ...input,
      sendIntentId: "018f0000-0000-7000-8000-000000000999",
      sendSnapshotId: "018f0000-0000-7000-8000-000000000996",
      quotaReservationId: "018f0000-0000-7000-8000-000000000998",
      outboxEventId: "018f0000-0000-7000-8000-000000000997",
      readinessSnapshot: {
        ...input.readinessSnapshot,
        conditions: input.readinessSnapshot.conditions.map((condition) =>
          condition.code === "QUOTA"
            ? { ...condition, revision: "999/5" }
            : condition),
      },
    })).resolves.toEqual({
      state: "replayed",
      intent: {
        ...persistedIntent,
        requestedSendAt: input.requestedSendAt.toISOString(),
      },
    });
    expect(fake.queries.some((sql) => sql.startsWith("INSERT INTO"))).toBe(
      false,
    );
    expect(fake.queries.at(-1)).toBe("COMMIT");
  });

  it("creates a fresh Intent after a prior logical send was proven not sent", async () => {
    const fake = createFakePool({
      existingIntent: {
        ...persistedIntent,
        sendIntentId: "018f0000-0000-7000-8000-000000000919",
        sendSnapshotId: "018f0000-0000-7000-8000-000000000918",
        clientIdempotencyKey: "previous-request-key",
        logicalMessageKey: input.logicalMessageKey,
        messagePurpose: input.messagePurpose,
        followUpIndex: input.followUpIndex,
        intentStatus: "FAILED_FINAL",
        attemptStatus: "FAILED_RETRYABLE",
        errorCode: "GMAIL_SEND_RFC_MESSAGE_NOT_FOUND",
        providerMessageId: null,
        providerThreadId: null,
      },
    });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).resolves.toEqual({
      state: "created",
      intent: {
        ...persistedIntent,
        requestedSendAt: input.requestedSendAt.toISOString(),
      },
    });
    expect(fake.queries.some((sql) =>
      sql.startsWith("INSERT INTO backlinks.backlink_send_intents"),
    )).toBe(true);
    expect(fake.queries.at(-1)).toBe("COMMIT");
  });

  it("creates a fresh Intent after token refresh failed before provider submission", async () => {
    const fake = createFakePool({
      existingIntent: {
        ...persistedIntent,
        sendIntentId: "018f0000-0000-7000-8000-000000000920",
        sendSnapshotId: "018f0000-0000-7000-8000-000000000921",
        clientIdempotencyKey: "previous-token-refresh-request",
        logicalMessageKey: input.logicalMessageKey,
        messagePurpose: input.messagePurpose,
        followUpIndex: input.followUpIndex,
        intentStatus: "FAILED_FINAL",
        attemptStatus: "FAILED_FINAL",
        errorCode: "GMAIL_SEND_TOKEN_REFRESH_FAILED",
        providerMessageId: null,
        providerThreadId: null,
      },
    });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).resolves.toEqual({
      state: "created",
      intent: {
        ...persistedIntent,
        requestedSendAt: input.requestedSendAt.toISOString(),
      },
    });
    expect(fake.queries.some((sql) =>
      sql.startsWith("INSERT INTO backlinks.backlink_send_intents"),
    )).toBe(true);
    expect(fake.queries.at(-1)).toBe("COMMIT");
  });

  it("creates a fresh Intent after an unused send reservation expires", async () => {
    const fake = createFakePool({
      existingIntent: {
        ...persistedIntent,
        sendIntentId: "018f0000-0000-7000-8000-000000000922",
        sendSnapshotId: "018f0000-0000-7000-8000-000000000923",
        clientIdempotencyKey: "previous-expired-reservation-request",
        logicalMessageKey: input.logicalMessageKey,
        messagePurpose: input.messagePurpose,
        followUpIndex: input.followUpIndex,
        intentStatus: "FAILED_FINAL",
        attemptStatus: null,
        errorCode: "GMAIL_SEND_RESERVATION_EXPIRED",
        providerMessageId: null,
        providerThreadId: null,
      },
    });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).resolves.toEqual({
      state: "created",
      intent: {
        ...persistedIntent,
        requestedSendAt: input.requestedSendAt.toISOString(),
      },
    });
    expect(fake.queries.some((sql) =>
      sql.includes("reservation.release_reason"),
    )).toBe(true);
    expect(fake.queries.some((sql) =>
      sql.startsWith("INSERT INTO backlinks.backlink_send_intents"),
    )).toBe(true);
    expect(fake.queries.at(-1)).toBe("COMMIT");
  });

  it("does not create an Intent after the rolling quota is exhausted", async () => {
    const fake = createFakePool({ usedSlots: 5 });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).resolves.toEqual({
      state: "readiness_changed",
      changedConditions: [{
        code: "QUOTA",
        reason: "CHANGED",
        expectedRevision: "0/5",
        currentRevision: "5/5",
        retryable: true,
        recoveryAction: "WAIT_AND_RUN_PREFLIGHT",
      }],
    });
    expect(fake.queries.some((sql) => sql.startsWith("INSERT INTO"))).toBe(
      false,
    );
    expect(fake.queries.at(-1)).toBe("COMMIT");
  });

  it("returns conflict after rolling back a unique Intent violation", async () => {
    const fake = createFakePool({ conflictIntent: true });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).resolves.toEqual({
      state: "conflict",
    });
    expect(fake.queries).toContain("ROLLBACK");
    expect(fake.released()).toBe(true);
  });
});
