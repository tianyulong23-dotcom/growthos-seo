import { randomUUID } from "node:crypto";

import {
  assertEmailSuppressionTarget,
  type EmailSuppressionTarget,
} from "../../domain/sending/suppression.js";
import { withGmailTenantTransaction } from "../../db/gmail-tenant-transaction.js";
import type { BacklinkTenantPool } from "../../db/tenant-transaction.js";

export const suppressionScopeTypes = Object.freeze({
  organization: "ORGANIZATION",
  websiteProject: "WEBSITE_PROJECT",
} as const);

export type SuppressionScopeType =
  (typeof suppressionScopeTypes)[keyof typeof suppressionScopeTypes];

export const suppressionReasons = Object.freeze([
  "REJECTION",
  "UNSUBSCRIBE",
  "COMPLAINT",
  "LEGAL",
  "SECURITY",
  "HARD_BOUNCE",
  "SOFT_BOUNCE_THRESHOLD",
  "MANUAL",
] as const);

export type SuppressionReason = (typeof suppressionReasons)[number];

export type SuppressionTenantContext = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

export type AddEmailSuppressionInput = SuppressionTenantContext & Readonly<{
  scopeType: SuppressionScopeType;
  target: EmailSuppressionTarget;
  reason: SuppressionReason;
  actorId: string;
  recordedAt: Date;
}>;

export type FindActiveEmailSuppressionInput =
  SuppressionTenantContext & Readonly<{
    targets: readonly EmailSuppressionTarget[];
  }>;

export type ActiveEmailSuppression = Readonly<{
  suppressionId: string;
  scopeType: SuppressionScopeType;
  reason: SuppressionReason;
  createdAt: string;
  version: number;
}>;

export interface EmailSuppressionRepository {
  addEmail(
    input: AddEmailSuppressionInput,
  ): Promise<ActiveEmailSuppression>;
  findActiveEmail(
    input: FindActiveEmailSuppressionInput,
  ): Promise<ActiveEmailSuppression | null>;
}

type PostgresqlEmailSuppressionRepositoryDependencies = Readonly<{
  pool: BacklinkTenantPool;
  newId?: () => string;
}>;

const reasonSet = new Set<string>(suppressionReasons);

const asIso = (value: unknown): string => {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const timestamp = new Date(value);
    if (Number.isFinite(timestamp.getTime())) {
      return timestamp.toISOString();
    }
  }
  throw new TypeError("Suppression persistence returned an invalid timestamp.");
};

const suppressionFromRow = (
  row: Record<string, unknown>,
): ActiveEmailSuppression => {
  const suppressionId = row.suppressionId;
  const scopeType = row.scopeType;
  const reason = row.reason;
  const version = row.version;
  if (
    typeof suppressionId !== "string"
    || (
      scopeType !== suppressionScopeTypes.organization
      && scopeType !== suppressionScopeTypes.websiteProject
    )
    || typeof reason !== "string"
    || !reasonSet.has(reason)
    || typeof version !== "number"
    || !Number.isSafeInteger(version)
    || version < 1
  ) {
    throw new TypeError("Suppression persistence returned an invalid row.");
  }

  return Object.freeze({
    suppressionId,
    scopeType,
    reason: reason as SuppressionReason,
    createdAt: asIso(row.createdAt),
    version,
  });
};

const assertNonBlank = (value: string): void => {
  if (value.trim().length === 0) {
    throw new TypeError("Suppression context values must not be blank.");
  }
};

const assertContext = (context: SuppressionTenantContext): void => {
  assertNonBlank(context.organizationId);
  assertNonBlank(context.workspaceId);
  assertNonBlank(context.websiteProjectId);
};

const selectActiveSuppression = `
  suppression.id AS "suppressionId",
  suppression.scope_type AS "scopeType",
  suppression.reason,
  suppression.created_at AS "createdAt",
  suppression.version`;

export class PostgresqlEmailSuppressionRepository
implements EmailSuppressionRepository {
  readonly #pool: BacklinkTenantPool;
  readonly #newId: () => string;

  constructor(
    dependencies: PostgresqlEmailSuppressionRepositoryDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#newId = dependencies.newId ?? randomUUID;
  }

  async addEmail(
    input: AddEmailSuppressionInput,
  ): Promise<ActiveEmailSuppression> {
    assertContext(input);
    assertNonBlank(input.actorId);
    assertEmailSuppressionTarget(input.target);
    if (!Number.isFinite(input.recordedAt.getTime())) {
      throw new TypeError("Suppression recordedAt must be valid.");
    }

    const workspaceId =
      input.scopeType === suppressionScopeTypes.websiteProject
        ? input.workspaceId
        : null;
    const websiteProjectId =
      input.scopeType === suppressionScopeTypes.websiteProject
        ? input.websiteProjectId
        : null;

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      const inserted = await transaction.query(
        `INSERT INTO backlinks.backlink_suppression_entries AS suppression (
           id, organization_id, workspace_id, website_project_id,
           scope_type, target_type, target_hmac, hash_key_version,
           reason, created_at, updated_at, created_by, updated_by
         ) VALUES (
           $1, $2, $3, $4, $5, 'EMAIL', $6, $7, $8, $9, $9, $10, $10
         )
         ON CONFLICT DO NOTHING
         RETURNING ${selectActiveSuppression}`,
        [
          this.#newId(),
          input.organizationId,
          workspaceId,
          websiteProjectId,
          input.scopeType,
          input.target.targetHmac,
          input.target.hashKeyVersion,
          input.reason,
          input.recordedAt,
          input.actorId,
        ],
      );
      const insertedRow = inserted.rows[0];
      if (insertedRow !== undefined) {
        return suppressionFromRow(insertedRow);
      }

      const existing = await transaction.query(
        `SELECT ${selectActiveSuppression}
           FROM backlinks.backlink_suppression_entries AS suppression
          WHERE suppression.organization_id = $1
            AND suppression.target_type = 'EMAIL'
            AND suppression.target_hmac = $2
            AND suppression.hash_key_version = $3
            AND suppression.status = 'ACTIVE'
            AND (
              (
                $4 = 'ORGANIZATION'
                AND suppression.scope_type = 'ORGANIZATION'
              )
              OR (
                $4 = 'WEBSITE_PROJECT'
                AND suppression.scope_type = 'WEBSITE_PROJECT'
                AND suppression.workspace_id = $5
                AND suppression.website_project_id = $6
              )
            )
          LIMIT 1`,
        [
          input.organizationId,
          input.target.targetHmac,
          input.target.hashKeyVersion,
          input.scopeType,
          input.workspaceId,
          input.websiteProjectId,
        ],
      );
      const existingRow = existing.rows[0];
      if (existingRow === undefined) {
        throw new Error("Active email suppression could not be persisted.");
      }
      return suppressionFromRow(existingRow);
    });
  }

  async findActiveEmail(
    input: FindActiveEmailSuppressionInput,
  ): Promise<ActiveEmailSuppression | null> {
    assertContext(input);
    if (input.targets.length === 0) {
      throw new TypeError("At least one suppression target is required.");
    }

    const uniqueTargets = new Map<string, EmailSuppressionTarget>();
    for (const target of input.targets) {
      assertEmailSuppressionTarget(target);
      uniqueTargets.set(
        `${target.hashKeyVersion}:${target.targetHmac}`,
        target,
      );
    }
    const targets = [...uniqueTargets.values()];

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      const result = await transaction.query(
        `SELECT ${selectActiveSuppression}
           FROM backlinks.backlink_suppression_entries AS suppression
           JOIN unnest($4::text[], $5::integer[])
             AS candidate(target_hmac, hash_key_version)
             ON candidate.target_hmac = suppression.target_hmac
            AND candidate.hash_key_version = suppression.hash_key_version
          WHERE suppression.organization_id = $1
            AND suppression.target_type = 'EMAIL'
            AND suppression.status = 'ACTIVE'
            AND (
              suppression.scope_type = 'ORGANIZATION'
              OR (
                suppression.scope_type = 'WEBSITE_PROJECT'
                AND suppression.workspace_id = $2
                AND suppression.website_project_id = $3
              )
            )
          ORDER BY
            CASE suppression.scope_type
              WHEN 'WEBSITE_PROJECT' THEN 0
              ELSE 1
            END,
            suppression.created_at,
            suppression.id
          LIMIT 1`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          targets.map((target) => target.targetHmac),
          targets.map((target) => target.hashKeyVersion),
        ],
      );
      const row = result.rows[0];
      return row === undefined ? null : suppressionFromRow(row);
    });
  }
}
