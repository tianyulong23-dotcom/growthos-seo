import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import {
  canReplaceFailedSendIntent,
} from "../services/send-resubmission-policy.js";

export const sendIntentStatuses = [
  "READY",
  "DISPATCHING",
  "PROVIDER_ACCEPTED",
  "DELIVERY_UNKNOWN",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "CANCELLED",
  "REJECTED",
] as const;
export type SendIntentStatus = (typeof sendIntentStatuses)[number];

export const sendIntentQueueKinds = [
  "PENDING_SEND",
  "RECONCILIATION_REQUIRED",
  "WAITING_REPLY",
] as const;
export type SendIntentQueueKind = (typeof sendIntentQueueKinds)[number];

export const sendAttemptStatuses = [
  "DISPATCHING",
  "PROVIDER_ACCEPTED",
  "DELIVERY_UNKNOWN",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
] as const;
export type SendAttemptStatus = (typeof sendAttemptStatuses)[number];

export const sendIntentOperationCheckpoints = [
  "INTENT_PERSISTED",
  "PROVIDER_SUBMISSION_IN_PROGRESS",
  "PROVIDER_ACCEPTANCE_PERSISTED",
  "PROVIDER_RESULT_UNKNOWN",
  "RETRY_SCHEDULED",
  "FAILED_FINAL",
  "CANCELLED",
  "REJECTED",
] as const;
export type SendIntentOperationCheckpoint =
  (typeof sendIntentOperationCheckpoints)[number];

export const sendIntentCostUncertaintyValues = [
  "NONE",
  "UNKNOWN",
] as const;
export type SendIntentCostUncertainty =
  (typeof sendIntentCostUncertaintyValues)[number];

export const sendIntentWorkerModes = [
  "normal",
  "quiesced",
  "unavailable",
  "unknown",
] as const;
export type SendIntentWorkerMode =
  (typeof sendIntentWorkerModes)[number];

export const sendIntentNextActions = [
  "WAIT_FOR_WORKER",
  "RESTORE_WORKER",
  "WAIT_FOR_PERSISTED_RESULT",
  "START_OR_CONTINUE_SYNC",
  "RECONCILE_BEFORE_RETRY",
  "WAIT_FOR_RETRY",
  "RECHECK_BEFORE_RESUBMIT",
  "REVIEW_FAILURE",
  "NONE",
] as const;
export type SendIntentNextAction =
  (typeof sendIntentNextActions)[number];

export type SendIntentDiagnostics = Readonly<{
  operationId: string;
  operationCheckpoint: SendIntentOperationCheckpoint;
  retryable: boolean;
  resubmittable: boolean;
  nextRetryAt: string | null;
  costUncertainty: SendIntentCostUncertainty;
  workerMode: SendIntentWorkerMode;
  buildIdentity: string;
  primaryNextAction: SendIntentNextAction;
}>;

export type SendIntentView = Readonly<{
  sendIntentId: string;
  opportunityId: string;
  draftId: string;
  approvedDraftVersionId: string;
  messagePurpose: string;
  followUpIndex: number;
  status: SendIntentStatus;
  queueKind: SendIntentQueueKind | null;
  version: number;
  requestedSendAt: string;
  updatedAt: string;
  deliveryEnvelope: Readonly<{
    sendSnapshotId: string;
    gmailConnectionId: string;
    gmailAccountEmail: string | null;
    gmailIdentityId: string;
    fromAddress: string | null;
    recipient: string;
    contactId: string;
    contactVersion: number;
    approvalRecordedAt: string | null;
  }> | null;
  diagnostics: SendIntentDiagnostics;
  attempt: Readonly<{
    attemptId: string;
    attemptNo: number;
    status: SendAttemptStatus;
    rfcMessageId: string;
    providerMessageId: string | null;
    providerThreadId: string | null;
    errorCode: string | null;
    startedAt: string;
    completedAt: string | null;
    retryEligibleAt: string | null;
  }> | null;
}>;

export type SendIntentListInput = Readonly<{
  queueKind?: SendIntentQueueKind | undefined;
  draftId?: string | undefined;
  limit: number;
  cursor?: string | undefined;
}>;

export type SendIntentPage = Readonly<{
  items: SendIntentView[];
  nextCursor: string | null;
  hasMore: boolean;
}>;

export type SendIntentQuery = Readonly<{
  getSendIntent(
    context: ResolvedProjectContext,
    sendIntentId: string,
  ): Promise<SendIntentView>;
}>;

export type SendIntentListQuery = Readonly<{
  listSendIntents(
    context: ResolvedProjectContext,
    input: SendIntentListInput,
  ): Promise<SendIntentPage>;
}>;

export type SendIntentQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

export type SendIntentRuntimeDiagnostics = Readonly<{
  buildIdentity: string;
  workerMode(): Promise<SendIntentWorkerMode>;
}>;

const intentStatusSet = new Set<string>(sendIntentStatuses);
const attemptStatusSet = new Set<string>(sendAttemptStatuses);
const workerModeSet = new Set<string>(sendIntentWorkerModes);
type SendIntentCursor = readonly [string, string];

const defaultRuntimeDiagnostics: SendIntentRuntimeDiagnostics = Object.freeze({
  buildIdentity: "unknown",
  workerMode: async (): Promise<SendIntentWorkerMode> => "unknown",
});

function toIsoString(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}

function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toNullableIsoString(value: unknown): string | null {
  return value === null || value === undefined ? null : toIsoString(value);
}

const invalidCursor = () => new BacklinkError({
  code: backlinkErrorCodes.invalidRequest,
  message: "Send Intent cursor is invalid.",
  fieldErrors: [{
    field: "cursor",
    message: "Use a cursor returned by this API.",
  }],
});

function decodeCursor(value: string | undefined): SendIntentCursor | null {
  if (value === undefined) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (!Array.isArray(parsed)
      || parsed.length !== 2
      || typeof parsed[0] !== "string"
      || !Number.isFinite(new Date(parsed[0]).getTime())
      || typeof parsed[1] !== "string"
      || parsed[1].length === 0) {
      throw invalidCursor();
    }
    return [new Date(parsed[0]).toISOString(), parsed[1]];
  } catch (error) {
    if (error instanceof BacklinkError) throw error;
    throw invalidCursor();
  }
}

function parseIntentStatus(value: unknown): SendIntentStatus {
  const status = String(value);
  if (!intentStatusSet.has(status)) {
    throw new Error(`Unexpected Send Intent status: ${status}`);
  }
  return status as SendIntentStatus;
}

function parseAttemptStatus(value: unknown): SendAttemptStatus {
  const status = String(value);
  if (!attemptStatusSet.has(status)) {
    throw new Error(`Unexpected Send Attempt status: ${status}`);
  }
  return status as SendAttemptStatus;
}

function parseWorkerMode(value: unknown): SendIntentWorkerMode {
  const mode = String(value);
  return workerModeSet.has(mode)
    ? mode as SendIntentWorkerMode
    : "unknown";
}

function deriveQueueKind(
  status: SendIntentStatus,
): SendIntentQueueKind | null {
  switch (status) {
    case "READY":
    case "FAILED_RETRYABLE":
      return "PENDING_SEND";
    case "DISPATCHING":
    case "DELIVERY_UNKNOWN":
      return "RECONCILIATION_REQUIRED";
    case "PROVIDER_ACCEPTED":
      return "WAITING_REPLY";
    case "FAILED_FINAL":
    case "CANCELLED":
    case "REJECTED":
      return null;
  }
}

function deriveDiagnostics(input: Readonly<{
  sendIntentId: string;
  status: SendIntentStatus;
  retryEligibleAt: string | null;
  attemptStatus: SendAttemptStatus | null;
  errorCode: string | null;
  providerMessageId: string | null;
  providerThreadId: string | null;
  workerMode: SendIntentWorkerMode;
  buildIdentity: string;
}>): SendIntentDiagnostics {
  const operationCheckpoint: SendIntentOperationCheckpoint = (() => {
    switch (input.status) {
      case "READY":
        return "INTENT_PERSISTED";
      case "DISPATCHING":
        return "PROVIDER_SUBMISSION_IN_PROGRESS";
      case "PROVIDER_ACCEPTED":
        return "PROVIDER_ACCEPTANCE_PERSISTED";
      case "DELIVERY_UNKNOWN":
        return "PROVIDER_RESULT_UNKNOWN";
      case "FAILED_RETRYABLE":
        return "RETRY_SCHEDULED";
      case "FAILED_FINAL":
        return "FAILED_FINAL";
      case "CANCELLED":
        return "CANCELLED";
      case "REJECTED":
        return "REJECTED";
    }
  })();
  const workerUnavailable = input.workerMode !== "normal";
  const resubmittable = canReplaceFailedSendIntent({
    intentStatus: input.status,
    attemptStatus: input.attemptStatus,
    errorCode: input.errorCode,
    providerMessageId: input.providerMessageId,
    providerThreadId: input.providerThreadId,
  });
  const primaryNextAction: SendIntentNextAction = (() => {
    switch (input.status) {
      case "READY":
        return workerUnavailable ? "RESTORE_WORKER" : "WAIT_FOR_WORKER";
      case "DISPATCHING":
        return "WAIT_FOR_PERSISTED_RESULT";
      case "PROVIDER_ACCEPTED":
        return "START_OR_CONTINUE_SYNC";
      case "DELIVERY_UNKNOWN":
        return "RECONCILE_BEFORE_RETRY";
      case "FAILED_RETRYABLE":
        return workerUnavailable ? "RESTORE_WORKER" : "WAIT_FOR_RETRY";
      case "FAILED_FINAL":
        return resubmittable
          ? "RECHECK_BEFORE_RESUBMIT"
          : "REVIEW_FAILURE";
      case "CANCELLED":
      case "REJECTED":
        return "NONE";
    }
  })();

  return Object.freeze({
    operationId: input.sendIntentId,
    operationCheckpoint,
    retryable: input.status === "FAILED_RETRYABLE",
    resubmittable,
    nextRetryAt: input.status === "FAILED_RETRYABLE"
      ? input.retryEligibleAt
      : null,
    costUncertainty:
      input.status === "DISPATCHING"
        || input.status === "DELIVERY_UNKNOWN"
        ? "UNKNOWN"
        : "NONE",
    workerMode: input.workerMode,
    buildIdentity: input.buildIdentity.trim() || "unknown",
    primaryNextAction,
  });
}

const sendIntentColumns = `
  intent.id AS "sendIntentId",
  intent.opportunity_id AS "opportunityId",
  intent.draft_id AS "draftId",
  intent.approved_draft_version_id AS "approvedDraftVersionId",
  intent.message_purpose AS "messagePurpose",
  intent.follow_up_index AS "followUpIndex",
  intent.status,
  intent.version,
  intent.requested_send_at AS "requestedSendAt",
  intent.updated_at AS "updatedAt",
  snapshot.id AS "sendSnapshotId",
  snapshot.gmail_connection_id AS "gmailConnectionId",
  connection.primary_email AS "gmailAccountEmail",
  snapshot.gmail_identity_id AS "gmailIdentityId",
  identity.normalized_email AS "fromAddress",
  snapshot.recipient,
  snapshot.contact_id AS "snapshotContactId",
  snapshot.contact_version AS "snapshotContactVersion",
  snapshot.approval_recorded_at AS "approvalRecordedAt",
  attempt.id AS "attemptId",
  attempt.attempt_no AS "attemptNo",
  attempt.status AS "attemptStatus",
  attempt.rfc_message_id AS "rfcMessageId",
  attempt.provider_message_id AS "providerMessageId",
  attempt.provider_thread_id AS "providerThreadId",
  attempt.provider_error_code AS "errorCode",
  attempt.started_at AS "startedAt",
  attempt.completed_at AS "completedAt",
  attempt.retry_eligible_at AS "retryEligibleAt"`;

const sendIntentJoins = `
  LEFT JOIN backlinks.backlink_send_snapshots AS snapshot
    ON (snapshot.organization_id,snapshot.workspace_id,
        snapshot.website_project_id,snapshot.send_intent_id)
     = (intent.organization_id,intent.workspace_id,
        intent.website_project_id,intent.id)
  LEFT JOIN backlinks.backlink_gmail_connections AS connection
    ON (connection.organization_id,connection.id)
     = (snapshot.organization_id,snapshot.gmail_connection_id)
  LEFT JOIN backlinks.backlink_gmail_send_identities AS identity
    ON (identity.organization_id,identity.gmail_connection_id,identity.id)
     = (snapshot.organization_id,snapshot.gmail_connection_id,
        snapshot.gmail_identity_id)
  LEFT JOIN LATERAL (
    SELECT latest.*
      FROM backlinks.backlink_send_attempts AS latest
     WHERE latest.organization_id = intent.organization_id
       AND latest.workspace_id = intent.workspace_id
       AND latest.website_project_id = intent.website_project_id
       AND latest.send_intent_id = intent.id
     ORDER BY latest.attempt_no DESC
     LIMIT 1
  ) AS attempt ON TRUE`;

function toSendIntentView(
  row: Record<string, unknown>,
  workerMode: SendIntentWorkerMode,
  buildIdentity: string,
): SendIntentView {
  const status = parseIntentStatus(row.status);
  const retryEligibleAt = toNullableIsoString(row.retryEligibleAt);
  const attemptStatus =
    row.attemptId === null || row.attemptId === undefined
      ? null
      : parseAttemptStatus(row.attemptStatus);
  const errorCode = toNullableString(row.errorCode);
  const providerMessageId = toNullableString(row.providerMessageId);
  const providerThreadId = toNullableString(row.providerThreadId);
  return Object.freeze({
    sendIntentId: String(row.sendIntentId),
    opportunityId: String(row.opportunityId),
    draftId: String(row.draftId),
    approvedDraftVersionId: String(row.approvedDraftVersionId),
    messagePurpose: String(row.messagePurpose),
    followUpIndex: Number(row.followUpIndex),
    status,
    queueKind: deriveQueueKind(status),
    version: Number(row.version),
    requestedSendAt: toIsoString(row.requestedSendAt),
    updatedAt: toIsoString(row.updatedAt),
    deliveryEnvelope:
      row.sendSnapshotId === null || row.sendSnapshotId === undefined
        ? null
        : Object.freeze({
            sendSnapshotId: String(row.sendSnapshotId),
            gmailConnectionId: String(row.gmailConnectionId),
            gmailAccountEmail: toNullableString(row.gmailAccountEmail),
            gmailIdentityId: String(row.gmailIdentityId),
            fromAddress: toNullableString(row.fromAddress),
            recipient: String(row.recipient),
            contactId: String(row.snapshotContactId),
            contactVersion: Number(row.snapshotContactVersion),
            approvalRecordedAt: toNullableIsoString(row.approvalRecordedAt),
          }),
    diagnostics: deriveDiagnostics({
      sendIntentId: String(row.sendIntentId),
      status,
      retryEligibleAt,
      attemptStatus,
      errorCode,
      providerMessageId,
      providerThreadId,
      workerMode,
      buildIdentity,
    }),
    attempt: attemptStatus === null
      ? null
      : Object.freeze({
          attemptId: String(row.attemptId),
          attemptNo: Number(row.attemptNo),
          status: attemptStatus,
          rfcMessageId: String(row.rfcMessageId),
          providerMessageId,
          providerThreadId,
          errorCode,
          startedAt: toIsoString(row.startedAt),
          completedAt: toNullableIsoString(row.completedAt),
          retryEligibleAt,
        }),
  });
}

export function createSendIntentQuery(
  client: SendIntentQueryClient,
  runtime: SendIntentRuntimeDiagnostics = defaultRuntimeDiagnostics,
): SendIntentQuery & SendIntentListQuery {
  return Object.freeze({
    async listSendIntents(context, input) {
      const after = decodeCursor(input.cursor);
      const result = await client.query(
        `SELECT ${sendIntentColumns}
           FROM backlinks.backlink_send_intents AS intent
           ${sendIntentJoins}
          WHERE intent.organization_id = $1
            AND intent.workspace_id = $2
            AND intent.website_project_id = $3
            AND (
              (
                $5::uuid IS NULL
                AND intent.status IN (
                  'READY','DISPATCHING','PROVIDER_ACCEPTED',
                  'DELIVERY_UNKNOWN','FAILED_RETRYABLE'
                )
              )
              OR (
                $5::uuid IS NOT NULL
                AND intent.draft_id = $5::uuid
              )
            )
            AND (
              $4::text IS NULL
              OR ($4 = 'PENDING_SEND'
                  AND intent.status IN ('READY','FAILED_RETRYABLE'))
              OR ($4 = 'RECONCILIATION_REQUIRED'
                  AND intent.status IN ('DISPATCHING','DELIVERY_UNKNOWN'))
              OR ($4 = 'WAITING_REPLY'
                  AND intent.status = 'PROVIDER_ACCEPTED')
            )
            AND (
              $6::timestamptz IS NULL
              OR intent.updated_at < $6
              OR (intent.updated_at = $6 AND intent.id < $7::uuid)
            )
          ORDER BY intent.updated_at DESC,intent.id DESC
          LIMIT $8`,
        [
          context.tenant.organizationId,
          context.tenant.workspaceId,
          context.project.websiteProjectId,
          input.queueKind ?? null,
          input.draftId ?? null,
          after?.[0] ?? null,
          after?.[1] ?? null,
          input.limit + 1,
        ],
      );
      const workerMode = parseWorkerMode(await runtime.workerMode());
      const items = result.rows
        .slice(0, input.limit)
        .map((row) => toSendIntentView(
          row,
          workerMode,
          runtime.buildIdentity,
        ));
      const hasMore = result.rows.length > input.limit;
      const last = items.at(-1);
      return Object.freeze({
        items,
        hasMore,
        nextCursor: hasMore && last !== undefined
          ? Buffer.from(
              JSON.stringify([last.updatedAt, last.sendIntentId]),
            ).toString("base64url")
          : null,
      });
    },

    async getSendIntent(context, sendIntentId) {
      const result = await client.query(
        `SELECT ${sendIntentColumns}
         FROM backlinks.backlink_send_intents AS intent
         ${sendIntentJoins}
        WHERE intent.organization_id = $1
          AND intent.workspace_id = $2
          AND intent.website_project_id = $3
          AND intent.id = $4
        LIMIT 1`,
        [
          context.tenant.organizationId,
          context.tenant.workspaceId,
          context.project.websiteProjectId,
          sendIntentId,
        ],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Send Intent was not found in this project.",
        });
      }

      const workerMode = parseWorkerMode(await runtime.workerMode());
      return toSendIntentView(row, workerMode, runtime.buildIdentity);
    },
  });
}
