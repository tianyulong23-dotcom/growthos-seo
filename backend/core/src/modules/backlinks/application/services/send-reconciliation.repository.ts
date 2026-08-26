import { randomUUID } from "node:crypto";

import { withGmailTenantTransaction } from "../../db/gmail-tenant-transaction.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";
import type { SendExecutionContext } from "./send-attempt.repository.js";

export type UnknownSendResultAttempt = Readonly<{
  sendIntentId: string;
  attemptId: string;
  attemptNo: number;
  fencingToken: number;
  rfcMessageId: string;
  errorCode: string;
  status: "DISPATCHING" | "DELIVERY_UNKNOWN";
}>;

export type SendReconciliationDecision =
  | Readonly<{
    outcome: "PROVIDER_ACCEPTED";
    providerMessageId: string;
    providerThreadId?: string;
    evidenceReference: string;
  }>
  | Readonly<{
    outcome: "CONFIRMED_NOT_SENT";
    evidenceReference: string;
  }>;

export type SendReconciliationResult =
  | Readonly<{
    outcome: "completed";
    providerMessageId: string;
    providerThreadId: string | null;
    rfcMessageId: string;
  }>
  | Readonly<{
    outcome: "failed_final";
    errorCode: "GMAIL_SEND_RECONCILED_NOT_SENT";
    rfcMessageId: string;
  }>;

export type LoadUnknownSendResult =
  | Readonly<{ state: "pending"; attempt: UnknownSendResultAttempt }>
  | Readonly<{ state: "reconciled" } & SendReconciliationResult>
  | Readonly<{
    state: "not_reconcilable";
    status: string;
    rfcMessageId: string;
  }>;

export type LoadUnknownSendResultInput = SendExecutionContext & Readonly<{
  sendIntentId: string;
}>;

export type ReconcileUnknownSendResultInput = SendExecutionContext & Readonly<{
  attempt: UnknownSendResultAttempt;
  decision: SendReconciliationDecision;
  reconciledAt: Date;
}>;

export interface SendReconciliationRepository {
  load(input: LoadUnknownSendResultInput): Promise<LoadUnknownSendResult>;
  reconcile(
    input: ReconcileUnknownSendResultInput,
  ): Promise<SendReconciliationResult>;
}

type PostgresqlSendReconciliationRepositoryDependencies = Readonly<{
  pool: BacklinkTenantPool;
  newId?: () => string;
}>;

type AggregateRow = Readonly<{
  attemptId: string;
  attemptNo: number;
  fencingToken: number;
  rfcMessageId: string;
  attemptStatus: string;
  errorCode: string | null;
  intentStatus: string;
  reservationStatus: string;
  reconciliationId: string | null;
  reconciliationOutcome: string | null;
  providerMessageId: string | null;
  providerThreadId: string | null;
  evidenceReference: string | null;
}>;

const reconciliationFailureCode = "GMAIL_SEND_RECONCILED_NOT_SENT" as const;

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

const optionalString = (value: unknown, name: string): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Send reconciliation returned invalid ${name}.`);
  }
  return value;
};

const aggregateFromRow = (row: Record<string, unknown>): AggregateRow => {
  const required = [
    "attemptId",
    "rfcMessageId",
    "attemptStatus",
    "intentStatus",
    "reservationStatus",
  ] as const;
  for (const key of required) {
    if (typeof row[key] !== "string" || row[key].trim().length === 0) {
      throw new TypeError("Send reconciliation returned an invalid row.");
    }
  }
  if (
    typeof row.attemptNo !== "number"
    || !Number.isSafeInteger(row.attemptNo)
    || row.attemptNo < 1
    || typeof row.fencingToken !== "number"
    || !Number.isSafeInteger(row.fencingToken)
    || row.fencingToken < 1
  ) {
    throw new TypeError("Send reconciliation returned invalid attempt data.");
  }
  return {
    attemptId: row.attemptId as string,
    attemptNo: row.attemptNo,
    fencingToken: row.fencingToken,
    rfcMessageId: row.rfcMessageId as string,
    attemptStatus: row.attemptStatus as string,
    errorCode: optionalString(row.errorCode, "provider_error_code"),
    intentStatus: row.intentStatus as string,
    reservationStatus: row.reservationStatus as string,
    reconciliationId: optionalString(row.reconciliationId, "reconciliation_id"),
    reconciliationOutcome: optionalString(
      row.reconciliationOutcome,
      "reconciliation_outcome",
    ),
    providerMessageId: optionalString(
      row.providerMessageId,
      "provider_message_id",
    ),
    providerThreadId: optionalString(
      row.providerThreadId,
      "provider_thread_id",
    ),
    evidenceReference: optionalString(
      row.evidenceReference,
      "evidence_reference",
    ),
  };
};

const selectAggregate = `
  attempt.id AS "attemptId",
  attempt.attempt_no AS "attemptNo",
  attempt.fencing_token AS "fencingToken",
  attempt.rfc_message_id AS "rfcMessageId",
  attempt.status AS "attemptStatus",
  attempt.provider_error_code AS "errorCode",
  intent.status AS "intentStatus",
  reservation.status AS "reservationStatus",
  reconciliation.id AS "reconciliationId",
  reconciliation.outcome AS "reconciliationOutcome",
  reconciliation.provider_message_id AS "providerMessageId",
  reconciliation.provider_thread_id AS "providerThreadId",
  reconciliation.evidence_reference AS "evidenceReference"`;

const lockAggregate = async (
  transaction: BacklinkTransactionClient,
  input: LoadUnknownSendResultInput,
): Promise<AggregateRow> => {
  const result = await transaction.query(
    `SELECT ${selectAggregate}
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
       LEFT JOIN backlinks.backlink_send_reconciliations AS reconciliation
         ON reconciliation.organization_id = attempt.organization_id
        AND reconciliation.workspace_id = attempt.workspace_id
        AND reconciliation.website_project_id = attempt.website_project_id
        AND reconciliation.send_attempt_id = attempt.id
      WHERE attempt.organization_id = $1
        AND attempt.workspace_id = $2
        AND attempt.website_project_id = $3
        AND attempt.send_intent_id = $4
        AND intent.gmail_connection_id = $5
      ORDER BY attempt.attempt_no DESC
      LIMIT 1
      FOR UPDATE OF attempt, intent, reservation`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.sendIntentId,
      input.gmailConnectionId,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Send Attempt is unavailable for reconciliation.");
  }
  return aggregateFromRow(row);
};

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

const resultFromAggregate = (
  row: AggregateRow,
): SendReconciliationResult => {
  if (row.reconciliationOutcome === "PROVIDER_ACCEPTED") {
    if (row.providerMessageId === null) {
      throw new Error("Accepted reconciliation has no Gmail Message ID.");
    }
    return {
      outcome: "completed",
      providerMessageId: row.providerMessageId,
      providerThreadId: row.providerThreadId,
      rfcMessageId: row.rfcMessageId,
    };
  }
  if (row.reconciliationOutcome === "CONFIRMED_NOT_SENT") {
    return {
      outcome: "failed_final",
      errorCode: reconciliationFailureCode,
      rfcMessageId: row.rfcMessageId,
    };
  }
  throw new Error("Send reconciliation has an invalid outcome.");
};

const pendingFromAggregate = (
  row: AggregateRow,
): LoadUnknownSendResult => {
  if (row.reconciliationId !== null) {
    return { state: "reconciled", ...resultFromAggregate(row) };
  }
  if (
    (
      row.attemptStatus === "DISPATCHING"
      && row.intentStatus === "DISPATCHING"
      && row.reservationStatus === "RESERVED"
    )
    || (
      row.attemptStatus === "DELIVERY_UNKNOWN"
      && row.intentStatus === "DELIVERY_UNKNOWN"
      && row.reservationStatus === "CONSUMED"
    )
  ) {
    return {
      state: "pending",
      attempt: {
        sendIntentId: "",
        attemptId: row.attemptId,
        attemptNo: row.attemptNo,
        fencingToken: row.fencingToken,
        rfcMessageId: row.rfcMessageId,
        errorCode: row.errorCode ?? (
          row.attemptStatus === "DISPATCHING"
            ? "GMAIL_SEND_DISPATCH_STALLED"
            : "GMAIL_SEND_AMBIGUOUS_RESULT"
        ),
        status: row.attemptStatus,
      },
    };
  }
  return {
    state: "not_reconcilable",
    status: row.intentStatus,
    rfcMessageId: row.rfcMessageId,
  };
};

const decisionMatches = (
  row: AggregateRow,
  decision: SendReconciliationDecision,
): boolean => {
  if (row.evidenceReference !== decision.evidenceReference) return false;
  if (row.reconciliationOutcome !== decision.outcome) return false;
  if (decision.outcome === "CONFIRMED_NOT_SENT") {
    return row.providerMessageId === null && row.providerThreadId === null;
  }
  return (
    row.providerMessageId === decision.providerMessageId
    && row.providerThreadId === (decision.providerThreadId ?? null)
  );
};

export class PostgresqlSendReconciliationRepository
implements SendReconciliationRepository {
  readonly #pool: BacklinkTenantPool;
  readonly #newId: () => string;

  constructor(dependencies: PostgresqlSendReconciliationRepositoryDependencies) {
    this.#pool = dependencies.pool;
    this.#newId = dependencies.newId ?? randomUUID;
  }

  async load(
    input: LoadUnknownSendResultInput,
  ): Promise<LoadUnknownSendResult> {
    for (const [name, value] of Object.entries(input)) {
      assertNonBlank(value, `Send reconciliation ${name}`);
    }

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await setConnectionAndLock(transaction, input);
      const loaded = pendingFromAggregate(
        await lockAggregate(transaction, input),
      );
      if (loaded.state === "pending") {
        return {
          ...loaded,
          attempt: { ...loaded.attempt, sendIntentId: input.sendIntentId },
        };
      }
      return loaded;
    });
  }

  async reconcile(
    input: ReconcileUnknownSendResultInput,
  ): Promise<SendReconciliationResult> {
    for (const [name, value] of Object.entries(input)) {
      if (typeof value === "string") {
        assertNonBlank(value, `Send reconciliation ${name}`);
      }
    }
    assertNonBlank(
      input.decision.evidenceReference,
      "Send reconciliation evidenceReference",
    );
    assertDate(input.reconciledAt, "Send reconciliation reconciledAt");
    if (input.decision.outcome === "PROVIDER_ACCEPTED") {
      assertNonBlank(
        input.decision.providerMessageId,
        "Send reconciliation providerMessageId",
      );
      if (input.decision.providerThreadId !== undefined) {
        assertNonBlank(
          input.decision.providerThreadId,
          "Send reconciliation providerThreadId",
        );
      }
    }

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await setConnectionAndLock(transaction, input);
      const aggregate = await lockAggregate(transaction, {
        ...input,
        sendIntentId: input.attempt.sendIntentId,
      });
      if (aggregate.reconciliationId !== null) {
        if (!decisionMatches(aggregate, input.decision)) {
          throw new Error("Send result has already been reconciled.");
        }
        return resultFromAggregate(aggregate);
      }
      if (
        aggregate.attemptId !== input.attempt.attemptId
        || aggregate.rfcMessageId !== input.attempt.rfcMessageId
        || aggregate.attemptStatus !== "DELIVERY_UNKNOWN"
        || aggregate.intentStatus !== "DELIVERY_UNKNOWN"
        || aggregate.reservationStatus !== "CONSUMED"
      ) {
        throw new Error("Send result is not pending reconciliation.");
      }

      const providerMessageId = input.decision.outcome === "PROVIDER_ACCEPTED"
        ? input.decision.providerMessageId
        : null;
      const providerThreadId = input.decision.outcome === "PROVIDER_ACCEPTED"
        ? input.decision.providerThreadId ?? null
        : null;
      await transaction.query(
        `INSERT INTO backlinks.backlink_send_reconciliations (
           id, organization_id, workspace_id, website_project_id,
           send_intent_id, send_attempt_id, outcome,
           provider_message_id, provider_thread_id, evidence_reference,
           reconciled_at, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
         )`,
        [
          this.#newId(),
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.attempt.sendIntentId,
          input.attempt.attemptId,
          input.decision.outcome,
          providerMessageId,
          providerThreadId,
          input.decision.evidenceReference,
          input.reconciledAt,
          input.actorId,
        ],
      );
      const intentStatus = input.decision.outcome === "PROVIDER_ACCEPTED"
        ? "PROVIDER_ACCEPTED"
        : "FAILED_FINAL";
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
          input.attempt.sendIntentId,
          input.gmailConnectionId,
          intentStatus,
          input.actorId,
        ],
      );
      return input.decision.outcome === "PROVIDER_ACCEPTED"
        ? {
          outcome: "completed",
          providerMessageId: input.decision.providerMessageId,
          providerThreadId: input.decision.providerThreadId ?? null,
          rfcMessageId: input.attempt.rfcMessageId,
        }
        : {
          outcome: "failed_final",
          errorCode: reconciliationFailureCode,
          rfcMessageId: input.attempt.rfcMessageId,
        };
    });
  }
}
