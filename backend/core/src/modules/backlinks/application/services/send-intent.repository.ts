import { createHash } from "node:crypto";

import { withGmailTenantTransaction } from "../../db/gmail-tenant-transaction.js";
import type {
  BacklinkTenantPool,
} from "../../db/tenant-transaction.js";

export const sendIntentMessagePurposes = [
  "INITIAL_OUTREACH",
  "FOLLOW_UP",
  "NEGOTIATION_REPLY",
] as const;

export type SendIntentMessagePurpose =
  (typeof sendIntentMessagePurposes)[number];

export type CreateSendIntentRecordInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  sendIntentId: string;
  quotaReservationId: string;
  outboxEventId: string;
  draftId: string;
  approvedDraftVersionId: string;
  gmailConnectionId: string;
  clientIdempotencyKey: string;
  logicalMessageKey: string;
  messagePurpose: SendIntentMessagePurpose;
  followUpIndex: number;
  requestedSendAt: Date;
  rolling24HourSendLimit: number;
  minimumIntervalSeconds: number;
  reservationTtlSeconds: number;
  actorId: string;
}>;

export type SendIntentRecord = Readonly<{
  sendIntentId: string;
  draftId: string;
  approvedDraftVersionId: string;
  status: "READY";
  version: 1;
  requestedSendAt: string;
}>;

export type SendIntentRepositoryResult =
  | Readonly<{ state: "created"; intent: SendIntentRecord }>
  | Readonly<{ state: "replayed"; intent: SendIntentRecord }>
  | Readonly<{ state: "draft_not_found" }>
  | Readonly<{ state: "draft_not_approved" }>
  | Readonly<{ state: "gmail_connection_unavailable" }>
  | Readonly<{
      state: "quota_exceeded";
      dailyLimit: number;
      retryAt: string | null;
    }>
  | Readonly<{ state: "conflict" }>;

export interface SendIntentRepository {
  create(
    input: CreateSendIntentRecordInput,
  ): Promise<SendIntentRepositoryResult>;
}

export const sendIntentCreatedEventType =
  "backlinks.send-intent.created.v1";

const asDate = (value: unknown, field: string): Date => {
  const date = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : new Date(Number.NaN);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`Send Intent persistence returned invalid ${field}.`);
  }
  return date;
};

const asNullableIso = (value: unknown): string | null =>
  value === null ? null : asDate(value, "timestamp").toISOString();

const intentFromRow = (
  row: Record<string, unknown>,
): SendIntentRecord => {
  const sendIntentId = row.sendIntentId;
  const draftId = row.draftId;
  const approvedDraftVersionId = row.approvedDraftVersionId;
  if (
    typeof sendIntentId !== "string"
    || typeof draftId !== "string"
    || typeof approvedDraftVersionId !== "string"
  ) {
    throw new TypeError(
      "Send Intent persistence returned an invalid Intent.",
    );
  }
  return Object.freeze({
    sendIntentId,
    draftId,
    approvedDraftVersionId,
    status: "READY",
    version: 1,
    requestedSendAt: asDate(
      row.requestedSendAt,
      "requested_send_at",
    ).toISOString(),
  });
};

const quotaReservationKey = (
  organizationId: string,
  gmailConnectionId: string,
  sendIntentId: string,
): string =>
  createHash("sha256")
    .update("gmail-quota-reservation:v1")
    .update("\0")
    .update(organizationId)
    .update("\0")
    .update(gmailConnectionId)
    .update("\0")
    .update(sendIntentId)
    .digest("hex");

const isUniqueViolation = (error: unknown): boolean => {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "23505";
};

export class PostgresqlSendIntentRepository
implements SendIntentRepository {
  readonly #pool: BacklinkTenantPool;

  constructor(dependencies: Readonly<{ pool: BacklinkTenantPool }>) {
    this.#pool = dependencies.pool;
  }

  async create(
    input: CreateSendIntentRecordInput,
  ): Promise<SendIntentRepositoryResult> {
    if (!Number.isFinite(input.requestedSendAt.getTime())) {
      throw new TypeError("Send Intent requestedSendAt must be valid.");
    }
    for (const [name, value] of [
      ["rolling24HourSendLimit", input.rolling24HourSendLimit],
      ["minimumIntervalSeconds", input.minimumIntervalSeconds],
      ["reservationTtlSeconds", input.reservationTtlSeconds],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`Send Intent ${name} must be positive.`);
      }
    }

    try {
      return await withGmailTenantTransaction(
        this.#pool,
        input,
        async (transaction) => {
          await transaction.query(
            `SELECT set_config(
               'app.current_gmail_connection_id',
               $1,
               true
             )`,
            [input.gmailConnectionId],
          );
          await transaction.query(
            `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
            [
              `gmail-daily-quota:${input.organizationId}:`
              + input.gmailConnectionId,
            ],
          );

          const existingResult = await transaction.query(
            `SELECT
               intent.id AS "sendIntentId",
               intent.draft_id AS "draftId",
               intent.approved_draft_version_id
                 AS "approvedDraftVersionId",
               intent.gmail_connection_id AS "gmailConnectionId",
               intent.client_idempotency_key
                 AS "clientIdempotencyKey",
               intent.logical_message_key AS "logicalMessageKey",
               intent.message_purpose AS "messagePurpose",
               intent.follow_up_index AS "followUpIndex",
               intent.requested_send_at AS "requestedSendAt"
             FROM backlinks.backlink_send_intents AS intent
            WHERE intent.organization_id = $1
              AND intent.workspace_id = $2
              AND intent.website_project_id = $3
              AND (
                intent.client_idempotency_key = $4
                OR intent.logical_message_key = $5
              )
            ORDER BY intent.id
            FOR UPDATE`,
            [
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              input.clientIdempotencyKey,
              input.logicalMessageKey,
            ],
          );
          if (existingResult.rows.length > 1) {
            return { state: "conflict" };
          }
          const existing = existingResult.rows[0];
          if (existing !== undefined) {
            if (
              existing.draftId !== input.draftId
              || existing.approvedDraftVersionId
                !== input.approvedDraftVersionId
              || existing.gmailConnectionId !== input.gmailConnectionId
              || existing.logicalMessageKey !== input.logicalMessageKey
              || existing.messagePurpose !== input.messagePurpose
              || existing.followUpIndex !== input.followUpIndex
            ) {
              return { state: "conflict" };
            }

            const companions = await transaction.query(
              `SELECT
                 EXISTS (
                   SELECT 1
                     FROM backlinks.backlink_rate_limit_reservations
                       AS reservation
                    WHERE reservation.organization_id = $1
                      AND reservation.workspace_id = $2
                      AND reservation.website_project_id = $3
                      AND reservation.send_intent_id = $4
                      AND reservation.gmail_connection_id = $5
                 ) AS "hasReservation",
                 EXISTS (
                   SELECT 1
                     FROM backlinks.backlink_outbox_events AS event
                    WHERE event.organization_id = $1
                      AND event.workspace_id = $2
                      AND event.website_project_id = $3
                      AND event.event_type = $6
                      AND event.aggregate_id = $4
                      AND event.aggregate_version = 1
                 ) AS "hasOutboxEvent"`,
              [
                input.organizationId,
                input.workspaceId,
                input.websiteProjectId,
                existing.sendIntentId,
                input.gmailConnectionId,
                sendIntentCreatedEventType,
              ],
            );
            const companion = companions.rows[0];
            if (
              companion?.hasReservation !== true
              || companion.hasOutboxEvent !== true
            ) {
              throw new Error(
                "Send Intent atomic persistence is incomplete.",
              );
            }
            return {
              state: "replayed",
              intent: intentFromRow(existing),
            };
          }

          const draftResult = await transaction.query(
            `SELECT
               draft.opportunity_id AS "opportunityId",
               draft.status,
               draft.current_version_id AS "currentVersionId",
               draft.approved_version_id AS "approvedVersionId"
             FROM backlinks.backlink_email_drafts AS draft
            WHERE draft.organization_id = $1
              AND draft.workspace_id = $2
              AND draft.website_project_id = $3
              AND draft.id = $4
            FOR UPDATE`,
            [
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              input.draftId,
            ],
          );
          const draft = draftResult.rows[0];
          if (draft === undefined) {
            return { state: "draft_not_found" };
          }
          if (
            draft.status !== "approved"
            || draft.currentVersionId !== input.approvedDraftVersionId
            || draft.approvedVersionId !== input.approvedDraftVersionId
          ) {
            return { state: "draft_not_approved" };
          }
          const opportunityId = draft.opportunityId;
          if (typeof opportunityId !== "string") {
            throw new TypeError(
              "Send Intent persistence returned an invalid Draft.",
            );
          }

          const bindingResult = await transaction.query(
            `SELECT 1
               FROM backlinks.backlink_gmail_workspace_bindings AS binding
              WHERE binding.organization_id = $1
                AND binding.workspace_id = $2
                AND binding.gmail_connection_id = $3
                AND binding.binding_status = 'ACTIVE'
              LIMIT 1`,
            [
              input.organizationId,
              input.workspaceId,
              input.gmailConnectionId,
            ],
          );
          if (bindingResult.rows[0] === undefined) {
            return { state: "gmail_connection_unavailable" };
          }

          const usageResult = await transaction.query(
            `SELECT
               count(*) FILTER (
                 WHERE (
                   reservation.status = 'CONSUMED'
                   AND reservation.consumed_at >
                     $3::timestamptz - interval '24 hours'
                 )
                 OR (
                   reservation.status = 'RESERVED'
                   AND reservation.expires_at > $3::timestamptz
                 )
               )::integer AS "usedSlots",
               min(
                 CASE reservation.status
                   WHEN 'CONSUMED' THEN
                     reservation.consumed_at + interval '24 hours'
                   WHEN 'RESERVED' THEN reservation.expires_at
                 END
               ) FILTER (
                 WHERE (
                   reservation.status = 'CONSUMED'
                   AND reservation.consumed_at >
                     $3::timestamptz - interval '24 hours'
                 )
                 OR (
                   reservation.status = 'RESERVED'
                   AND reservation.expires_at > $3::timestamptz
                 )
               ) AS "nextSlotAt",
               coalesce(max(reservation.lane_sequence), 0)::integer
                 AS "lastLaneSequence",
               max(
                 CASE
                   WHEN reservation.status = 'CONSUMED'
                     AND reservation.consumed_at >
                       $3::timestamptz - interval '24 hours'
                     THEN reservation.consumed_at
                   WHEN reservation.status = 'RESERVED'
                     AND reservation.expires_at > $3::timestamptz
                     THEN reservation.eligible_at
                 END
               ) AS "lastEligibleAt"
             FROM backlinks.backlink_rate_limit_reservations
               AS reservation
            WHERE reservation.organization_id = $1
              AND reservation.gmail_connection_id = $2`,
            [
              input.organizationId,
              input.gmailConnectionId,
              input.requestedSendAt,
            ],
          );
          const usage = usageResult.rows[0];
          if (usage === undefined) {
            throw new TypeError(
              "Send Intent persistence returned no quota usage.",
            );
          }
          const usedSlots = usage.usedSlots;
          const lastLaneSequence = usage.lastLaneSequence;
          if (
            typeof usedSlots !== "number"
            || !Number.isSafeInteger(usedSlots)
            || typeof lastLaneSequence !== "number"
            || !Number.isSafeInteger(lastLaneSequence)
          ) {
            throw new TypeError(
              "Send Intent persistence returned invalid quota usage.",
            );
          }
          if (usedSlots >= input.rolling24HourSendLimit) {
            return {
              state: "quota_exceeded",
              dailyLimit: input.rolling24HourSendLimit,
              retryAt: asNullableIso(usage.nextSlotAt),
            };
          }

          const lastEligibleAt = usage.lastEligibleAt === null
            ? null
            : asDate(usage.lastEligibleAt, "quota eligible_at");
          const eligibleAt = new Date(Math.max(
            input.requestedSendAt.getTime(),
            lastEligibleAt === null
              ? input.requestedSendAt.getTime()
              : lastEligibleAt.getTime()
                + input.minimumIntervalSeconds * 1000,
          ));
          const expiresAt = new Date(
            eligibleAt.getTime() + input.reservationTtlSeconds * 1000,
          );

          await transaction.query(
            `INSERT INTO backlinks.backlink_send_intents (
               id, organization_id, workspace_id, website_project_id,
               opportunity_id, draft_id, approved_draft_version_id,
               gmail_connection_id, client_idempotency_key,
               logical_message_key, message_purpose, follow_up_index,
               requested_send_at, status, version, created_by, updated_by
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, 'READY', 1, $14, $14
             )`,
            [
              input.sendIntentId,
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              opportunityId,
              input.draftId,
              input.approvedDraftVersionId,
              input.gmailConnectionId,
              input.clientIdempotencyKey,
              input.logicalMessageKey,
              input.messagePurpose,
              input.followUpIndex,
              input.requestedSendAt,
              input.actorId,
            ],
          );

          await transaction.query(
            `INSERT INTO backlinks.backlink_rate_limit_reservations (
               id, organization_id, workspace_id, website_project_id,
               send_intent_id, gmail_connection_id, reservation_key,
               lane_sequence, status, reserved_at, eligible_at, expires_at,
               created_by, updated_by
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, 'RESERVED',
               $9, $10, $11, $12, $12
             )`,
            [
              input.quotaReservationId,
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              input.sendIntentId,
              input.gmailConnectionId,
              quotaReservationKey(
                input.organizationId,
                input.gmailConnectionId,
                input.sendIntentId,
              ),
              lastLaneSequence + 1,
              input.requestedSendAt,
              eligibleAt,
              expiresAt,
              input.actorId,
            ],
          );

          await transaction.query(
            `INSERT INTO backlinks.backlink_outbox_events (
               id, organization_id, workspace_id, website_project_id,
               event_type, aggregate_id, aggregate_version, idempotency_key,
               payload, payload_schema_version, status, available_at,
               created_by, updated_by
             ) VALUES (
               $1, $2, $3, $4, $5, $6, 1, $7, $8, 1, 'pending', $9,
               $10, $10
             )`,
            [
              input.outboxEventId,
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              sendIntentCreatedEventType,
              input.sendIntentId,
              `send-intent-created:${input.sendIntentId}`,
              {
                sendIntentId: input.sendIntentId,
                draftId: input.draftId,
                approvedDraftVersionId: input.approvedDraftVersionId,
                gmailConnectionId: input.gmailConnectionId,
                messagePurpose: input.messagePurpose,
                followUpIndex: input.followUpIndex,
                requestedSendAt: input.requestedSendAt.toISOString(),
                quotaReservationId: input.quotaReservationId,
                quotaEligibleAt: eligibleAt.toISOString(),
                quotaExpiresAt: expiresAt.toISOString(),
                status: "READY",
                version: 1,
              },
              input.requestedSendAt,
              input.actorId,
            ],
          );
          return {
            state: "created",
            intent: {
              sendIntentId: input.sendIntentId,
              draftId: input.draftId,
              approvedDraftVersionId: input.approvedDraftVersionId,
              status: "READY",
              version: 1,
              requestedSendAt: input.requestedSendAt.toISOString(),
            },
          };
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        return { state: "conflict" };
      }
      throw error;
    }
  }
}
