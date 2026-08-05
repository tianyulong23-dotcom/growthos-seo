import { describe, expect, it } from "vitest";

import {
  PostgresqlSendIntentRepository,
  type CreateSendIntentRecordInput,
} from "../../src/modules/backlinks/application/services/send-intent.repository.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionQueryResult,
} from "../../src/modules/backlinks/db/tenant-transaction.js";

const input: CreateSendIntentRecordInput = {
  organizationId: "organization-114",
  workspaceId: "workspace-114",
  websiteProjectId: "project-114",
  sendIntentId: "018f0000-0000-7000-8000-000000000114",
  quotaReservationId: "018f0000-0000-7000-8000-000000000215",
  outboxEventId: "018f0000-0000-7000-8000-000000000214",
  draftId: "018f0000-0000-7000-8000-000000000314",
  approvedDraftVersionId: "018f0000-0000-7000-8000-000000000414",
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
};
const persistedIntent = {
  sendIntentId: input.sendIntentId,
  draftId: input.draftId,
  approvedDraftVersionId: input.approvedDraftVersionId,
  status: "READY",
  version: 1,
  requestedSendAt: input.requestedSendAt,
};

type FakePoolOptions = Readonly<{
  draft?: Record<string, unknown>;
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
            && sql.endsWith("FOR UPDATE")
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
              hasReservation: options.companionsAvailable !== false,
              hasOutboxEvent: options.companionsAvailable !== false,
            }]);
          }
          if (sql.includes("FROM backlinks.backlink_email_drafts")) {
            return result(options.draft === undefined
              ? [{
                  opportunityId:
                    "018f0000-0000-7000-8000-000000000614",
                  status: "approved",
                  currentVersionId: input.approvedDraftVersionId,
                  approvedVersionId: input.approvedDraftVersionId,
                }]
              : [options.draft]);
          }
          if (
            sql.includes(
              "FROM backlinks.backlink_gmail_workspace_bindings",
            )
          ) {
            return result(options.bindingAvailable === false ? [] : [{ ok: 1 }]);
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
      && sql.endsWith("FOR UPDATE"))).toBe(true);
    const intentInsert = fake.queries.findIndex((sql) =>
      sql.startsWith("INSERT INTO backlinks.backlink_send_intents"));
    const reservationInsert = fake.queries.findIndex((sql) =>
      sql.startsWith(
        "INSERT INTO backlinks.backlink_rate_limit_reservations",
      ));
    const outboxInsert = fake.queries.findIndex((sql) =>
      sql.startsWith("INSERT INTO backlinks.backlink_outbox_events"));
    expect(intentInsert).toBeGreaterThan(0);
    expect(reservationInsert).toBeGreaterThan(intentInsert);
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
      },
    });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).resolves.toEqual({
      state: "draft_not_approved",
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
      quotaReservationId: "018f0000-0000-7000-8000-000000000998",
      outboxEventId: "018f0000-0000-7000-8000-000000000997",
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

  it("does not create an Intent after the rolling quota is exhausted", async () => {
    const fake = createFakePool({ usedSlots: 5 });
    const repository = new PostgresqlSendIntentRepository({
      pool: fake.pool,
    });

    await expect(repository.create(input)).resolves.toEqual({
      state: "quota_exceeded",
      dailyLimit: 5,
      retryAt: "2026-07-28T10:14:00.000Z",
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
