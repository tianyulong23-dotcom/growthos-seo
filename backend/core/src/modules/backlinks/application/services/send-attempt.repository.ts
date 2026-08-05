import { randomUUID } from "node:crypto";

import { withGmailTenantTransaction } from "../../db/gmail-tenant-transaction.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";

export type SendExecutionContext = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  gmailConnectionId: string;
  actorId: string;
}>;

export type SendAttemptReference = Readonly<{
  sendIntentId: string;
  attemptId: string;
  attemptNo: number;
  fencingToken: number;
  rfcMessageId: string;
}>;

export type SendAttemptClaimResult =
  | Readonly<{ state: "claimed"; attempt: SendAttemptReference }>
  | Readonly<{
      state: "already_completed";
      providerMessageId: string;
      providerThreadId: string | null;
      rfcMessageId: string;
    }>
  | Readonly<{
      state: "reconciliation_required";
      attemptId: string;
      rfcMessageId: string;
      status: "DISPATCHING" | "DELIVERY_UNKNOWN";
      errorCode?: string;
    }>
  | Readonly<{ state: "failed_final"; errorCode: string }>
  | Readonly<{ state: "wait"; retryAfterSeconds: number }>;

export type SendAttemptSettlement =
  | Readonly<{
      status: "PROVIDER_ACCEPTED";
      providerMessageId: string;
      providerThreadId?: string;
    }>
  | Readonly<{
      status: "DELIVERY_UNKNOWN";
      errorCode: string;
    }>
  | Readonly<{
      status: "FAILED_RETRYABLE";
      errorCode: string;
      retryAfterSeconds: number;
    }>
  | Readonly<{
      status: "FAILED_FINAL";
      errorCode: string;
    }>;

export type SendAttemptSettlementResult =
  | Readonly<{
      state: "completed";
      providerMessageId: string;
      providerThreadId: string | null;
      rfcMessageId: string;
    }>
  | Readonly<{
      state: "reconciliation_required";
      attemptId: string;
      rfcMessageId: string;
      errorCode: string;
    }>
  | Readonly<{
      state: "retry_scheduled";
      retryAfterSeconds: number;
    }>
  | Readonly<{ state: "failed_final"; errorCode: string }>;

export type ClaimSendAttemptInput = SendExecutionContext & Readonly<{
  sendIntentId: string;
  maxAttempts: number;
  claimedAt: Date;
}>;

export type SettleSendAttemptInput = SendExecutionContext
  & SendAttemptReference
  & Readonly<{
    status: SendAttemptSettlement["status"];
    providerMessageId: string | null;
    providerThreadId: string | null;
    errorCode: string | null;
    completedAt: Date;
    retryEligibleAt: Date | null;
  }>;

export interface SendAttemptRepository {
  claim(input: ClaimSendAttemptInput): Promise<SendAttemptClaimResult>;
  settle(
    input: SettleSendAttemptInput,
  ): Promise<SendAttemptSettlementResult>;
}

type PostgresqlSendAttemptRepositoryDependencies = Readonly<{
  pool: BacklinkTenantPool;
  newId?: () => string;
}>;

type AttemptRow = Readonly<{
  attemptId: string;
  attemptNo: number;
  fencingToken: number;
  rfcMessageId: string;
  status:
    | "DISPATCHING"
    | "PROVIDER_ACCEPTED"
    | "DELIVERY_UNKNOWN"
    | "FAILED_RETRYABLE"
    | "FAILED_FINAL";
  providerMessageId: string | null;
  providerThreadId: string | null;
  errorCode: string | null;
  retryEligibleAt: Date | null;
}>;

const assertNonBlank = (value: string, name: string): void => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must not be blank.`);
  }
};

const assertDate = (value: Date, name: string): void => {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid date.`);
  }
};

const asDate = (value: unknown, name: string): Date => {
  const date = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : new Date(Number.NaN);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`Send Attempt persistence returned invalid ${name}.`);
  }
  return date;
};

const optionalString = (value: unknown, name: string): string | null => {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Send Attempt persistence returned invalid ${name}.`);
  }
  return value;
};

const attemptStatuses = new Set([
  "DISPATCHING",
  "PROVIDER_ACCEPTED",
  "DELIVERY_UNKNOWN",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
]);

const attemptFromRow = (row: Record<string, unknown>): AttemptRow => {
  const {
    attemptId,
    attemptNo,
    fencingToken,
    rfcMessageId,
    status,
  } = row;
  if (
    typeof attemptId !== "string"
    || typeof attemptNo !== "number"
    || !Number.isSafeInteger(attemptNo)
    || attemptNo < 1
    || typeof fencingToken !== "number"
    || !Number.isSafeInteger(fencingToken)
    || fencingToken < 1
    || typeof rfcMessageId !== "string"
    || typeof status !== "string"
    || !attemptStatuses.has(status)
  ) {
    throw new TypeError("Send Attempt persistence returned an invalid row.");
  }
  return {
    attemptId,
    attemptNo,
    fencingToken,
    rfcMessageId,
    status: status as AttemptRow["status"],
    providerMessageId: optionalString(
      row.providerMessageId,
      "provider_message_id",
    ),
    providerThreadId: optionalString(
      row.providerThreadId,
      "provider_thread_id",
    ),
    errorCode: optionalString(row.errorCode, "provider_error_code"),
    retryEligibleAt: row.retryEligibleAt === null
      ? null
      : asDate(row.retryEligibleAt, "retry_eligible_at"),
  };
};

const selectAttempt = `
  attempt.id AS "attemptId",
  attempt.attempt_no AS "attemptNo",
  attempt.fencing_token AS "fencingToken",
  attempt.rfc_message_id AS "rfcMessageId",
  attempt.status,
  attempt.provider_message_id AS "providerMessageId",
  attempt.provider_thread_id AS "providerThreadId",
  attempt.provider_error_code AS "errorCode",
  attempt.retry_eligible_at AS "retryEligibleAt"`;

const setConnectionAndLock = async (
  transaction: BacklinkTransactionClient,
  input: SendExecutionContext,
): Promise<void> => {
  await transaction.query(
    `SELECT set_config('app.current_gmail_connection_id', $1, true)`,
    [input.gmailConnectionId],
  );
  await transaction.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [
      `gmail-send:${input.organizationId}:${input.gmailConnectionId}:`
      + input.websiteProjectId,
    ],
  );
};

const rfcMessageId = (
  sendIntentId: string,
  attemptNo: number,
): string => `<${sendIntentId}.${attemptNo}@send.growthos.invalid>`;

const referenceFromAttempt = (
  sendIntentId: string,
  attempt: AttemptRow,
): SendAttemptReference => Object.freeze({
  sendIntentId,
  attemptId: attempt.attemptId,
  attemptNo: attempt.attemptNo,
  fencingToken: attempt.fencingToken,
  rfcMessageId: attempt.rfcMessageId,
});

const completedFromAttempt = (
  attempt: AttemptRow,
): SendAttemptClaimResult => {
  if (attempt.providerMessageId === null) {
    throw new Error("Accepted Send Attempt has no Gmail Message ID.");
  }
  return {
    state: "already_completed",
    providerMessageId: attempt.providerMessageId,
    providerThreadId: attempt.providerThreadId,
    rfcMessageId: attempt.rfcMessageId,
  };
};

const terminalResult = (
  attempt: AttemptRow,
): SendAttemptSettlementResult => {
  if (attempt.status === "PROVIDER_ACCEPTED") {
    if (attempt.providerMessageId === null) {
      throw new Error("Accepted Send Attempt has no Gmail Message ID.");
    }
    return {
      state: "completed",
      providerMessageId: attempt.providerMessageId,
      providerThreadId: attempt.providerThreadId,
      rfcMessageId: attempt.rfcMessageId,
    };
  }
  if (attempt.status === "DELIVERY_UNKNOWN") {
    return {
      state: "reconciliation_required",
      attemptId: attempt.attemptId,
      rfcMessageId: attempt.rfcMessageId,
      errorCode: attempt.errorCode ?? "GMAIL_SEND_AMBIGUOUS_RESULT",
    };
  }
  if (attempt.status === "FAILED_RETRYABLE") {
    if (attempt.retryEligibleAt === null) {
      throw new Error("Retryable Send Attempt has no retry time.");
    }
    return {
      state: "retry_scheduled",
      retryAfterSeconds: 0,
    };
  }
  if (attempt.status === "FAILED_FINAL") {
    return {
      state: "failed_final",
      errorCode: attempt.errorCode ?? "GMAIL_SEND_FAILED",
    };
  }
  throw new Error("Dispatching Send Attempt has no terminal result.");
};

export class PostgresqlSendAttemptRepository
implements SendAttemptRepository {
  readonly #pool: BacklinkTenantPool;
  readonly #newId: () => string;

  constructor(
    dependencies: PostgresqlSendAttemptRepositoryDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#newId = dependencies.newId ?? randomUUID;
  }

  async claim(
    input: ClaimSendAttemptInput,
  ): Promise<SendAttemptClaimResult> {
    for (const [name, value] of Object.entries(input)) {
      if (typeof value === "string") {
        assertNonBlank(value, `Send Attempt ${name}`);
      }
    }
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1) {
      throw new TypeError("Send Attempt maxAttempts must be positive.");
    }
    assertDate(input.claimedAt, "Send Attempt claimedAt");

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await setConnectionAndLock(transaction, input);
      const aggregate = await transaction.query(
        `SELECT
           intent.status AS "intentStatus",
           intent.requested_send_at AS "requestedSendAt",
           reservation.id AS "reservationId",
           reservation.status AS "reservationStatus",
           reservation.eligible_at AS "eligibleAt",
           reservation.expires_at AS "expiresAt"
         FROM backlinks.backlink_send_intents AS intent
         JOIN backlinks.backlink_rate_limit_reservations AS reservation
           ON reservation.organization_id = intent.organization_id
          AND reservation.workspace_id = intent.workspace_id
          AND reservation.website_project_id = intent.website_project_id
          AND reservation.send_intent_id = intent.id
          AND reservation.gmail_connection_id = intent.gmail_connection_id
        WHERE intent.organization_id = $1
          AND intent.workspace_id = $2
          AND intent.website_project_id = $3
          AND intent.id = $4
          AND intent.gmail_connection_id = $5
        FOR UPDATE OF intent, reservation`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.sendIntentId,
          input.gmailConnectionId,
        ],
      );
      const aggregateRow = aggregate.rows[0];
      if (aggregateRow === undefined) {
        throw new Error("Send Intent or quota reservation is unavailable.");
      }

      const latestResult = await transaction.query(
        `SELECT ${selectAttempt}
           FROM backlinks.backlink_send_attempts AS attempt
          WHERE attempt.organization_id = $1
            AND attempt.workspace_id = $2
            AND attempt.website_project_id = $3
            AND attempt.send_intent_id = $4
          ORDER BY attempt.attempt_no DESC
          LIMIT 1
          FOR UPDATE`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.sendIntentId,
        ],
      );
      const latestRow = latestResult.rows[0];
      const latest = latestRow === undefined
        ? null
        : attemptFromRow(latestRow);
      if (latest?.status === "PROVIDER_ACCEPTED") {
        return completedFromAttempt(latest);
      }
      if (
        latest?.status === "DISPATCHING"
        || latest?.status === "DELIVERY_UNKNOWN"
      ) {
        return {
          state: "reconciliation_required",
          attemptId: latest.attemptId,
          rfcMessageId: latest.rfcMessageId,
          status: latest.status,
          ...(latest.errorCode === null
            ? {}
            : { errorCode: latest.errorCode }),
        };
      }
      if (latest?.status === "FAILED_FINAL") {
        return {
          state: "failed_final",
          errorCode: latest.errorCode ?? "GMAIL_SEND_FAILED",
        };
      }

      const reservationStatus = aggregateRow.reservationStatus;
      if (reservationStatus === "CONSUMED") {
        throw new Error(
          "Consumed Gmail quota has no accepted or unknown Send Attempt.",
        );
      }
      if (reservationStatus === "RELEASED") {
        return {
          state: "failed_final",
          errorCode: latest?.errorCode ?? "GMAIL_SEND_RESERVATION_RELEASED",
        };
      }

      const requestedSendAt = asDate(
        aggregateRow.requestedSendAt,
        "requested_send_at",
      );
      const eligibleAt = asDate(aggregateRow.eligibleAt, "eligible_at");
      const expiresAt = asDate(aggregateRow.expiresAt, "expires_at");
      const nextEligibleAt = latest?.retryEligibleAt ?? new Date(
        Math.max(requestedSendAt.getTime(), eligibleAt.getTime()),
      );
      if (input.claimedAt.getTime() < nextEligibleAt.getTime()) {
        return {
          state: "wait",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              (nextEligibleAt.getTime() - input.claimedAt.getTime()) / 1_000,
            ),
          ),
        };
      }

      const attemptNo = (latest?.attemptNo ?? 0) + 1;
      if (
        input.claimedAt.getTime() >= expiresAt.getTime()
        || attemptNo > input.maxAttempts
      ) {
        const errorCode = input.claimedAt.getTime() >= expiresAt.getTime()
          ? "GMAIL_SEND_RESERVATION_EXPIRED"
          : "GMAIL_SEND_RETRY_EXHAUSTED";
        await transaction.query(
          `UPDATE backlinks.backlink_send_intents AS intent
              SET status = 'FAILED_FINAL',
                  version = intent.version + 1,
                  updated_at = statement_timestamp(),
                  updated_by = $6
            WHERE intent.organization_id = $1
              AND intent.workspace_id = $2
              AND intent.website_project_id = $3
              AND intent.id = $4
              AND intent.gmail_connection_id = $5`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            input.sendIntentId,
            input.gmailConnectionId,
            input.actorId,
          ],
        );
        await transaction.query(
          `UPDATE backlinks.backlink_rate_limit_reservations AS reservation
              SET status = 'RELEASED',
                  released_at = $6,
                  release_reason = $7,
                  version = reservation.version + 1,
                  updated_at = statement_timestamp(),
                  updated_by = $8
            WHERE reservation.organization_id = $1
              AND reservation.workspace_id = $2
              AND reservation.website_project_id = $3
              AND reservation.id = $4
              AND reservation.gmail_connection_id = $5`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            aggregateRow.reservationId,
            input.gmailConnectionId,
            input.claimedAt,
            errorCode,
            input.actorId,
          ],
        );
        return { state: "failed_final", errorCode };
      }

      const attemptId = this.#newId();
      const fencingToken = (latest?.fencingToken ?? 0) + 1;
      const messageId = rfcMessageId(input.sendIntentId, attemptNo);
      const inserted = await transaction.query(
        `INSERT INTO backlinks.backlink_send_attempts AS attempt (
           id, organization_id, workspace_id, website_project_id,
           send_intent_id, attempt_no, fencing_token, rfc_message_id,
           status, started_at, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           'DISPATCHING', $9, $10
         )
         RETURNING ${selectAttempt}`,
        [
          attemptId,
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.sendIntentId,
          attemptNo,
          fencingToken,
          messageId,
          input.claimedAt,
          input.actorId,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow === undefined) {
        throw new Error("Send Attempt could not be claimed.");
      }
      await transaction.query(
        `UPDATE backlinks.backlink_send_intents AS intent
            SET status = 'DISPATCHING',
                version = intent.version + 1,
                updated_at = statement_timestamp(),
                updated_by = $6
          WHERE intent.organization_id = $1
            AND intent.workspace_id = $2
            AND intent.website_project_id = $3
            AND intent.id = $4
            AND intent.gmail_connection_id = $5`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.sendIntentId,
          input.gmailConnectionId,
          input.actorId,
        ],
      );
      return {
        state: "claimed",
        attempt: referenceFromAttempt(
          input.sendIntentId,
          attemptFromRow(insertedRow),
        ),
      };
    });
  }

  async settle(
    input: SettleSendAttemptInput,
  ): Promise<SendAttemptSettlementResult> {
    for (const [name, value] of Object.entries(input)) {
      if (typeof value === "string") {
        assertNonBlank(value, `Send Attempt ${name}`);
      }
    }
    assertDate(input.completedAt, "Send Attempt completedAt");
    if (input.retryEligibleAt !== null) {
      assertDate(input.retryEligibleAt, "Send Attempt retryEligibleAt");
    }

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await setConnectionAndLock(transaction, input);
      const aggregate = await transaction.query(
        `SELECT
           ${selectAttempt},
           intent.status AS "intentStatus",
           reservation.id AS "reservationId",
           reservation.status AS "reservationStatus"
         FROM backlinks.backlink_send_attempts AS attempt
         JOIN backlinks.backlink_send_intents AS intent
           ON intent.organization_id = attempt.organization_id
          AND intent.workspace_id = attempt.workspace_id
          AND intent.website_project_id = attempt.website_project_id
          AND intent.id = attempt.send_intent_id
         JOIN backlinks.backlink_rate_limit_reservations AS reservation
           ON reservation.organization_id = intent.organization_id
          AND reservation.workspace_id = intent.workspace_id
          AND reservation.website_project_id = intent.website_project_id
          AND reservation.send_intent_id = intent.id
          AND reservation.gmail_connection_id = intent.gmail_connection_id
        WHERE attempt.organization_id = $1
          AND attempt.workspace_id = $2
          AND attempt.website_project_id = $3
          AND attempt.id = $4
          AND attempt.send_intent_id = $5
          AND intent.gmail_connection_id = $6
        FOR UPDATE OF attempt, intent, reservation`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.attemptId,
          input.sendIntentId,
          input.gmailConnectionId,
        ],
      );
      const row = aggregate.rows[0];
      if (row === undefined) {
        throw new Error("Send Attempt is unavailable for settlement.");
      }
      const current = attemptFromRow(row);
      if (
        current.attemptNo !== input.attemptNo
        || current.fencingToken !== input.fencingToken
        || current.rfcMessageId !== input.rfcMessageId
      ) {
        throw new Error("Send Attempt fencing token does not match.");
      }
      if (current.status !== "DISPATCHING") {
        return terminalResult(current);
      }

      const settled = await transaction.query(
        `UPDATE backlinks.backlink_send_attempts AS attempt
            SET status = $7,
                provider_message_id = $8,
                provider_thread_id = $9,
                provider_error_code = $10,
                completed_at = $11,
                retry_eligible_at = $12
          WHERE attempt.organization_id = $1
            AND attempt.workspace_id = $2
            AND attempt.website_project_id = $3
            AND attempt.id = $4
            AND attempt.send_intent_id = $5
            AND attempt.fencing_token = $6
            AND attempt.status = 'DISPATCHING'
          RETURNING ${selectAttempt}`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.attemptId,
          input.sendIntentId,
          input.fencingToken,
          input.status,
          input.providerMessageId,
          input.providerThreadId,
          input.errorCode,
          input.completedAt,
          input.retryEligibleAt,
        ],
      );
      const settledRow = settled.rows[0];
      if (settledRow === undefined) {
        throw new Error("Send Attempt settlement lost its fencing token.");
      }
      const settledAttempt = attemptFromRow(settledRow);
      await transaction.query(
        `UPDATE backlinks.backlink_send_intents AS intent
            SET status = $6,
                version = intent.version + 1,
                updated_at = statement_timestamp(),
                updated_by = $7
          WHERE intent.organization_id = $1
            AND intent.workspace_id = $2
            AND intent.website_project_id = $3
            AND intent.id = $4
            AND intent.gmail_connection_id = $5`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.sendIntentId,
          input.gmailConnectionId,
          input.status,
          input.actorId,
        ],
      );

      if (
        input.status === "PROVIDER_ACCEPTED"
        || input.status === "DELIVERY_UNKNOWN"
      ) {
        if (row.reservationStatus !== "RESERVED") {
          throw new Error("Gmail quota reservation cannot be consumed.");
        }
        await transaction.query(
          `UPDATE backlinks.backlink_rate_limit_reservations AS reservation
              SET status = 'CONSUMED',
                  consumed_at = $6,
                  version = reservation.version + 1,
                  updated_at = statement_timestamp(),
                  updated_by = $7
            WHERE reservation.organization_id = $1
              AND reservation.workspace_id = $2
              AND reservation.website_project_id = $3
              AND reservation.id = $4
              AND reservation.gmail_connection_id = $5`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            row.reservationId,
            input.gmailConnectionId,
            input.completedAt,
            input.actorId,
          ],
        );
      } else if (input.status === "FAILED_FINAL") {
        if (row.reservationStatus !== "RESERVED") {
          throw new Error("Gmail quota reservation cannot be released.");
        }
        await transaction.query(
          `UPDATE backlinks.backlink_rate_limit_reservations AS reservation
              SET status = 'RELEASED',
                  released_at = $6,
                  release_reason = $7,
                  version = reservation.version + 1,
                  updated_at = statement_timestamp(),
                  updated_by = $8
            WHERE reservation.organization_id = $1
              AND reservation.workspace_id = $2
              AND reservation.website_project_id = $3
              AND reservation.id = $4
              AND reservation.gmail_connection_id = $5`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            row.reservationId,
            input.gmailConnectionId,
            input.completedAt,
            input.errorCode,
            input.actorId,
          ],
        );
      }

      if (settledAttempt.status === "FAILED_RETRYABLE") {
        if (settledAttempt.retryEligibleAt === null) {
          throw new Error("Retryable Send Attempt has no retry time.");
        }
        return {
          state: "retry_scheduled",
          retryAfterSeconds: Math.max(
            0,
            Math.ceil(
              (
                settledAttempt.retryEligibleAt.getTime()
                - input.completedAt.getTime()
              ) / 1_000,
            ),
          ),
        };
      }
      return terminalResult(settledAttempt);
    });
  }
}
