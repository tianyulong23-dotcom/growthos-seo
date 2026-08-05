import { randomUUID } from "node:crypto";
import type { BacklinkProviderSnapshot, ProviderRequestContext } from "../../ports/dataforseo.port.js";
import { backlinkProviderSnapshotSchema } from "../../ports/dataforseo.port.js";
import type { DataForSeoRequestCoordinator, DataForSeoRequestStart } from "../../application/services/dataforseo-request.service.js";

type QueryClient = Readonly<{
  query(text: string, values?: readonly unknown[]): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;
type ReserveInput = Readonly<{
  context: ProviderRequestContext; provider: "dataforseo"; requestFingerprint: string;
  reservationKey: string; estimatedCostMicros: number;
}>;
const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
const failureStatus = (error: unknown): "failed" | "unknown_charge" =>
  error instanceof Error && error.name === "DataForSeoCallBlockedError" ||
  typeof error === "object" && error !== null && "providerRequestStatus" in error &&
  error.providerRequestStatus === "failed" ? "failed" : "unknown_charge";

export function createProviderAnalysisRepository(
  client: QueryClient, now: () => Date,
): DataForSeoRequestCoordinator & Readonly<{ reserveBudget(input: ReserveInput): Promise<"allow" | "deny"> }> {
  async function begin(start: DataForSeoRequestStart) {
    const scope = [start.key.organizationId, start.key.workspaceId,
      start.key.websiteProjectId, start.key.provider, start.key.endpoint,
      start.key.requestFingerprint];
    const existing = await client.query(`
      WITH fresh AS (
        SELECT s.normalized_payload snapshot,0 priority FROM backlink_provider_cache_entries c
        JOIN backlink_seo_snapshots s ON
          (s.organization_id,s.workspace_id,s.website_project_id,s.id)=
          (c.organization_id,c.workspace_id,c.website_project_id,c.seo_snapshot_id)
        WHERE (c.organization_id,c.workspace_id,c.website_project_id,c.provider,
          c.endpoint,c.request_fingerprint)=($1,$2,$3,$4,$5,$6)
          AND c.schema_version=$7 AND c.expires_at>$8
      ), unresolved AS (
        SELECT NULL::jsonb snapshot,1 priority FROM backlink_provider_requests WHERE
          (organization_id,workspace_id,website_project_id,provider,endpoint,
           request_fingerprint)=($1,$2,$3,$4,$5,$6) AND status='unknown_charge'
      ) SELECT * FROM (SELECT * FROM fresh UNION ALL SELECT * FROM unresolved) x
        ORDER BY priority LIMIT 1
    `, [...scope, start.key.cacheSchemaVersion, start.now]);
    const found = existing.rows[0];
    if (found?.snapshot !== null && found?.snapshot !== undefined)
      return { kind: "cache" as const, snapshot: backlinkProviderSnapshotSchema.parse(found.snapshot) };
    if (found !== undefined) throw new Error("BACKLINK_PROVIDER_CHARGE_RECONCILIATION_REQUIRED");
    try {
      await client.query(`
        INSERT INTO backlink_provider_requests (
          id,organization_id,workspace_id,website_project_id,provider,endpoint,
          request_fingerprint,active_request_bucket,request_schema_version,request_payload,
          status,created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,'running',$10)
      `, [start.context.requestId, ...scope, start.key.requestSchemaVersion,
        JSON.stringify(start.request), start.context.requestId]);
    } catch (error) {
      if (errorCode(error) === "23505")
        throw new Error("BACKLINK_PROVIDER_REQUEST_ALREADY_STARTED");
      throw error;
    }
    return {
      kind: "leader" as const,
      complete: async (snapshot: BacklinkProviderSnapshot) => client.query(`
        WITH s AS (
          INSERT INTO backlink_seo_snapshots (
            id,organization_id,workspace_id,website_project_id,provider_request_id,provider,
            target,target_type,snapshot_type,normalized_payload,payload_hash,observed_at,
            schema_version,created_by
          ) SELECT $2,$3,$4,$5,$1,$6,$7,$8,'backlink_profile',$9,$10,$11,$12,$13
            WHERE EXISTS (SELECT 1 FROM backlink_provider_requests
              WHERE id=$1 AND status='running') RETURNING id
        ), c AS (
          INSERT INTO backlink_provider_cache_entries (
            id,organization_id,workspace_id,website_project_id,provider,endpoint,
            request_fingerprint,schema_version,seo_snapshot_id,fetched_at,expires_at,created_by
          ) SELECT $14,$3,$4,$5,$6,$15,$16,$12,id,$17,$18,$13 FROM s
          ON CONFLICT (organization_id,workspace_id,website_project_id,provider,endpoint,
            request_fingerprint,schema_version) DO UPDATE SET
            seo_snapshot_id=EXCLUDED.seo_snapshot_id,fetched_at=EXCLUDED.fetched_at,
            expires_at=EXCLUDED.expires_at
        ), l AS (
          UPDATE backlink_provider_usage_ledger SET status='settled',
            actual_cost_micros=$19,settled_at=$20
          WHERE provider_request_id=$1 AND status='reserved'
          RETURNING budget_id,estimated_cost_micros
        ), b AS (
          UPDATE backlink_provider_budgets SET
            reserved_micros=reserved_micros-l.estimated_cost_micros,
            spent_micros=spent_micros+$19,version=version+1 FROM l WHERE id=l.budget_id
        ) UPDATE backlink_provider_requests SET status='succeeded',
          active_request_bucket=id::text,finished_at=$20 WHERE id=$1 AND status='running'
      `, [start.context.requestId, randomUUID(), ...scope.slice(0, 4),
        start.request.target, start.request.targetType, JSON.stringify(snapshot),
        snapshot.payloadHash, snapshot.completedAt, start.key.cacheSchemaVersion,
        start.context.requestId, randomUUID(), start.key.endpoint,
        start.key.requestFingerprint, start.now, start.expiresAt, snapshot.costMicros,
        now()]).then(() => undefined),
      fail: async (error: unknown) => {
        const status = failureStatus(error);
        await client.query(`
          WITH l AS (
            UPDATE backlink_provider_usage_ledger SET status='released',released_at=$3
            WHERE provider_request_id=$1 AND status='reserved' AND $2='failed'
            RETURNING budget_id,estimated_cost_micros
          ), b AS (
            UPDATE backlink_provider_budgets SET
              reserved_micros=reserved_micros-l.estimated_cost_micros,
              version=version+1 FROM l WHERE id=l.budget_id
          ) UPDATE backlink_provider_requests SET status=$2,
            active_request_bucket=id::text,finished_at=$3 WHERE id=$1 AND status='running'
        `, [start.context.requestId, status, now()]);
      },
    };
  }

  async function reserveBudget(input: ReserveInput): Promise<"allow" | "deny"> {
    try {
      const result = await client.query(`
        SELECT backlink_reserve_provider_cost(
          $1::uuid,b.id,$2::uuid,$3::uuid,$4::uuid,$1::uuid,$5::text,$6::text,
          $7::bigint,$1::text
        ) FROM backlink_provider_budgets b
        WHERE organization_id=$2 AND workspace_id=$3 AND provider=$5
          AND period_start<=$8 AND period_end>$8 ORDER BY period_start DESC LIMIT 1
      `, [input.context.requestId, input.context.organizationId,
        input.context.workspaceId, input.context.websiteProjectId, input.provider,
        input.reservationKey, input.estimatedCostMicros, now()]);
      return result.rows[0] === undefined ? "deny" : "allow";
    } catch (error) {
      if (errorCode(error) === "P0001" && error instanceof Error &&
          error.message === "BACKLINK_PROVIDER_BUDGET_EXCEEDED") return "deny";
      throw error;
    }
  }
  return { begin, reserveBudget };
}
