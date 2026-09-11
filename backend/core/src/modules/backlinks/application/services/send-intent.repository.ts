import { createHash } from "node:crypto";

import { withGmailTenantTransaction } from "../../db/gmail-tenant-transaction.js";
import type {
  BacklinkTenantPool,
} from "../../db/tenant-transaction.js";
import {
  secretStoreReferenceSchema,
  type SecretStoreReference,
} from "../../ports/secret-store.port.js";
import {
  containsInternalDraftMetadataMarker,
} from "../../domain/drafts/evidence-policy.js";
import {
  compareGmailSendReadinessSnapshot,
  describeGmailSendReadinessChange,
  describeGmailSendReadinessSnapshotValidity,
  type GmailSendReadinessChangedCondition,
  type GmailSendReadinessCondition,
  type GmailSendReadinessConditionCode,
  type GmailSendReadinessSnapshot,
} from "./send-policy-gate.js";
import {
  canReplaceFailedSendIntent,
} from "./send-resubmission-policy.js";

export const sendIntentMessagePurposes = [
  "INITIAL_OUTREACH",
  "FOLLOW_UP",
  "NEGOTIATION_REPLY",
] as const;

export type SendIntentMessagePurpose =
  (typeof sendIntentMessagePurposes)[number];

export const gmailSendScope =
  "https://www.googleapis.com/auth/gmail.send";

export type PreflightSendIntentRecordInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  draftId: string;
  approvedDraftVersionId: string;
  contactId: string;
  contactVersion: number;
  gmailConnectionId: string;
  messagePurpose: SendIntentMessagePurpose;
  followUpIndex: number;
  checkedAt: Date;
  rolling24HourSendLimit: number;
}>;

export type SendIntentPreflightRepositoryResult =
  | Readonly<{
      state: "allowed";
      tokenSecretReference: SecretStoreReference;
      readinessConditions: readonly GmailSendReadinessCondition[];
      gmail: Readonly<{
        connectionId: string;
        primaryEmail: string;
        connectionStatus: "CONNECTED";
        sendAvailability: "AVAILABLE";
        mailSyncCapability: boolean;
      }>;
    }>
  | Readonly<{ state: "draft_not_found" }>
  | Readonly<{ state: "draft_version_stale" }>
  | Readonly<{ state: "contact_version_stale" }>
  | Readonly<{ state: "gmail_connection_not_selected" }>
  | Readonly<{ state: "gmail_reauth_required" }>
  | Readonly<{ state: "gmail_scope_insufficient" }>
  | Readonly<{
      state: "send_policy_rejected";
      message: string;
      retryAt: string | null;
    }>;

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
  readinessSnapshot: GmailSendReadinessSnapshot;
  humanConfirmation: Readonly<{
    confirmed: true;
    confirmedAt: Date;
    readinessSnapshotVersion: string;
  }>;
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
  | Readonly<{
      state: "send_policy_rejected";
      message: string;
      retryAt: string | null;
    }>
  | Readonly<{
      state: "readiness_changed";
      changedConditions: readonly GmailSendReadinessChangedCondition[];
    }>
  | Readonly<{ state: "conflict" }>;

export interface SendIntentPreflightRepository {
  preflight(
    input: PreflightSendIntentRecordInput,
  ): Promise<SendIntentPreflightRepositoryResult>;
}

export interface SendIntentRepository {
  create(
    input: CreateSendIntentRecordInput,
  ): Promise<SendIntentRepositoryResult>;
}

export const sendIntentCreatedEventType =
  "backlinks.send-intent.created.v1";

const internalDraftMetadataSendRejection = Object.freeze({
  state: "send_policy_rejected" as const,
  message:
    "The approved Draft contains internal evidence metadata. Edit and reapprove it before sending.",
  retryAt: null,
});

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

const readinessCondition = (
  code: GmailSendReadinessConditionCode,
  revision: string,
): GmailSendReadinessCondition => Object.freeze({ code, revision });

const readinessChanged = (
  input: CreateSendIntentRecordInput,
  code: GmailSendReadinessConditionCode,
  currentRevision: string | null,
): SendIntentRepositoryResult => ({
  state: "readiness_changed",
  changedConditions: Object.freeze([
    describeGmailSendReadinessChange({
      expected: input.readinessSnapshot,
      code,
      currentRevision,
    }),
  ]),
});

const asRevisionPart = (value: unknown): string | null => {
  if (
    typeof value === "string"
    || (
      typeof value === "number"
      && Number.isSafeInteger(value)
    )
  ) {
    const revision = String(value).trim();
    return revision.length === 0 ? null : revision;
  }
  return null;
};

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
implements SendIntentRepository, SendIntentPreflightRepository {
  readonly #pool: BacklinkTenantPool;

  constructor(dependencies: Readonly<{ pool: BacklinkTenantPool }>) {
    this.#pool = dependencies.pool;
  }

  async preflight(
    input: PreflightSendIntentRecordInput,
  ): Promise<SendIntentPreflightRepositoryResult> {
    if (!Number.isFinite(input.checkedAt.getTime())) {
      throw new TypeError("Send Intent preflight checkedAt must be valid.");
    }
    if (
      !Number.isSafeInteger(input.rolling24HourSendLimit)
      || input.rolling24HourSendLimit < 1
    ) {
      throw new TypeError(
        "Send Intent preflight rolling24HourSendLimit must be positive.",
      );
    }

    return withGmailTenantTransaction(
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

        const draftResult = await transaction.query(
          `SELECT
             draft.status,
             draft.current_version_id AS "currentVersionId",
             draft.approved_version_id AS "approvedVersionId",
             draft.contact_id AS "draftContactId",
             draft.contact_version AS "draftContactVersion",
             version.contact_id AS "versionContactId",
             version.contact_version AS "versionContactVersion",
             version.source AS "draftSource",
             version.subject_text AS "subjectText",
             version.body_text AS "bodyText",
             opportunity.prospect_id AS "prospectId",
             opportunity.recommendation_context_version_id
               AS "recommendationContextVersionId",
             (
               SELECT event.id
                 FROM backlinks.backlink_lifecycle_events AS event
                WHERE event.organization_id=draft.organization_id
                  AND event.workspace_id=draft.workspace_id
                  AND event.website_project_id=draft.website_project_id
                  AND event.aggregate_type='email_draft'
                  AND event.aggregate_id=draft.id
                  AND event.event_type='draft.approval.recorded'
                  AND event.after_state->>'approvedVersionId'=$5
                ORDER BY event.sequence DESC
                LIMIT 1
             ) AS "approvalFactId"
           FROM backlinks.backlink_email_drafts AS draft
           JOIN backlinks.backlink_opportunities AS opportunity
             ON opportunity.organization_id=draft.organization_id
            AND opportunity.workspace_id=draft.workspace_id
            AND opportunity.website_project_id=draft.website_project_id
            AND opportunity.id=draft.opportunity_id
           LEFT JOIN backlinks.backlink_draft_versions AS version
             ON version.organization_id=draft.organization_id
            AND version.workspace_id=draft.workspace_id
            AND version.website_project_id=draft.website_project_id
            AND version.draft_id=draft.id
            AND version.id=draft.current_version_id
          WHERE draft.organization_id=$1
            AND draft.workspace_id=$2
            AND draft.website_project_id=$3
            AND draft.id=$4`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            input.draftId,
            input.approvedDraftVersionId,
          ],
        );
        const draft = draftResult.rows[0];
        if (draft === undefined) return { state: "draft_not_found" };
        if (
          draft.status !== "approved"
          || draft.currentVersionId !== input.approvedDraftVersionId
          || draft.approvedVersionId !== input.approvedDraftVersionId
          || typeof draft.approvalFactId !== "string"
          || draft.draftSource === "TEMPLATE_FALLBACK"
        ) {
          return { state: "draft_version_stale" };
        }
        if (
          typeof draft.subjectText !== "string"
          || typeof draft.bodyText !== "string"
        ) {
          throw new TypeError(
            "Send Intent preflight returned an invalid Draft.",
          );
        }
        if (
          containsInternalDraftMetadataMarker(draft.subjectText)
          || containsInternalDraftMetadataMarker(draft.bodyText)
        ) {
          return internalDraftMetadataSendRejection;
        }
        if (
          draft.draftContactId !== input.contactId
          || draft.draftContactVersion !== input.contactVersion
          || draft.versionContactId !== input.contactId
          || draft.versionContactVersion !== input.contactVersion
        ) {
          return { state: "contact_version_stale" };
        }

        const contactResult = await transaction.query(
          `SELECT contact.version
             FROM backlinks.backlink_contacts AS contact
            WHERE contact.organization_id=$1
              AND contact.workspace_id=$2
              AND contact.website_project_id=$3
              AND contact.id=$4
              AND contact.prospect_id=$5
              AND contact.recommendation_context_version_id=$6
              AND contact.status='active'
              AND contact.guessed=false
              AND contact.invalidated_at IS NULL`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            input.contactId,
            draft.prospectId,
            draft.recommendationContextVersionId,
          ],
        );
        if (contactResult.rows[0]?.version !== input.contactVersion) {
          return { state: "contact_version_stale" };
        }

        const bindingResult = await transaction.query(
          `SELECT
             connection.id AS "connectionId",
             connection.primary_email AS "primaryEmail",
             connection.connection_status AS "connectionStatus",
             connection.send_availability AS "sendAvailability",
             connection.mail_sync_capability AS "mailSyncCapability",
             connection.granted_scopes AS "grantedScopes",
             connection.version AS "connectionVersion",
             binding.version AS "workspaceBindingVersion",
             project_binding.version AS "projectBindingVersion",
             identity.id AS "identityId",
             identity.version AS "identityVersion",
             secret.provider AS "secretProvider",
             secret.secret_kind AS "secretKind",
             secret.external_secret_id AS "externalSecretId",
             secret.external_secret_version AS "externalSecretVersion"
           FROM backlinks.backlink_website_project_mailbox_bindings
             AS project_binding
           JOIN backlinks.backlink_gmail_workspace_bindings AS binding
             ON binding.organization_id=project_binding.organization_id
            AND binding.workspace_id=project_binding.workspace_id
            AND binding.id=project_binding.gmail_workspace_binding_id
           JOIN backlinks.backlink_gmail_connections AS connection
             ON connection.organization_id=binding.organization_id
            AND connection.id=binding.gmail_connection_id
           JOIN backlinks.backlink_secret_references AS secret
             ON secret.organization_id=connection.organization_id
            AND secret.id=connection.token_secret_reference_id
            AND secret.secret_kind=connection.token_secret_kind
            AND secret.secret_kind='GMAIL_TOKEN_SET'
            AND secret.status = 'ACTIVE'
           LEFT JOIN LATERAL (
             SELECT candidate.id, candidate.version
               FROM backlinks.backlink_gmail_send_identities AS candidate
              WHERE candidate.organization_id=connection.organization_id
                AND candidate.gmail_connection_id=connection.id
                AND candidate.verification_status='accepted'
              ORDER BY candidate.is_default DESC,
                       candidate.is_primary DESC,
                       candidate.id
              LIMIT 1
           ) AS identity ON true
          WHERE project_binding.organization_id=$1
            AND project_binding.workspace_id=$2
            AND project_binding.website_project_id=$3
            AND project_binding.binding_status='ACTIVE'
            AND project_binding.is_selected=true
            AND binding.binding_status='ACTIVE'
          LIMIT 1`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
          ],
        );
        const binding = bindingResult.rows[0];
        if (
          binding === undefined
          || binding.connectionId !== input.gmailConnectionId
        ) {
          return { state: "gmail_connection_not_selected" };
        }
        if (binding.connectionStatus !== "CONNECTED") {
          return { state: "gmail_reauth_required" };
        }
        const grantedScopes = Array.isArray(binding.grantedScopes)
          ? binding.grantedScopes
          : [];
        if (!grantedScopes.includes(gmailSendScope)) {
          return { state: "gmail_scope_insufficient" };
        }
        if (
          binding.sendAvailability !== "AVAILABLE"
          || typeof binding.identityId !== "string"
        ) {
          return {
            state: "send_policy_rejected",
            message:
              "The selected Gmail identity is paused or no longer approved for sending.",
            retryAt: null,
          };
        }
        const tokenSecretReference = secretStoreReferenceSchema.safeParse({
          provider: binding.secretProvider,
          secretKind: binding.secretKind,
          externalSecretId: binding.externalSecretId,
          externalSecretVersion: binding.externalSecretVersion,
        });
        if (!tokenSecretReference.success) {
          return { state: "gmail_reauth_required" };
        }

        const policyResult = await transaction.query(
          `SELECT
             EXISTS (
               SELECT 1
                 FROM backlinks.backlink_suppression_entries AS entry
                WHERE entry.organization_id=$1
                  AND entry.status='ACTIVE'
                  AND (
                    entry.workspace_id IS NULL
                    OR (
                      entry.workspace_id=$2
                      AND entry.website_project_id=$3
                    )
                  )
             ) AS suppressed,
             (
               SELECT string_agg(
                 entry.id::text || ':' || entry.version::text,
                 ',' ORDER BY entry.id
               )
                 FROM backlinks.backlink_suppression_entries AS entry
                WHERE entry.organization_id=$1
                  AND entry.status='ACTIVE'
                  AND (
                    entry.workspace_id IS NULL
                    OR (
                      entry.workspace_id=$2
                      AND entry.website_project_id=$3
                    )
                  )
             ) AS "suppressionRevision",
             (
               SELECT switch.blocked
                 FROM backlinks.backlink_kill_switch_versions AS switch
                WHERE switch.organization_id=$1
                  AND switch.workspace_id=$2
                  AND switch.website_project_id=$3
                  AND switch.capability='GMAIL_SEND'
                ORDER BY switch.version DESC
                LIMIT 1
             ) AS "sendBlocked",
             (
               SELECT switch.version
                 FROM backlinks.backlink_kill_switch_versions AS switch
                WHERE switch.organization_id=$1
                  AND switch.workspace_id=$2
                  AND switch.website_project_id=$3
                  AND switch.capability='GMAIL_SEND'
                ORDER BY switch.version DESC
                LIMIT 1
             ) AS "sendBlockVersion",
             (
               SELECT max(
                 intent.requested_send_at + interval '30 days'
               )
                 FROM backlinks.backlink_send_intents AS intent
                WHERE $7='INITIAL_OUTREACH'
                  AND intent.organization_id=$1
                  AND intent.workspace_id=$2
                  AND intent.contact_id=$4
                  AND intent.message_purpose='INITIAL_OUTREACH'
                  AND intent.status NOT IN (
                    'CANCELLED', 'REJECTED', 'FAILED_FINAL'
                  )
             ) AS "cooldownRetryAt",
             count(*) FILTER (
               WHERE (
                 reservation.status='CONSUMED'
                 AND reservation.consumed_at >
                   $6::timestamptz - interval '24 hours'
               )
               OR (
                 reservation.status='RESERVED'
                 AND reservation.expires_at > $6::timestamptz
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
                 reservation.status='CONSUMED'
                 AND reservation.consumed_at >
                   $6::timestamptz - interval '24 hours'
               )
               OR (
                 reservation.status='RESERVED'
                 AND reservation.expires_at > $6::timestamptz
               )
             ) AS "nextSlotAt"
           FROM backlinks.backlink_rate_limit_reservations AS reservation
          WHERE reservation.organization_id=$1
            AND reservation.gmail_connection_id=$5`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            input.contactId,
            input.gmailConnectionId,
            input.checkedAt,
            input.messagePurpose,
          ],
        );
        const policy = policyResult.rows[0];
        if (policy === undefined) {
          throw new TypeError(
            "Send Intent preflight returned no policy result.",
          );
        }
        if (policy.suppressed === true) {
          return {
            state: "send_policy_rejected",
            message:
              "Sending is blocked by an active suppression or unsubscribe record.",
            retryAt: null,
          };
        }
        if (policy.sendBlocked !== false) {
          return {
            state: "send_policy_rejected",
            message:
              "The Gmail Send Kill Switch is closed for this project.",
            retryAt: null,
          };
        }
        if (
          policy.cooldownRetryAt !== null
          && policy.cooldownRetryAt !== undefined
        ) {
          const retryAt = asDate(
            policy.cooldownRetryAt,
            "preflight cooldown retry_at",
          );
          if (retryAt.getTime() > input.checkedAt.getTime()) {
            return {
              state: "send_policy_rejected",
              message:
                `Initial outreach is paused until ${retryAt.toISOString()}.`,
              retryAt: retryAt.toISOString(),
            };
          }
        }
        const usedSlots = policy.usedSlots;
        if (
          typeof usedSlots !== "number"
          || !Number.isSafeInteger(usedSlots)
        ) {
          throw new TypeError(
            "Send Intent preflight returned invalid quota usage.",
          );
        }
        if (usedSlots >= input.rolling24HourSendLimit) {
          return {
            state: "send_policy_rejected",
            message:
              `Gmail rolling quota of ${input.rolling24HourSendLimit} is exhausted.`,
            retryAt: asNullableIso(policy.nextSlotAt),
          };
        }
        if (
          typeof binding.primaryEmail !== "string"
          || typeof binding.mailSyncCapability !== "boolean"
          || !Number.isSafeInteger(binding.connectionVersion)
          || !Number.isSafeInteger(binding.workspaceBindingVersion)
          || !Number.isSafeInteger(binding.projectBindingVersion)
          || !Number.isSafeInteger(binding.identityVersion)
          || typeof binding.externalSecretVersion !== "string"
          || !Number.isSafeInteger(policy.sendBlockVersion)
        ) {
          throw new TypeError(
            "Send Intent preflight returned an invalid Gmail binding.",
          );
        }
        return {
          state: "allowed",
          tokenSecretReference: tokenSecretReference.data,
          readinessConditions: Object.freeze([
            readinessCondition(
              "DRAFT_APPROVAL",
              `${input.approvedDraftVersionId}:${draft.approvalFactId}`,
            ),
            readinessCondition(
              "CONTACT_VERSION",
              `${input.contactId}:${input.contactVersion}`,
            ),
            readinessCondition(
              "GMAIL_BINDING",
              [
                input.gmailConnectionId,
                binding.connectionVersion,
                binding.workspaceBindingVersion,
                binding.projectBindingVersion,
                binding.externalSecretVersion,
              ].join(":"),
            ),
            readinessCondition(
              "GMAIL_IDENTITY",
              `${binding.identityId}:${binding.identityVersion}`,
            ),
            readinessCondition("SUPPRESSION", "CLEAR"),
            readinessCondition(
              "KILL_SWITCH",
              `${policy.sendBlockVersion}:OPEN`,
            ),
            readinessCondition("COOLDOWN", "CLEAR"),
            readinessCondition(
              "QUOTA",
              `${usedSlots}/${input.rolling24HourSendLimit}`,
            ),
          ]),
          gmail: Object.freeze({
            connectionId: input.gmailConnectionId,
            primaryEmail: binding.primaryEmail,
            connectionStatus: "CONNECTED",
            sendAvailability: "AVAILABLE",
            mailSyncCapability: binding.mailSyncCapability,
          }),
        };
      },
    );
  }

  async create(
    input: CreateSendIntentRecordInput,
  ): Promise<SendIntentRepositoryResult> {
    if (!Number.isFinite(input.requestedSendAt.getTime())) {
      throw new TypeError("Send Intent requestedSendAt must be valid.");
    }
    if (
      input.humanConfirmation.confirmed !== true
      || !Number.isFinite(input.humanConfirmation.confirmedAt.getTime())
      || input.humanConfirmation.readinessSnapshotVersion
        !== input.readinessSnapshot.snapshotVersion
    ) {
      throw new TypeError(
        "Send Intent requires confirmation of the submitted readiness snapshot.",
      );
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

          const replayExisting = async (
            existing: Record<string, unknown>,
            expectedLogicalMessageKey: string,
            allowClientKeyMatch: boolean,
          ): Promise<SendIntentRepositoryResult> => {
            const matchesClientKey = allowClientKeyMatch
              && existing.clientIdempotencyKey
                === input.clientIdempotencyKey;
            if (
              existing.draftId !== input.draftId
              || existing.approvedDraftVersionId
                !== input.approvedDraftVersionId
              || existing.contactId !== input.contactId
              || existing.contactVersion !== input.contactVersion
              || existing.gmailConnectionId !== input.gmailConnectionId
              || (
                !matchesClientKey
                && existing.logicalMessageKey
                  !== expectedLogicalMessageKey
              )
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
          };

          const replayBlockingExisting = async (
            rows: readonly Record<string, unknown>[],
            expectedLogicalMessageKey: string,
            allowClientKeyMatch: boolean,
          ): Promise<SendIntentRepositoryResult | null> => {
            const clientMatches = allowClientKeyMatch
              ? rows.filter(
                  (row) =>
                    row.clientIdempotencyKey
                      === input.clientIdempotencyKey,
                )
              : [];
            if (clientMatches.length > 1) {
              return { state: "conflict" };
            }
            if (clientMatches[0] !== undefined) {
              return replayExisting(
                clientMatches[0],
                expectedLogicalMessageKey,
                true,
              );
            }

            const blockingLogicalMatches = rows.filter(
              (row) =>
                row.logicalMessageKey === expectedLogicalMessageKey
                && !canReplaceFailedSendIntent({
                  intentStatus: row.intentStatus,
                  attemptStatus: row.attemptStatus,
                  errorCode: row.errorCode,
                  providerMessageId: row.providerMessageId,
                  providerThreadId: row.providerThreadId,
                }),
            );
            if (blockingLogicalMatches.length > 1) {
              return { state: "conflict" };
            }
            if (blockingLogicalMatches[0] !== undefined) {
              return replayExisting(
                blockingLogicalMatches[0],
                expectedLogicalMessageKey,
                false,
              );
            }
            return null;
          };

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
               intent.requested_send_at AS "requestedSendAt",
               intent.status AS "intentStatus",
               attempt.status AS "attemptStatus",
               coalesce(
                 attempt.provider_error_code,
                 reservation.release_reason
               ) AS "errorCode",
               attempt.provider_message_id AS "providerMessageId",
               attempt.provider_thread_id AS "providerThreadId"
             FROM backlinks.backlink_send_intents AS intent
             LEFT JOIN backlinks.backlink_rate_limit_reservations AS reservation
               ON reservation.organization_id = intent.organization_id
              AND reservation.workspace_id = intent.workspace_id
              AND reservation.website_project_id = intent.website_project_id
              AND reservation.send_intent_id = intent.id
             LEFT JOIN LATERAL (
               SELECT latest.status,
                      latest.provider_error_code,
                      latest.provider_message_id,
                      latest.provider_thread_id
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
              AND (
                intent.client_idempotency_key = $4
                OR intent.logical_message_key = $5
              )
            ORDER BY intent.requested_send_at DESC, intent.id DESC
            FOR UPDATE OF intent`,
            [
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              input.clientIdempotencyKey,
              input.logicalMessageKey,
            ],
          );
          const existingReplay = await replayBlockingExisting(
            existingResult.rows,
            input.logicalMessageKey,
            true,
          );
          if (existingReplay !== null) {
            return existingReplay;
          }

          const snapshotValidityChanges =
            compareGmailSendReadinessSnapshot({
              expected: input.readinessSnapshot,
              currentConditions: input.readinessSnapshot.conditions,
              comparedAt: input.requestedSendAt,
            });
          if (snapshotValidityChanges.length > 0) {
            return {
              state: "readiness_changed",
              changedConditions: snapshotValidityChanges,
            };
          }
          const snapshotEvaluatedAt = asDate(
            input.readinessSnapshot.evaluatedAt,
            "readiness evaluated_at",
          );
          if (
            input.humanConfirmation.confirmedAt.getTime()
              < snapshotEvaluatedAt.getTime()
            || input.humanConfirmation.confirmedAt.getTime()
              > input.requestedSendAt.getTime() + 60_000
          ) {
            return {
              state: "readiness_changed",
              changedConditions: Object.freeze([
                describeGmailSendReadinessSnapshotValidity({
                  expected: input.readinessSnapshot,
                  reason: "CHANGED",
                  currentRevision: "HUMAN_CONFIRMATION_OUT_OF_WINDOW",
                }),
              ]),
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
               version.source AS "draftSource",
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
            return readinessChanged(input, "DRAFT_APPROVAL", null);
          }
          if (
            draft.status !== "approved"
            || draft.currentVersionId !== input.approvedDraftVersionId
            || draft.approvedVersionId !== input.approvedDraftVersionId
            || draft.draftSource === "TEMPLATE_FALLBACK"
          ) {
            return readinessChanged(input, "DRAFT_APPROVAL", null);
          }
          if (
            draft.draftContactId !== input.contactId
            || draft.draftContactVersion !== input.contactVersion
            || draft.versionContactId !== input.contactId
            || draft.versionContactVersion !== input.contactVersion
          ) {
            return readinessChanged(
              input,
              "CONTACT_VERSION",
              asRevisionPart(draft.draftContactVersion) === null
                ? null
                : `${input.contactId}:${draft.draftContactVersion}`,
            );
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
          if (
            containsInternalDraftMetadataMarker(draft.subjectText)
            || containsInternalDraftMetadataMarker(draft.bodyText)
          ) {
            return internalDraftMetadataSendRejection;
          }

          const approvalResult = await transaction.query(
            `SELECT
               event.id AS "approvalFactId",
               event.actor_id AS "approvalActorId",
               COALESCE(
                 (event.after_state->>'occurredAt')::timestamptz,
                 event.created_at
               ) AS "approvalRecordedAt"
             FROM backlinks.backlink_lifecycle_events AS event
            WHERE event.organization_id = $1
              AND event.workspace_id = $2
              AND event.website_project_id = $3
              AND event.aggregate_type = 'email_draft'
              AND event.aggregate_id = $4
              AND event.event_type = 'draft.approval.recorded'
              AND event.after_state->>'approvedVersionId' = $5
            ORDER BY event.sequence DESC
            LIMIT 1
            FOR SHARE`,
            [
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              input.draftId,
              input.approvedDraftVersionId,
            ],
          );
          const approval = approvalResult.rows[0];
          if (approval === undefined) {
            return readinessChanged(input, "DRAFT_APPROVAL", null);
          }
          if (
            typeof approval.approvalFactId !== "string"
            || typeof approval.approvalActorId !== "string"
          ) {
            throw new TypeError(
              "Send Intent persistence returned an invalid approval fact.",
            );
          }
          const approvalRecordedAt = asDate(
            approval.approvalRecordedAt,
            "approval recorded_at",
          );

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
            return readinessChanged(input, "CONTACT_VERSION", null);
          }
          if (contact.contactVersion !== input.contactVersion) {
            return readinessChanged(
              input,
              "CONTACT_VERSION",
              asRevisionPart(contact.contactVersion) === null
                ? null
                : `${input.contactId}:${contact.contactVersion}`,
            );
          }
          if (typeof contact.normalizedEmail !== "string") {
            throw new TypeError(
              "Send Intent persistence returned an invalid Contact.",
            );
          }
          const recipient = contact.normalizedEmail.trim().toLowerCase();
          const logicalMessageKey = sha256(canonicalJson({
            schema: "backlinks.send-intent.logical-key.v3",
            websiteProjectId: input.websiteProjectId,
            draftId: input.draftId,
            approvedDraftVersionId: input.approvedDraftVersionId,
            recipient,
            approvalFactId: approval.approvalFactId,
            messagePurpose: input.messagePurpose,
            followUpIndex: input.followUpIndex,
          }));
          const logicalExistingResult = await transaction.query(
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
               intent.requested_send_at AS "requestedSendAt",
               intent.status AS "intentStatus",
               attempt.status AS "attemptStatus",
               coalesce(
                 attempt.provider_error_code,
                 reservation.release_reason
               ) AS "errorCode",
               attempt.provider_message_id AS "providerMessageId",
               attempt.provider_thread_id AS "providerThreadId"
             FROM backlinks.backlink_send_intents AS intent
             LEFT JOIN backlinks.backlink_rate_limit_reservations AS reservation
               ON reservation.organization_id = intent.organization_id
              AND reservation.workspace_id = intent.workspace_id
              AND reservation.website_project_id = intent.website_project_id
              AND reservation.send_intent_id = intent.id
             LEFT JOIN LATERAL (
               SELECT latest.status,
                      latest.provider_error_code,
                      latest.provider_message_id,
                      latest.provider_thread_id
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
              AND intent.logical_message_key = $4
            ORDER BY intent.requested_send_at DESC, intent.id DESC
            FOR UPDATE OF intent`,
            [
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
              logicalMessageKey,
            ],
          );
          const logicalReplay = await replayBlockingExisting(
            logicalExistingResult.rows,
            logicalMessageKey,
            false,
          );
          if (logicalReplay !== null) {
            return logicalReplay;
          }

          const bindingResult = await transaction.query(
            `SELECT connection.version AS "gmailConnectionVersion",
                    binding.version AS "workspaceBindingVersion",
                    project_binding.version AS "projectBindingVersion",
                    secret.external_secret_version
                      AS "externalSecretVersion",
                    identity.id AS "gmailIdentityId",
                    identity.version AS "gmailIdentityVersion"
               FROM backlinks.backlink_gmail_workspace_bindings AS binding
               JOIN backlinks.backlink_website_project_mailbox_bindings AS project_binding
                 ON project_binding.organization_id = binding.organization_id
                AND project_binding.workspace_id = binding.workspace_id
                AND project_binding.gmail_workspace_binding_id = binding.id
               JOIN backlinks.backlink_gmail_connections AS connection
                 ON connection.organization_id = binding.organization_id
                AND connection.id = binding.gmail_connection_id
               JOIN backlinks.backlink_secret_references AS secret
                 ON secret.organization_id = connection.organization_id
                AND secret.id = connection.token_secret_reference_id
                AND secret.secret_kind = connection.token_secret_kind
                AND secret.secret_kind = 'GMAIL_TOKEN_SET'
                AND secret.status = 'ACTIVE'
               LEFT JOIN LATERAL (
                 SELECT candidate.id, candidate.version
                   FROM backlinks.backlink_gmail_send_identities AS candidate
                  WHERE candidate.organization_id=connection.organization_id
                    AND candidate.gmail_connection_id=connection.id
                    AND candidate.verification_status='accepted'
                  ORDER BY candidate.is_default DESC,
                           candidate.is_primary DESC,
                           candidate.id
                  LIMIT 1
               ) AS identity ON true
                WHERE binding.organization_id = $1
                  AND binding.workspace_id = $2
                  AND binding.gmail_connection_id = $3
                  AND binding.binding_status = 'ACTIVE'
                  AND project_binding.website_project_id = $4
                  AND project_binding.binding_status = 'ACTIVE'
                  AND project_binding.is_selected = true
                AND connection.connection_status = 'CONNECTED'
                AND connection.send_availability = 'AVAILABLE'
                AND connection.granted_scopes @> $5::jsonb
              LIMIT 1
              FOR SHARE OF binding, project_binding, connection, secret`,
            [
                input.organizationId,
                input.workspaceId,
                input.gmailConnectionId,
                input.websiteProjectId,
                JSON.stringify([gmailSendScope]),
            ],
          );
          const gmailBinding = bindingResult.rows[0];
          if (gmailBinding === undefined) {
            return readinessChanged(input, "GMAIL_BINDING", null);
          }
          if (
            typeof gmailBinding.gmailConnectionVersion !== "number"
            || !Number.isSafeInteger(gmailBinding.gmailConnectionVersion)
            || !Number.isSafeInteger(gmailBinding.workspaceBindingVersion)
            || !Number.isSafeInteger(gmailBinding.projectBindingVersion)
            || typeof gmailBinding.externalSecretVersion !== "string"
          ) {
            throw new TypeError(
              "Send Intent persistence returned an invalid Gmail binding.",
            );
          }
          if (
            typeof gmailBinding.gmailIdentityId !== "string"
            || !Number.isSafeInteger(gmailBinding.gmailIdentityVersion)
          ) {
            return readinessChanged(input, "GMAIL_IDENTITY", null);
          }

          const policyResult = await transaction.query(
            `SELECT
               EXISTS (
                 SELECT 1
                   FROM backlinks.backlink_suppression_entries AS entry
                  WHERE entry.organization_id=$1
                    AND entry.status='ACTIVE'
                    AND (
                      entry.workspace_id IS NULL
                      OR (
                        entry.workspace_id=$2
                        AND entry.website_project_id=$3
                      )
                    )
               ) AS suppressed,
               (
                 SELECT string_agg(
                   entry.id::text || ':' || entry.version::text,
                   ',' ORDER BY entry.id
                 )
                   FROM backlinks.backlink_suppression_entries AS entry
                  WHERE entry.organization_id=$1
                    AND entry.status='ACTIVE'
                    AND (
                      entry.workspace_id IS NULL
                      OR (
                        entry.workspace_id=$2
                        AND entry.website_project_id=$3
                      )
                    )
               ) AS "suppressionRevision",
               (
                 SELECT switch.blocked
                   FROM backlinks.backlink_kill_switch_versions AS switch
                  WHERE switch.organization_id=$1
                    AND switch.workspace_id=$2
                    AND switch.website_project_id=$3
                    AND switch.capability='GMAIL_SEND'
                  ORDER BY switch.version DESC
                  LIMIT 1
               ) AS "sendBlocked",
               (
                 SELECT switch.version
                   FROM backlinks.backlink_kill_switch_versions AS switch
                  WHERE switch.organization_id=$1
                    AND switch.workspace_id=$2
                    AND switch.website_project_id=$3
                    AND switch.capability='GMAIL_SEND'
                  ORDER BY switch.version DESC
                  LIMIT 1
               ) AS "sendBlockVersion"`,
            [
              input.organizationId,
              input.workspaceId,
              input.websiteProjectId,
            ],
          );
          const policy = policyResult.rows[0];
          if (policy === undefined) {
            throw new TypeError(
              "Send Intent persistence returned no send policy.",
            );
          }
          if (policy.suppressed === true) {
            return readinessChanged(
              input,
              "SUPPRESSION",
              asRevisionPart(policy.suppressionRevision),
            );
          }
          if (
            policy.sendBlocked !== false
            || !Number.isSafeInteger(policy.sendBlockVersion)
          ) {
            return readinessChanged(
              input,
              "KILL_SWITCH",
              asRevisionPart(policy.sendBlockVersion) === null
                ? null
                : `${policy.sendBlockVersion}:BLOCKED`,
            );
          }

          let cooldownRevision = "CLEAR";
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
                cooldownRevision = retryAt.toISOString();
                return readinessChanged(
                  input,
                  "COOLDOWN",
                  cooldownRevision,
                );
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
            return readinessChanged(
              input,
              "QUOTA",
              `${usedSlots}/${input.rolling24HourSendLimit}`,
            );
          }

          const readinessChanges = compareGmailSendReadinessSnapshot({
            expected: input.readinessSnapshot,
            comparedAt: input.requestedSendAt,
            currentConditions: [
              readinessCondition(
                "DRAFT_APPROVAL",
                `${input.approvedDraftVersionId}:${approval.approvalFactId}`,
              ),
              readinessCondition(
                "CONTACT_VERSION",
                `${input.contactId}:${contact.contactVersion}`,
              ),
              readinessCondition(
                "GMAIL_BINDING",
                [
                  input.gmailConnectionId,
                  gmailBinding.gmailConnectionVersion,
                  gmailBinding.workspaceBindingVersion,
                  gmailBinding.projectBindingVersion,
                  gmailBinding.externalSecretVersion,
                ].join(":"),
              ),
              readinessCondition(
                "GMAIL_IDENTITY",
                `${gmailBinding.gmailIdentityId}:`
                  + gmailBinding.gmailIdentityVersion,
              ),
              readinessCondition("SUPPRESSION", "CLEAR"),
              readinessCondition(
                "KILL_SWITCH",
                `${policy.sendBlockVersion}:OPEN`,
              ),
              readinessCondition("COOLDOWN", cooldownRevision),
              readinessCondition(
                "QUOTA",
                `${usedSlots}/${input.rolling24HourSendLimit}`,
              ),
            ],
          });
          if (readinessChanges.length > 0) {
            return {
              state: "readiness_changed",
              changedConditions: readinessChanges,
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
              logicalMessageKey,
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
               approval_fact_id, approval_actor_id, approval_recorded_at,
               snapshot_schema_version, created_at, created_by
             ) VALUES (
               $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16, $17, $18,
               $19, $20, $21, $22, $23, $24, $25, 2, $26, $27
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
              approval.approvalFactId,
              approval.approvalActorId,
              approvalRecordedAt,
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
                approvalFactId: approval.approvalFactId,
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
