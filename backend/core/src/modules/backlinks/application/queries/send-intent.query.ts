import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";

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

export const sendAttemptStatuses = [
  "DISPATCHING",
  "PROVIDER_ACCEPTED",
  "DELIVERY_UNKNOWN",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
] as const;
export type SendAttemptStatus = (typeof sendAttemptStatuses)[number];

export type SendIntentView = Readonly<{
  sendIntentId: string;
  draftId: string;
  status: SendIntentStatus;
  version: number;
  requestedSendAt: string;
  updatedAt: string;
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

export type SendIntentQuery = Readonly<{
  getSendIntent(
    context: ResolvedProjectContext,
    sendIntentId: string,
  ): Promise<SendIntentView>;
}>;

export type SendIntentQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

const intentStatusSet = new Set<string>(sendIntentStatuses);
const attemptStatusSet = new Set<string>(sendAttemptStatuses);

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

export function createSendIntentQuery(
  client: SendIntentQueryClient,
): SendIntentQuery {
  return Object.freeze({
    async getSendIntent(context, sendIntentId) {
      const result = await client.query(
        `SELECT
           intent.id AS "sendIntentId",
           intent.draft_id AS "draftId",
           intent.status,
           intent.version,
           intent.requested_send_at AS "requestedSendAt",
           intent.updated_at AS "updatedAt",
           attempt.id AS "attemptId",
           attempt.attempt_no AS "attemptNo",
           attempt.status AS "attemptStatus",
           attempt.rfc_message_id AS "rfcMessageId",
           attempt.provider_message_id AS "providerMessageId",
           attempt.provider_thread_id AS "providerThreadId",
           attempt.provider_error_code AS "errorCode",
           attempt.started_at AS "startedAt",
           attempt.completed_at AS "completedAt",
           attempt.retry_eligible_at AS "retryEligibleAt"
         FROM backlinks.backlink_send_intents AS intent
         LEFT JOIN LATERAL (
           SELECT latest.*
             FROM backlinks.backlink_send_attempts AS latest
            WHERE latest.organization_id = intent.organization_id
              AND latest.workspace_id = intent.workspace_id
              AND latest.website_project_id = intent.website_project_id
              AND latest.send_intent_id = intent.id
            ORDER BY latest.attempt_no DESC
            LIMIT 1
         ) AS attempt ON TRUE
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

      return Object.freeze({
        sendIntentId: String(row.sendIntentId),
        draftId: String(row.draftId),
        status: parseIntentStatus(row.status),
        version: Number(row.version),
        requestedSendAt: toIsoString(row.requestedSendAt),
        updatedAt: toIsoString(row.updatedAt),
        attempt: row.attemptId === null || row.attemptId === undefined
          ? null
          : Object.freeze({
              attemptId: String(row.attemptId),
              attemptNo: Number(row.attemptNo),
              status: parseAttemptStatus(row.attemptStatus),
              rfcMessageId: String(row.rfcMessageId),
              providerMessageId: toNullableString(row.providerMessageId),
              providerThreadId: toNullableString(row.providerThreadId),
              errorCode: toNullableString(row.errorCode),
              startedAt: toIsoString(row.startedAt),
              completedAt: toNullableIsoString(row.completedAt),
              retryEligibleAt: toNullableIsoString(row.retryEligibleAt),
            }),
      });
    },
  });
}
