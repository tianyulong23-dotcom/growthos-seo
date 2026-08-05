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
  sendSnapshotId: string;
  quotaReservationId: string;
  outboxEventId: string;
  draftId: string;
  approvedDraftVersionId: string;
  contactId: string;
  contactVersion: number;
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
  sendSnapshotId: string;
  draftId: string;
  approvedDraftVersionId: string;
  contactId: string;
  contactVersion: number;
  status: "READY";
  version: 1;
  requestedSendAt: string;
}>;

export type SendIntentRepositoryResult =
  | Readonly<{ state: "created"; intent: SendIntentRecord }>
  | Readonly<{ state: "replayed"; intent: SendIntentRecord }>
  | Readonly<{ state: "draft_not_found" }>
  | Readonly<{ state: "draft_not_approved" }>
  | Readonly<{ state: "contact_unavailable" }>
  | Readonly<{ state: "contact_version_conflict" }>
  | Readonly<{ state: "gmail_connection_unavailable" }>
  | Readonly<{
      state: "initial_outreach_cooldown";
      retryAt: string;
    }>
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

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (
    typeof value === "boolean"
    || typeof value === "number"
    || typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("Send Snapshot content is not JSON-compatible.");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const intentFromRow = (
  row: Record<string, unknown>,
): SendIntentRecord => {
  const sendIntentId = row.sendIntentId;
  const sendSnapshotId = row.sendSnapshotId;
  const draftId = row.draftId;
  const approvedDraftVersionId = row.approvedDraftVersionId;
  const contactId = row.contactId;
  const contactVersion = row.contactVersion;
  if (
    typeof sendIntentId !== "string"
    || typeof sendSnapshotId !== "string"
    || typeof draftId !== "string"
    || typeof approvedDraftVersionId !== "string"
    || typeof contactId !== "string"
    || typeof contactVersion !== "number"
    || !Number.isSafeInteger(contactVersion)
  ) {
    throw new TypeError(
      "Send Intent persistence returned an invalid Intent.",
    );
  }
  return Object.freeze({
    sendIntentId,
    sendSnapshotId,
    draftId,
    approvedDraftVersionId,
    contactId,
    contactVersion,
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
               intent.send_snapshot_id AS "sendSnapshotId",
               intent.draft_id AS "draftId",
               intent.approved_draft_version_id
                 AS "approvedDraftVersionId",
               intent.contact_id AS "contactId",
               intent.contact_version AS "contactVersion",
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
              || existing.contactId !== input.contactId
              || existing.contactVersion !== input.contactVersion
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
                     FROM backlinks.backlink_send_snapshots AS snapshot
                    WHERE snapshot.organization_id = $1
                      AND snapshot.workspace_id = $2
                      AND snapshot.website_project_id = $3
                      AND snapshot.send_intent_id = $4
                      AND snapshot.id = $7
                 ) AS "hasSendSnapshot",
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
                existing.sendSnapshotId,
              ],
            );
            const companion = companions.rows[0];
            if (
              companion?.hasReservation !== true
              || companion.hasSendSnapshot !== true
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
               opportunity.version AS "opportunityVersion",
               opportunity.prospect_id AS "prospectId",
               opportunity.recommendation_context_version_id
                 AS "recommendationContextVersionId",
               draft.status,
               draft.current_version_id AS "currentVersionId",
               draft.approved_version_id AS "approvedVersionId",
               draft.contact_id AS "draftContactId",
               draft.contact_version AS "draftContactVersion",
               version.contact_id AS "versionContactId",
               version.contact_version AS "versionContactVersion",
               version.version_no AS "draftVersionNo",
               version.subject_text AS "subjectText",
               version.body_text AS "bodyText",
               version.body_document AS "bodyDocument"
             FROM backlinks.backlink_email_drafts AS draft
             JOIN backlinks.backlink_opportunities AS opportunity
               ON opportunity.organization_id = draft.organization_id
              AND opportunity.workspace_id = draft.workspace_id
              AND opportunity.website_project_id = draft.website_project_id
              AND opportunity.id = draft.opportunity_id
             LEFT JOIN backlinks.backlink_draft_versions AS version
               ON version.organization_id = draft.organization_id
              AND version.workspace_id = draft.workspace_id
              AND version.website_project_id = draft.website_project_id
              AND version.draft_id = draft.id
              AND version.id = draft.current_version_id
            WHERE draft.organization_id = $1
              AND draft.workspace_id = $2
              AND draft.website_project_id = $3
              AND draft.id = $4
            FOR UPDATE OF draft, opportunity`,
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
          if (
            draft.draftContactId !== input.contactId
            || draft.draftContactVersion !== input.contactVersion
            || draft.versionContactId !== input.contactId
            || draft.versionContactVersion !== input.contactVersion
          ) {
            return { state: "contact_version_conflict" };
          }
          const opportunityId = draft.opportunityId;
          if (
            typeof opportunityId !== "string"
            || typeof draft.opportunityVersion !== "number"
            || !Number.isSafeInteger(draft.opportunityVersion)
            || typeof draft.draftVersionNo !== "number"
            || !Number.isSafeInteger(draft.draftVersionNo)
            || typeof draft.subjectText !== "string"
            || typeof draft.bodyText !== "string"
          ) {
            throw new TypeError(
              "Send Intent persistence returned an invalid Draft.",
            );
          }

          const contactResult = await transaction.query(
            `SELECT contact.id AS "contactId",
                    contact.version AS "contactVersion",
                    contact.normalized_email AS "normalizedEmail"
               FROM backlinks.backlink_contacts AS contact
              WHERE contact.organization_id = $1
                AND contact.workspace_id = $2
                AND contact.website_project_id = $3
                AND contact.id = $4
                AND contact.prospect_id = $5
                AND contact.recommendation_context_version_id = $6
                AND contact.status = 'active'
                AND contact.guessed = false
                AND contact.invalidated_at IS NULL
              FOR SHARE`,
            [
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              input.contactId,
              draft.prospectId,
              draft.recommendationContextVersionId,
            ],
          );
          const contact = contactResult.rows[0];
          if (contact === undefined) {
            return { state: "contact_unavailable" };
          }
          if (contact.contactVersion !== input.contactVersion) {
            return { state: "contact_version_conflict" };
          }
          if (typeof contact.normalizedEmail !== "string") {
            throw new TypeError(
              "Send Intent persistence returned an invalid Contact.",
            );
          }
          const recipient = contact.normalizedEmail.trim().toLowerCase();

          const bindingResult = await transaction.query(
            `SELECT connection.version AS "gmailConnectionVersion",
                    identity.id AS "gmailIdentityId",
                    identity.version AS "gmailIdentityVersion"
               FROM backlinks.backlink_gmail_workspace_bindings AS binding
               JOIN backlinks.backlink_gmail_connections AS connection
                 ON connection.organization_id = binding.organization_id
                AND connection.id = binding.gmail_connection_id
               JOIN backlinks.backlink_gmail_send_identities AS identity
                 ON identity.organization_id = connection.organization_id
                AND identity.gmail_connection_id = connection.id
                WHERE binding.organization_id = $1
                  AND binding.workspace_id = $2
                  AND binding.gmail_connection_id = $3
                  AND binding.website_project_id = $4
                  AND binding.binding_status = 'ACTIVE'
                AND connection.connection_status = 'CONNECTED'
                AND connection.send_availability = 'AVAILABLE'
                AND identity.verification_status = 'accepted'
              ORDER BY identity.is_default DESC,
                       identity.is_primary DESC,
                       identity.id
              LIMIT 1
              FOR SHARE OF binding, connection, identity`,
            [
                input.organizationId,
                input.workspaceId,
                input.gmailConnectionId,
                input.websiteProjectId,
            ],
          );
          const gmailBinding = bindingResult.rows[0];
          if (gmailBinding === undefined) {
            return { state: "gmail_connection_unavailable" };
          }
          if (
            typeof gmailBinding.gmailConnectionVersion !== "number"
            || !Number.isSafeInteger(gmailBinding.gmailConnectionVersion)
            || typeof gmailBinding.gmailIdentityId !== "string"
            || typeof gmailBinding.gmailIdentityVersion !== "number"
            || !Number.isSafeInteger(gmailBinding.gmailIdentityVersion)
          ) {
            throw new TypeError(
              "Send Intent persistence returned an invalid Gmail binding.",
            );
          }

          if (input.messagePurpose === "INITIAL_OUTREACH") {
            await transaction.query(
              `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
              [
                `initial-outreach:${input.organizationId}:`
                + `${input.workspaceId}:${input.contactId}`,
              ],
            );
            const cooldownResult = await transaction.query(
              `SELECT max(
                 intent.requested_send_at + interval '30 days'
               ) AS "retryAt"
                 FROM backlinks.backlink_send_intents AS intent
                WHERE intent.organization_id = $1
                  AND intent.workspace_id = $2
                  AND intent.contact_id = $3
                  AND intent.message_purpose = 'INITIAL_OUTREACH'
                  AND intent.status NOT IN (
                    'CANCELLED', 'REJECTED', 'FAILED_FINAL'
                  )`,
              [
                input.organizationId,
                input.workspaceId,
                input.contactId,
              ],
            );
            const retryValue = cooldownResult.rows[0]?.retryAt;
            if (retryValue !== null && retryValue !== undefined) {
              const retryAt = asDate(
                retryValue,
                "initial outreach retry_at",
              );
              if (retryAt.getTime() > input.requestedSendAt.getTime()) {
                return {
                  state: "initial_outreach_cooldown",
                  retryAt: retryAt.toISOString(),
                };
              }
            }
          }

          const recipientHash = sha256(recipient);
          const contentHash = sha256(canonicalJson({
            subjectText: draft.subjectText,
            bodyText: draft.bodyText,
            bodyDocument: draft.bodyDocument ?? null,
          }));

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
               contact_id, contact_version, send_snapshot_id,
               gmail_connection_id, client_idempotency_key,
               logical_message_key, message_purpose, follow_up_index,
               requested_send_at, status, version, created_by, updated_by
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13, $14, $15, $16, 'READY', 1, $17, $17
             )`,
            [
              input.sendIntentId,
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              opportunityId,
              input.draftId,
              input.approvedDraftVersionId,
              input.contactId,
              input.contactVersion,
              input.sendSnapshotId,
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
            `INSERT INTO backlinks.backlink_send_snapshots (
               id, organization_id, workspace_id, website_project_id,
               send_intent_id, opportunity_id, opportunity_version,
               draft_id, draft_version_id, draft_version_no,
               contact_id, contact_version, recipient, recipient_hash,
               subject_text, body_text, body_document, content_hash,
               gmail_connection_id, gmail_connection_version,
               gmail_identity_id, gmail_identity_version,
               snapshot_schema_version, created_at, created_by
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, 1, $23, $24
             )`,
            [
              input.sendSnapshotId,
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              input.sendIntentId,
              opportunityId,
              draft.opportunityVersion,
              input.draftId,
              input.approvedDraftVersionId,
              draft.draftVersionNo,
              input.contactId,
              input.contactVersion,
              recipient,
              recipientHash,
              draft.subjectText,
              draft.bodyText,
              draft.bodyDocument ?? null,
              contentHash,
              input.gmailConnectionId,
              gmailBinding.gmailConnectionVersion,
              gmailBinding.gmailIdentityId,
              gmailBinding.gmailIdentityVersion,
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
                sendSnapshotId: input.sendSnapshotId,
                draftId: input.draftId,
                approvedDraftVersionId: input.approvedDraftVersionId,
                contactId: input.contactId,
                contactVersion: input.contactVersion,
                recipientHash,
                contentHash,
                gmailConnectionId: input.gmailConnectionId,
                gmailIdentityId: gmailBinding.gmailIdentityId,
                messagePurpose: input.messagePurpose,
                followUpIndex: input.followUpIndex,
                requestedSendAt: input.requestedSendAt.toISOString(),
                quotaReservationId: input.quotaReservationId,
                quotaEligibleAt: eligibleAt.toISOString(),
                quotaExpiresAt: expiresAt.toISOString(),
                actorId: input.actorId,
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
              sendSnapshotId: input.sendSnapshotId,
              draftId: input.draftId,
              approvedDraftVersionId: input.approvedDraftVersionId,
              contactId: input.contactId,
              contactVersion: input.contactVersion,
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
