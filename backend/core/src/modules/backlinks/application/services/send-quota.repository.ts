import { createHash, randomUUID } from "node:crypto";

import { withGmailTenantTransaction } from "../../db/gmail-tenant-transaction.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionClient,
} from "../../db/tenant-transaction.js";

export const defaultGmailRollingDayLimit = 50;

export const gmailQuotaConsumptionOutcomes = Object.freeze([
  "PROVIDER_ACCEPTED",
  "DELIVERY_UNKNOWN",
] as const);

export type GmailQuotaConsumptionOutcome =
  (typeof gmailQuotaConsumptionOutcomes)[number];

export type GmailQuotaTenantContext = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

export type GmailQuotaReservation = Readonly<{
  reservationId: string;
  sendIntentId: string;
  gmailConnectionId: string;
  laneSequence: number;
  status: "RESERVED" | "CONSUMED" | "RELEASED";
  reservedAt: string;
  eligibleAt: string;
  expiresAt: string;
  consumedAt: string | null;
  releasedAt: string | null;
  releaseReason: string | null;
  version: number;
}>;

export type ReserveGmailDailyQuotaInput =
  GmailQuotaTenantContext & Readonly<{
    sendIntentId: string;
    gmailConnectionId: string;
    dailyLimit: number;
    reservedAt: Date;
    eligibleAt: Date;
    expiresAt: Date;
    actorId: string;
  }>;

export type ConsumeGmailDailyQuotaInput =
  GmailQuotaTenantContext & Readonly<{
    reservationId: string;
    gmailConnectionId: string;
    outcome: GmailQuotaConsumptionOutcome;
    consumedAt: Date;
    actorId: string;
  }>;

export type ReleaseGmailDailyQuotaInput =
  GmailQuotaTenantContext & Readonly<{
    reservationId: string;
    gmailConnectionId: string;
    releasedAt: Date;
    reason: string;
    actorId: string;
  }>;

export interface GmailDailyQuotaRepository {
  reserve(
    input: ReserveGmailDailyQuotaInput,
  ): Promise<GmailQuotaReservation>;
  consume(
    input: ConsumeGmailDailyQuotaInput,
  ): Promise<GmailQuotaReservation>;
  releaseConfirmedNotSent(
    input: ReleaseGmailDailyQuotaInput,
  ): Promise<GmailQuotaReservation>;
}

export class GmailDailyQuotaExceededError extends Error {
  readonly code = "GMAIL_DAILY_QUOTA_EXCEEDED";

  constructor(
    readonly dailyLimit: number,
    readonly retryAt: string | null,
  ) {
    super(`Gmail rolling 24-hour quota of ${dailyLimit} is exhausted.`);
    this.name = "GmailDailyQuotaExceededError";
  }
}

type PostgresqlGmailDailyQuotaRepositoryDependencies = Readonly<{
  pool: BacklinkTenantPool;
  newId?: () => string;
}>;

const statuses = new Set(["RESERVED", "CONSUMED", "RELEASED"]);
const consumptionOutcomes = new Set<string>(gmailQuotaConsumptionOutcomes);

const assertNonBlank = (value: string): void => {
  if (value.trim().length === 0) {
    throw new TypeError("Gmail quota context values must not be blank.");
  }
};

const assertContext = (context: GmailQuotaTenantContext): void => {
  assertNonBlank(context.organizationId);
  assertNonBlank(context.workspaceId);
  assertNonBlank(context.websiteProjectId);
};

const assertValidDate = (value: Date, name: string): void => {
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError(`${name} must be a valid date.`);
  }
};

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
  throw new TypeError("Gmail quota persistence returned an invalid timestamp.");
};

const asNullableIso = (value: unknown): string | null => {
  return value === null ? null : asIso(value);
};

const reservationFromRow = (
  row: Record<string, unknown>,
): GmailQuotaReservation => {
  const reservationId = row.reservationId;
  const sendIntentId = row.sendIntentId;
  const gmailConnectionId = row.gmailConnectionId;
  const laneSequence = row.laneSequence;
  const status = row.status;
  const releaseReason = row.releaseReason;
  const version = row.version;
  if (
    typeof reservationId !== "string"
    || typeof sendIntentId !== "string"
    || typeof gmailConnectionId !== "string"
    || typeof laneSequence !== "number"
    || !Number.isSafeInteger(laneSequence)
    || laneSequence < 1
    || typeof status !== "string"
    || !statuses.has(status)
    || (releaseReason !== null && typeof releaseReason !== "string")
    || typeof version !== "number"
    || !Number.isSafeInteger(version)
    || version < 1
  ) {
    throw new TypeError("Gmail quota persistence returned an invalid row.");
  }

  return Object.freeze({
    reservationId,
    sendIntentId,
    gmailConnectionId,
    laneSequence,
    status: status as GmailQuotaReservation["status"],
    reservedAt: asIso(row.reservedAt),
    eligibleAt: asIso(row.eligibleAt),
    expiresAt: asIso(row.expiresAt),
    consumedAt: asNullableIso(row.consumedAt),
    releasedAt: asNullableIso(row.releasedAt),
    releaseReason,
    version,
  });
};

const selectReservation = `
  reservation.id AS "reservationId",
  reservation.send_intent_id AS "sendIntentId",
  reservation.gmail_connection_id AS "gmailConnectionId",
  reservation.lane_sequence AS "laneSequence",
  reservation.status,
  reservation.reserved_at AS "reservedAt",
  reservation.eligible_at AS "eligibleAt",
  reservation.expires_at AS "expiresAt",
  reservation.consumed_at AS "consumedAt",
  reservation.released_at AS "releasedAt",
  reservation.release_reason AS "releaseReason",
  reservation.version`;

const setConnectionAndLock = async (
  transaction: BacklinkTransactionClient,
  organizationId: string,
  gmailConnectionId: string,
): Promise<void> => {
  await transaction.query(
    `SELECT set_config('app.current_gmail_connection_id', $1, true)`,
    [gmailConnectionId],
  );
  await transaction.query(
    `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
    [`gmail-daily-quota:${organizationId}:${gmailConnectionId}`],
  );
};

const reservationKey = (
  organizationId: string,
  gmailConnectionId: string,
  sendIntentId: string,
): string => {
  return createHash("sha256")
    .update("gmail-quota-reservation:v1")
    .update("\0")
    .update(organizationId)
    .update("\0")
    .update(gmailConnectionId)
    .update("\0")
    .update(sendIntentId)
    .digest("hex");
};

const findReservationForUpdate = async (
  transaction: BacklinkTransactionClient,
  input: GmailQuotaTenantContext & Readonly<{
    reservationId: string;
    gmailConnectionId: string;
  }>,
): Promise<GmailQuotaReservation> => {
  const result = await transaction.query(
    `SELECT ${selectReservation}
       FROM backlinks.backlink_rate_limit_reservations AS reservation
      WHERE reservation.organization_id = $1
        AND reservation.workspace_id = $2
        AND reservation.website_project_id = $3
        AND reservation.id = $4
        AND reservation.gmail_connection_id = $5
      FOR UPDATE`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.reservationId,
      input.gmailConnectionId,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("Gmail quota reservation is unavailable.");
  }
  return reservationFromRow(row);
};

export class PostgresqlGmailDailyQuotaRepository
implements GmailDailyQuotaRepository {
  readonly #pool: BacklinkTenantPool;
  readonly #newId: () => string;

  constructor(
    dependencies: PostgresqlGmailDailyQuotaRepositoryDependencies,
  ) {
    this.#pool = dependencies.pool;
    this.#newId = dependencies.newId ?? randomUUID;
  }

  async reserve(
    input: ReserveGmailDailyQuotaInput,
  ): Promise<GmailQuotaReservation> {
    assertContext(input);
    assertNonBlank(input.sendIntentId);
    assertNonBlank(input.gmailConnectionId);
    assertNonBlank(input.actorId);
    if (!Number.isSafeInteger(input.dailyLimit) || input.dailyLimit < 1) {
      throw new TypeError("Gmail dailyLimit must be a positive integer.");
    }
    assertValidDate(input.reservedAt, "Gmail quota reservedAt");
    assertValidDate(input.eligibleAt, "Gmail quota eligibleAt");
    assertValidDate(input.expiresAt, "Gmail quota expiresAt");
    if (
      input.eligibleAt.getTime() < input.reservedAt.getTime()
      || input.expiresAt.getTime() <= input.eligibleAt.getTime()
    ) {
      throw new TypeError("Gmail quota reservation dates are out of order.");
    }

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await setConnectionAndLock(
        transaction,
        input.organizationId,
        input.gmailConnectionId,
      );

      const binding = await transaction.query(
        `SELECT 1
           FROM backlinks.backlink_gmail_workspace_bindings AS binding
            WHERE binding.organization_id = $1
              AND binding.workspace_id = $2
              AND binding.gmail_connection_id = $3
              AND binding.website_project_id = $4
              AND binding.binding_status = 'ACTIVE'
          LIMIT 1`,
        [
          input.organizationId,
          input.workspaceId,
          input.gmailConnectionId,
          input.websiteProjectId,
        ],
      );
      if (binding.rows[0] === undefined) {
        throw new Error("Gmail connection is not active for this workspace.");
      }

      const intent = await transaction.query(
        `SELECT intent.id
           FROM backlinks.backlink_send_intents AS intent
          WHERE intent.organization_id = $1
            AND intent.workspace_id = $2
            AND intent.website_project_id = $3
            AND intent.id = $4
            AND intent.gmail_connection_id = $5
          LIMIT 1`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.sendIntentId,
          input.gmailConnectionId,
        ],
      );
      if (intent.rows[0] === undefined) {
        throw new Error("Gmail send intent is unavailable.");
      }

      const existing = await transaction.query(
        `SELECT ${selectReservation}
           FROM backlinks.backlink_rate_limit_reservations AS reservation
          WHERE reservation.organization_id = $1
            AND reservation.workspace_id = $2
            AND reservation.website_project_id = $3
            AND reservation.send_intent_id = $4
            AND reservation.gmail_connection_id = $5
          LIMIT 1`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.sendIntentId,
          input.gmailConnectionId,
        ],
      );
      const existingRow = existing.rows[0];
      if (existingRow !== undefined) {
        return reservationFromRow(existingRow);
      }

      const usage = await transaction.query(
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
             AS "lastLaneSequence"
         FROM backlinks.backlink_rate_limit_reservations AS reservation
        WHERE reservation.organization_id = $1
          AND reservation.gmail_connection_id = $2`,
        [
          input.organizationId,
          input.gmailConnectionId,
          input.reservedAt,
        ],
      );
      const usageRow = usage.rows[0];
      if (usageRow === undefined) {
        throw new TypeError("Gmail quota persistence returned no usage.");
      }
      const usedSlots = usageRow.usedSlots;
      const lastLaneSequence = usageRow.lastLaneSequence;
      if (
        typeof usedSlots !== "number"
        || !Number.isSafeInteger(usedSlots)
        || typeof lastLaneSequence !== "number"
        || !Number.isSafeInteger(lastLaneSequence)
      ) {
        throw new TypeError("Gmail quota persistence returned invalid usage.");
      }
      if (usedSlots >= input.dailyLimit) {
        throw new GmailDailyQuotaExceededError(
          input.dailyLimit,
          asNullableIso(usageRow.nextSlotAt),
        );
      }

      const inserted = await transaction.query(
        `INSERT INTO backlinks.backlink_rate_limit_reservations
           AS reservation (
             id, organization_id, workspace_id, website_project_id,
             send_intent_id, gmail_connection_id, reservation_key,
             lane_sequence, status, reserved_at, eligible_at, expires_at,
             created_by, updated_by
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, 'RESERVED', $9, $10, $11,
             $12, $12
           )
           RETURNING ${selectReservation}`,
        [
          this.#newId(),
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.sendIntentId,
          input.gmailConnectionId,
          reservationKey(
            input.organizationId,
            input.gmailConnectionId,
            input.sendIntentId,
          ),
          lastLaneSequence + 1,
          input.reservedAt,
          input.eligibleAt,
          input.expiresAt,
          input.actorId,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error("Gmail quota reservation could not be persisted.");
      }
      return reservationFromRow(row);
    });
  }

  async consume(
    input: ConsumeGmailDailyQuotaInput,
  ): Promise<GmailQuotaReservation> {
    assertContext(input);
    assertNonBlank(input.reservationId);
    assertNonBlank(input.gmailConnectionId);
    assertNonBlank(input.actorId);
    assertValidDate(input.consumedAt, "Gmail quota consumedAt");
    if (!consumptionOutcomes.has(input.outcome)) {
      throw new TypeError("Gmail quota consumption outcome is invalid.");
    }

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await setConnectionAndLock(
        transaction,
        input.organizationId,
        input.gmailConnectionId,
      );
      const reservation = await findReservationForUpdate(transaction, input);
      if (reservation.status === "CONSUMED") {
        return reservation;
      }
      if (reservation.status === "RELEASED") {
        throw new Error(
          "Released Gmail quota reservation cannot be consumed.",
        );
      }

      const updated = await transaction.query(
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
            AND reservation.gmail_connection_id = $5
          RETURNING ${selectReservation}`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.reservationId,
          input.gmailConnectionId,
          input.consumedAt,
          input.actorId,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error("Gmail quota reservation could not be consumed.");
      }
      return reservationFromRow(row);
    });
  }

  async releaseConfirmedNotSent(
    input: ReleaseGmailDailyQuotaInput,
  ): Promise<GmailQuotaReservation> {
    assertContext(input);
    assertNonBlank(input.reservationId);
    assertNonBlank(input.gmailConnectionId);
    assertNonBlank(input.actorId);
    assertNonBlank(input.reason);
    assertValidDate(input.releasedAt, "Gmail quota releasedAt");

    return withGmailTenantTransaction(this.#pool, input, async (transaction) => {
      await setConnectionAndLock(
        transaction,
        input.organizationId,
        input.gmailConnectionId,
      );
      const reservation = await findReservationForUpdate(transaction, input);
      if (reservation.status === "RELEASED") {
        return reservation;
      }
      if (reservation.status === "CONSUMED") {
        throw new Error(
          "Consumed Gmail quota reservation cannot be released.",
        );
      }

      const updated = await transaction.query(
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
            AND reservation.gmail_connection_id = $5
          RETURNING ${selectReservation}`,
        [
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
          input.reservationId,
          input.gmailConnectionId,
          input.releasedAt,
          input.reason,
          input.actorId,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) {
        throw new Error("Gmail quota reservation could not be released.");
      }
      return reservationFromRow(row);
    });
  }
}
