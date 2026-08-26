import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantContext,
  type BacklinkTenantPool,
} from "../tenant-transaction.js";
export type OutboxQueryClient = Readonly<{
  query(text: string, values?: readonly unknown[]): Promise<
    Readonly<{ rows: readonly Record<string, unknown>[] }>
  >;
}>;
type OutboxScope = Readonly<{ organizationId: string; workspaceId: string;
  websiteProjectId: string; actorId: string }>;
export type AppendOutboxInput = OutboxScope & Readonly<{
  eventId: string;
  eventType: string;
  aggregateId: string;
  aggregateVersion: number;
  idempotencyKey: string;
  payload: unknown;
  payloadSchemaVersion: number;
}>;
export type AppendOutboxResult = Readonly<{
  state: "appended" | "existing"; eventId: string;
}>;
export type ClaimedOutboxEvent = Readonly<{
  eventId: string;
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  eventType: string;
  aggregateId: string;
  aggregateVersion: number;
  idempotencyKey: string;
  payload: unknown;
  payloadSchemaVersion: number;
  status: "processing";
  availableAt: Date;
  attemptCount: number;
}>;
export type MarkOutboxInput =
  | Readonly<{ eventId: string; workerId: string; outcome: "published" }>
  | Readonly<{ eventId: string; workerId: string; outcome: "failed";
      retryAt: Date }>;
const conflict = () => new BacklinkError({ code: backlinkErrorCodes.conflict,
  message: "Outbox deduplication key is bound to a different event." });

export function createOutboxRepository(client: OutboxQueryClient) {
  return {
    async append(input: AppendOutboxInput): Promise<AppendOutboxResult> {
      const payload = JSON.stringify(input.payload);
      const inserted = await client.query(
        `INSERT INTO backlink_outbox_events (
           id, organization_id, workspace_id, website_project_id,
           event_type, aggregate_id, aggregate_version, idempotency_key,
           payload, payload_schema_version, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $11)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          input.eventId, input.organizationId, input.workspaceId,
          input.websiteProjectId, input.eventType, input.aggregateId,
          input.aggregateVersion, input.idempotencyKey, payload,
          input.payloadSchemaVersion, input.actorId,
        ],
      );
      if (inserted.rows[0] !== undefined) {
        return { state: "appended", eventId: input.eventId };
      }

      const existing = await client.query(
        `SELECT id
           FROM backlink_outbox_events
          WHERE organization_id = $1 AND workspace_id = $2
            AND website_project_id = $3 AND event_type = $4
            AND aggregate_id = $5 AND aggregate_version = $6
            AND idempotency_key = $7 AND payload = $8::jsonb
            AND payload_schema_version = $9`,
        [
          input.organizationId, input.workspaceId, input.websiteProjectId,
          input.eventType, input.aggregateId, input.aggregateVersion,
          input.idempotencyKey, payload, input.payloadSchemaVersion,
        ],
      );
      const eventId = existing.rows[0]?.id;
      if (typeof eventId !== "string") throw conflict();
      return { state: "existing", eventId };
    },

    async claim(input: Readonly<{
      workerId: string;
      limit: number;
      eventType?: string;
      eventId?: string;
      staleClaimBefore?: Date;
    }>): Promise<
      readonly ClaimedOutboxEvent[]
    > {
      if (!Number.isInteger(input.limit) || input.limit < 1) return [];
      const result = await client.query(
        `WITH claimable AS (
           SELECT id FROM backlink_outbox_events
            WHERE (
                    (status IN ('pending', 'failed') AND available_at <= now())
                 OR ($4::timestamptz IS NOT NULL
                     AND status = 'processing' AND claimed_at <= $4)
                  )
              AND ($3::text IS NULL OR event_type = $3)
              AND ($5::uuid IS NULL OR id = $5::uuid)
            ORDER BY available_at, created_at, id
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE backlink_outbox_events AS event
            SET status = 'processing', claimed_at = now(), claimed_by = $2,
                attempt_count = attempt_count + 1, updated_at = now(),
                updated_by = $2
           FROM claimable
          WHERE event.id = claimable.id
        RETURNING event.id AS "eventId",
                  event.organization_id AS "organizationId",
                  event.workspace_id AS "workspaceId",
                  event.website_project_id AS "websiteProjectId",
                  event.event_type AS "eventType",
                  event.aggregate_id AS "aggregateId",
                  event.aggregate_version AS "aggregateVersion",
                  event.idempotency_key AS "idempotencyKey", event.payload,
                  event.payload_schema_version AS "payloadSchemaVersion",
                  event.status, event.available_at AS "availableAt",
                  event.attempt_count AS "attemptCount"`,
        [
          input.limit,
          input.workerId,
          input.eventType ?? null,
          input.staleClaimBefore ?? null,
          input.eventId ?? null,
        ],
      );
      return result.rows as readonly ClaimedOutboxEvent[];
    },

    async mark(input: MarkOutboxInput): Promise<boolean> {
      const status = input.outcome === "published" ? "published" : "failed";
      const retryAt = input.outcome === "failed" ? input.retryAt : null;
      const result = await client.query(
        `UPDATE backlink_outbox_events
            SET status = $3,
                available_at = CASE WHEN $3 = 'failed' THEN $4 ELSE available_at END,
                claimed_at = CASE WHEN $3 = 'failed' THEN NULL ELSE claimed_at END,
                claimed_by = CASE WHEN $3 = 'failed' THEN NULL ELSE claimed_by END,
                published_at = CASE WHEN $3 = 'published' THEN now() ELSE NULL END,
                updated_at = now(), updated_by = $2
          WHERE id = $1 AND status = 'processing' AND claimed_by = $2
        RETURNING id`,
        [input.eventId, input.workerId, status, retryAt],
      );
      return result.rows[0] !== undefined;
    },
  };
}

export function createOutboxRelayRepository(client: OutboxQueryClient) {
  return {
    async claim(input: Readonly<{
      workerId: string;
      limit: number;
      eventType?: string;
      eventId?: string;
      staleClaimBefore?: Date;
    }>): Promise<readonly ClaimedOutboxEvent[]> {
      if (!Number.isInteger(input.limit) || input.limit < 1) return [];
      if (input.eventId !== undefined) {
        throw new Error("BACKLINK_OUTBOX_EXACT_CLAIM_UNSUPPORTED");
      }
      const result = await client.query(
        `SELECT event_id AS "eventId",
                organization_id AS "organizationId",
                workspace_id AS "workspaceId",
                website_project_id AS "websiteProjectId",
                event_type AS "eventType",
                aggregate_id AS "aggregateId",
                aggregate_version AS "aggregateVersion",
                idempotency_key AS "idempotencyKey",
                payload,
                payload_schema_version AS "payloadSchemaVersion",
                status,
                available_at AS "availableAt",
                attempt_count AS "attemptCount"
           FROM backlink_claim_outbox_events($1, $2, $3, $4)`,
        [
          input.workerId,
          input.limit,
          input.eventType ?? null,
          input.staleClaimBefore ?? null,
        ],
      );
      return result.rows as readonly ClaimedOutboxEvent[];
    },

    async mark(input: MarkOutboxInput): Promise<boolean> {
      const outcome = input.outcome;
      const retryAt = outcome === "failed" ? input.retryAt : null;
      const result = await client.query(
        `SELECT backlink_mark_outbox_event($1, $2, $3, $4) AS marked`,
        [input.eventId, input.workerId, outcome, retryAt],
      );
      return result.rows[0]?.marked === true;
    },
  };
}

export function createScopedOutboxRelayRepository(
  pool: BacklinkTenantPool,
  scope: BacklinkTenantContext,
) {
  return {
    claim(input: Parameters<
      ReturnType<typeof createOutboxRepository>["claim"]
    >[0]) {
      return withBacklinkTenantTransaction(
        pool,
        scope,
        (client) => createOutboxRepository(client).claim(input),
      );
    },
    mark(input: MarkOutboxInput) {
      return withBacklinkTenantTransaction(
        pool,
        scope,
        (client) => createOutboxRepository(client).mark(input),
      );
    },
  };
}
