import { randomUUID } from "node:crypto";

import type {
  DeliveryFeedbackRepository,
  RecordedDeliveryFeedback,
  RecordDeliveryFeedbackInput,
  ReleasedEmailSuppression,
  ReleaseEmailSuppressionInput,
} from "../commands/delivery-feedback.command.js";
import {
  assertSuppressionReleaseAllowed,
  deliveryFeedbackKinds,
  evaluateDeliveryFeedbackPolicy,
  type DeliveryFeedbackKind,
} from "../../domain/sending/delivery-feedback.js";
import { assertEmailSuppressionTarget } from "../../domain/sending/suppression.js";
import { withGmailTenantTransaction } from "../../db/gmail-tenant-transaction.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";
import {
  suppressionReasons,
  type SuppressionReason,
} from "./send-suppression.repository.js";

type PostgresqlDeliveryFeedbackRepositoryDependencies = Readonly<{
  pool: BacklinkTenantPool;
  newId?: () => string;
}>;

const feedbackKindSet = new Set<string>(Object.values(deliveryFeedbackKinds));
const suppressionReasonSet = new Set<string>(suppressionReasons);

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

const feedbackFromRow = (
  row: Record<string, unknown>,
): RecordedDeliveryFeedback => {
  const feedbackId = row.feedbackId;
  const action = row.action;
  const suppressionReason = row.suppressionReason;
  if (
    typeof feedbackId !== "string"
    || (action !== "RECORD_ONLY" && action !== "SUPPRESS")
    || (
      suppressionReason !== null
      && (
        typeof suppressionReason !== "string"
        || !suppressionReasonSet.has(suppressionReason)
      )
    )
    || (action === "SUPPRESS" && suppressionReason === null)
    || (action === "RECORD_ONLY" && suppressionReason !== null)
  ) {
    throw new TypeError("Delivery feedback persistence returned an invalid row.");
  }
  return Object.freeze({
    feedbackId,
    action,
    suppressionReason: suppressionReason as SuppressionReason | null,
  });
};

const releaseFromRow = (
  row: Record<string, unknown>,
): ReleasedEmailSuppression => {
  const suppressionId = row.suppressionId;
  const reason = row.reason;
  const status = row.status;
  const version = row.version;
  if (
    typeof suppressionId !== "string"
    || typeof reason !== "string"
    || !suppressionReasonSet.has(reason)
    || status !== "RELEASED"
    || typeof version !== "number"
    || !Number.isSafeInteger(version)
    || version < 2
  ) {
    throw new TypeError("Suppression release persistence returned an invalid row.");
  }
  return Object.freeze({
    suppressionId,
    reason: reason as SuppressionReason,
    status,
    version,
  });
};

const countFromRow = (row: Record<string, unknown>): number => {
  const count = row.count;
  if (
    typeof count !== "number"
    || !Number.isSafeInteger(count)
    || count < 0
  ) {
    throw new TypeError("Soft bounce count is invalid.");
  }
  return count;
};

const assertRecordInput = (input: RecordDeliveryFeedbackInput): void => {
  assertNonBlank(input.organizationId, "Delivery feedback organizationId");
  assertNonBlank(input.workspaceId, "Delivery feedback workspaceId");
  assertNonBlank(input.websiteProjectId, "Delivery feedback websiteProjectId");
  assertNonBlank(input.feedbackId, "Delivery feedback feedbackId");
  if (input.feedbackId.length > 255) {
    throw new TypeError("Delivery feedback feedbackId is too long.");
  }
  assertNonBlank(input.actorId, "Delivery feedback actorId");
  assertEmailSuppressionTarget(input.target);
  if (!feedbackKindSet.has(input.kind)) {
    throw new TypeError("Delivery feedback kind is invalid.");
  }
  assertDate(input.observedAt, "Delivery feedback observedAt");
  assertDate(input.recordedAt, "Delivery feedback recordedAt");
  if (input.observedAt.getTime() > input.recordedAt.getTime()) {
    throw new TypeError("Delivery feedback observedAt must not be in the future.");
  }
};

const assertReleaseInput = (input: ReleaseEmailSuppressionInput): void => {
  assertNonBlank(input.organizationId, "Suppression release organizationId");
  assertNonBlank(input.workspaceId, "Suppression release workspaceId");
  assertNonBlank(input.websiteProjectId, "Suppression release websiteProjectId");
  assertNonBlank(input.suppressionId, "Suppression release suppressionId");
  assertNonBlank(input.releaseReason, "Suppression release releaseReason");
  assertNonBlank(input.actorId, "Suppression release actorId");
  assertDate(input.releasedAt, "Suppression release releasedAt");
};

const recordExisting = async (
  transaction: BacklinkTransactionClient,
  input: RecordDeliveryFeedbackInput,
): Promise<RecordedDeliveryFeedback | null> => {
  const result = await transaction.query(
    `SELECT feedback.id AS "feedbackId",
            CASE
              WHEN feedback.applied_suppression_reason IS NULL
                THEN 'RECORD_ONLY'
              ELSE 'SUPPRESS'
            END AS action,
            feedback.applied_suppression_reason AS "suppressionReason"
       FROM backlinks.backlink_suppression_feedback_events AS feedback
      WHERE feedback.organization_id = $1
        AND feedback.source_event_id = $2
      LIMIT 1`,
    [input.organizationId, input.feedbackId],
  );
  const row = result.rows[0];
  return row === undefined ? null : feedbackFromRow(row);
};

export class PostgresqlDeliveryFeedbackRepository
implements DeliveryFeedbackRepository {
  readonly #pool: BacklinkTenantPool;
  readonly #newId: () => string;

  constructor(dependencies: PostgresqlDeliveryFeedbackRepositoryDependencies) {
    this.#pool = dependencies.pool;
    this.#newId = dependencies.newId ?? randomUUID;
  }

  async record(
    input: RecordDeliveryFeedbackInput,
  ): Promise<RecordedDeliveryFeedback> {
    assertRecordInput(input);

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await transaction.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [
          `suppression-feedback:${input.organizationId}:`
          + `${input.target.hashKeyVersion}:${input.target.targetHmac}`,
        ],
      );
      const existing = await recordExisting(transaction, input);
      if (existing !== null) return existing;

      let softBounceCount = 0;
      if (input.kind === deliveryFeedbackKinds.softBounce) {
        const count = await transaction.query(
          `SELECT count(*)::integer AS count
             FROM backlinks.backlink_suppression_feedback_events AS feedback
            WHERE feedback.organization_id = $1
              AND feedback.target_hmac = $2
              AND feedback.hash_key_version = $3
              AND feedback.kind = 'SOFT_BOUNCE'
              AND feedback.observed_at > $4::timestamptz
                - interval '30 days'
              AND feedback.observed_at <= $4::timestamptz`,
          [
            input.organizationId,
            input.target.targetHmac,
            input.target.hashKeyVersion,
            input.observedAt,
          ],
        );
        softBounceCount = countFromRow(count.rows[0] ?? {});
      }
      const decision = evaluateDeliveryFeedbackPolicy({
        kind: input.kind as DeliveryFeedbackKind,
        softBounceCount: softBounceCount + 1,
      });
      const appliedReason = decision.action === "SUPPRESS"
        ? decision.reason
        : null;

      const inserted = await transaction.query(
        `INSERT INTO backlinks.backlink_suppression_feedback_events AS feedback (
           id, organization_id, workspace_id, website_project_id,
           source_event_id, target_hmac, hash_key_version, kind,
           observed_at, recorded_at, applied_suppression_reason, created_by
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
         )
         RETURNING feedback.id AS "feedbackId",
                   CASE
                     WHEN feedback.applied_suppression_reason IS NULL
                       THEN 'RECORD_ONLY'
                     ELSE 'SUPPRESS'
                   END AS action,
                   feedback.applied_suppression_reason AS "suppressionReason"`,
        [
          this.#newId(),
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.feedbackId,
          input.target.targetHmac,
          input.target.hashKeyVersion,
          input.kind,
          input.observedAt,
          input.recordedAt,
          appliedReason,
          input.actorId,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error("Delivery feedback could not be persisted.");
      }

      if (appliedReason !== null) {
        await transaction.query(
          `INSERT INTO backlinks.backlink_suppression_entries AS suppression (
             id, organization_id, workspace_id, website_project_id,
             scope_type, target_type, target_hmac, hash_key_version,
             reason, created_at, updated_at, created_by, updated_by
           ) VALUES (
             $1, $2, NULL, NULL,
             'ORGANIZATION', 'EMAIL', $3, $4,
             $5, $6, $6, $7, $7
           )
           ON CONFLICT DO NOTHING`,
          [
            this.#newId(),
            input.organizationId,
            input.target.targetHmac,
            input.target.hashKeyVersion,
            appliedReason,
            input.recordedAt,
            input.actorId,
          ],
        );
      }
      return feedbackFromRow(row);
    });
  }

  async release(
    input: ReleaseEmailSuppressionInput,
  ): Promise<ReleasedEmailSuppression> {
    assertReleaseInput(input);

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      const loaded = await transaction.query(
        `SELECT suppression.id AS "suppressionId",
                suppression.reason,
                suppression.status,
                suppression.version
           FROM backlinks.backlink_suppression_entries AS suppression
          WHERE suppression.organization_id = $1
            AND suppression.id = $2
          FOR UPDATE`,
        [input.organizationId, input.suppressionId],
      );
      const row = loaded.rows[0];
      if (row === undefined) {
        throw new Error("Suppression entry is unavailable for release.");
      }
      const reason = row.reason;
      const status = row.status;
      if (
        typeof reason !== "string"
        || !suppressionReasonSet.has(reason)
        || status !== "ACTIVE"
      ) {
        throw new Error("Suppression entry is not active.");
      }
      if (reason !== input.suppressionReason) {
        throw new Error("Suppression release reason does not match.");
      }
      assertSuppressionReleaseAllowed({
        reason,
        actorRole: input.actorRole,
      });

      const released = await transaction.query(
        `UPDATE backlinks.backlink_suppression_entries AS suppression
            SET status = 'RELEASED',
                released_at = $3,
                release_reason = $4,
                version = suppression.version + 1,
                updated_at = $3,
                updated_by = $5
          WHERE suppression.organization_id = $1
            AND suppression.id = $2
            AND suppression.status = 'ACTIVE'
        RETURNING suppression.id AS "suppressionId",
                  suppression.reason,
                  suppression.status,
                  suppression.version`,
        [
          input.organizationId,
          input.suppressionId,
          input.releasedAt,
          input.releaseReason,
          input.actorId,
        ],
      );
      const releasedRow = released.rows[0];
      if (releasedRow === undefined) {
        throw new Error("Suppression entry could not be released.");
      }
      return releaseFromRow(releasedRow);
    });
  }
}
