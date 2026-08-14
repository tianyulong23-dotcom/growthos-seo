import type {
  ProviderArtifactQueryClient,
} from "./provider-artifact.repository.js";

export const providerCostMetricNames = {
  providerRequestsTotal: "backlinks.provider_requests_total",
  providerSpendMicros: "backlinks.provider_spend_micros",
  providerEstimateErrorRatio: "backlinks.provider_estimate_error_ratio",
  providerCacheHitRate: "backlinks.provider_cache_hit_rate",
  providerStaleHitRate: "backlinks.provider_stale_hit_rate",
  providerHitRate: "backlinks.provider_hit_rate",
  providerSingleFlightSavedCalls:
    "backlinks.provider_single_flight_saved_calls",
  providerBulkFillRatio: "backlinks.provider_bulk_fill_ratio",
  providerPartialFailureRate:
    "backlinks.provider_partial_failure_rate",
  providerNegativeCacheHitRate:
    "backlinks.provider_negative_cache_hit_rate",
  providerCostPerReadyProspectMicros:
    "backlinks.provider_cost_per_ready_prospect_micros",
  providerCostPerOpportunityMicros:
    "backlinks.provider_cost_per_opportunity_micros",
  providerCostPerAcquiredLinkMicros:
    "backlinks.provider_cost_per_acquired_link_micros",
  crossWorkspaceArtifactReuseRate:
    "backlinks.cross_workspace_artifact_reuse_rate",
  unusedEnrichmentRatio: "backlinks.unused_enrichment_ratio",
  unknownChargeCount: "backlinks.provider_unknown_charge_count",
  readyInventoryWaitP95Ms: "backlinks.ready_inventory_wait_p95_ms",
} as const;

export type ProviderCostBusinessOutcomes = Readonly<{
  readyProspectCount: number;
  opportunityCount: number;
  acquiredLinkCount: number;
  totalEnrichmentCount: number;
  unusedEnrichmentCount: number;
  readyInventoryWaitP95Ms: number | null;
}>;

export type ProviderCostBaseline = Readonly<{
  providerRequestsTotal: number;
  providerRequestItemsTotal: number;
  providerSpendMicros: number;
  providerEstimateErrorRatio: number | null;
  providerCacheHitRate: number;
  providerStaleHitRate: number;
  providerHitRate: number;
  providerSingleFlightSavedCalls: number;
  providerBulkFillRatio: number;
  providerPartialFailureRate: number;
  providerNegativeCacheHitRate: number;
  providerCostPerReadyProspectMicros: number | null;
  providerCostPerOpportunityMicros: number | null;
  providerCostPerAcquiredLinkMicros: number | null;
  crossWorkspaceArtifactReuseRate: number;
  unusedEnrichmentRatio: number | null;
  unknownChargeCount: number;
  readyInventoryWaitP95Ms: number | null;
  requestsByEndpointIntentStatus: readonly Readonly<{
    endpoint: string;
    requestIntent: string;
    status: string;
    providerBatchRequests: number;
    providerRequestItems: number;
  }>[];
  averageCostByUsagePurpose: readonly Readonly<{
    usagePurpose: string;
    usageCount: number;
    allocatedCostMicros: number;
    averageCostMicros: number;
  }>[];
}>;

const safeNumber = (value: unknown, label: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) {
    throw new TypeError(`${label} must be a safe integer`);
  }
  return parsed;
};

const ratio = (value: unknown, label: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`);
  }
  return parsed;
};

const nullableRatio = (value: unknown, label: string): number | null =>
  value === null ? null : ratio(value, label);

const validateCount = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
};

const validateBusinessOutcomes = (
  outcomes: ProviderCostBusinessOutcomes | undefined,
): ProviderCostBusinessOutcomes => {
  const normalized = outcomes ?? {
    readyProspectCount: 0,
    opportunityCount: 0,
    acquiredLinkCount: 0,
    totalEnrichmentCount: 0,
    unusedEnrichmentCount: 0,
    readyInventoryWaitP95Ms: null,
  };
  validateCount(normalized.readyProspectCount, "readyProspectCount");
  validateCount(normalized.opportunityCount, "opportunityCount");
  validateCount(normalized.acquiredLinkCount, "acquiredLinkCount");
  validateCount(normalized.totalEnrichmentCount, "totalEnrichmentCount");
  validateCount(normalized.unusedEnrichmentCount, "unusedEnrichmentCount");
  if (normalized.unusedEnrichmentCount > normalized.totalEnrichmentCount) {
    throw new TypeError(
      "unusedEnrichmentCount cannot exceed totalEnrichmentCount",
    );
  }
  if (
    normalized.readyInventoryWaitP95Ms !== null &&
    (
      !Number.isFinite(normalized.readyInventoryWaitP95Ms) ||
      normalized.readyInventoryWaitP95Ms < 0
    )
  ) {
    throw new TypeError(
      "readyInventoryWaitP95Ms must be null or a non-negative number",
    );
  }
  return normalized;
};

const unitCost = (spendMicros: number, count: number): number | null =>
  count === 0 ? null : Math.round(spendMicros / count);

export function createProviderCostBaselineRepository(
  client: ProviderArtifactQueryClient,
) {
  return {
    async read(input: Readonly<{
      organizationId: string;
      workspaceId: string;
      websiteProjectId: string;
      from: Date;
      to: Date;
      maxBatchSize: number;
      businessOutcomes?: ProviderCostBusinessOutcomes;
    }>): Promise<ProviderCostBaseline> {
      if (
        !Number.isSafeInteger(input.maxBatchSize) ||
        input.maxBatchSize < 1 ||
        input.maxBatchSize > 1_000
      ) {
        throw new TypeError(
          "maxBatchSize must be an integer between 1 and 1000",
        );
      }
      if (
        !Number.isFinite(input.from.getTime()) ||
        !Number.isFinite(input.to.getTime()) ||
        input.from >= input.to
      ) {
        throw new TypeError("Provider cost baseline time range is invalid");
      }
      const values = [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.from,
        input.to,
        input.maxBatchSize,
      ] as const;
      const aggregate = await client.query(`
        WITH scoped_batches AS MATERIALIZED (
          SELECT *
          FROM provider_batch_requests
          WHERE organization_id=$1::uuid
            AND workspace_id=$2::uuid
            AND website_project_id=$3::uuid
            AND started_at >= $4
            AND started_at < $5
        ), scoped_usages AS MATERIALIZED (
          SELECT *
          FROM provider_artifact_usages
          WHERE organization_id=$1::uuid
            AND workspace_id=$2::uuid
            AND website_project_id=$3::uuid
            AND used_at >= $4
            AND used_at < $5
        ), scoped_artifacts AS MATERIALIZED (
          SELECT DISTINCT artifact_id FROM scoped_usages
        )
        SELECT
          (SELECT count(*)::int FROM scoped_batches)
            AS "providerRequestsTotal",
          COALESCE((
            SELECT sum(request_count) FROM scoped_batches
          ),0)::bigint AS "providerRequestItemsTotal",
          COALESCE((
            SELECT sum(actual_cost_micros)
            FROM scoped_batches
            WHERE actual_cost_micros IS NOT NULL
          ),0)::bigint AS "providerSpendMicros",
          (
            SELECT
              sum(abs(actual_cost_micros-estimated_cost_micros))::numeric
              / NULLIF(sum(estimated_cost_micros),0)
            FROM scoped_batches
            WHERE actual_cost_micros IS NOT NULL
          ) AS "providerEstimateErrorRatio",
          COALESCE((
            SELECT count(*) FILTER (
              WHERE served_from IN (
                'fresh_cache','stale_cache','negative_cache'
              )
            )::numeric / NULLIF(count(*),0)
            FROM scoped_usages
          ),0) AS "providerCacheHitRate",
          COALESCE((
            SELECT count(*) FILTER (
              WHERE served_from='stale_cache'
            )::numeric / NULLIF(count(*),0)
            FROM scoped_usages
          ),0) AS "providerStaleHitRate",
          COALESCE((
            SELECT count(*) FILTER (
              WHERE served_from IN ('provider_live','provider_bulk')
            )::numeric / NULLIF(count(*),0)
            FROM scoped_usages
          ),0) AS "providerHitRate",
          (SELECT count(*)::int FROM scoped_usages
            WHERE served_from='single_flight')
            AS "providerSingleFlightSavedCalls",
          COALESCE((
            SELECT avg(least(request_count::numeric/$6,1))
            FROM scoped_batches WHERE request_count > 1
          ),0) AS "providerBulkFillRatio",
          COALESCE((
            SELECT count(*) FILTER (
              WHERE status='partial'
            )::numeric / NULLIF(count(*),0)
            FROM scoped_batches WHERE request_count > 1
          ),0) AS "providerPartialFailureRate",
          COALESCE((
            SELECT count(*) FILTER (
              WHERE served_from='negative_cache'
            )::numeric / NULLIF(count(*),0)
            FROM scoped_usages
          ),0) AS "providerNegativeCacheHitRate",
          COALESCE((
            SELECT count(*) FILTER (
              WHERE EXISTS (
                SELECT 1
                FROM provider_artifact_usages other
                WHERE other.organization_id=$1::uuid
                  AND other.artifact_id=scoped_artifacts.artifact_id
                  AND other.workspace_id<>$2::uuid
                  AND other.used_at >= $4
                  AND other.used_at < $5
              )
            )::numeric / NULLIF(count(*),0)
            FROM scoped_artifacts
          ),0) AS "crossWorkspaceArtifactReuseRate",
          (SELECT count(*)::int FROM scoped_batches
            WHERE status='unknown_charge') AS "unknownChargeCount"
      `, values);
      const aggregateRow = aggregate.rows[0];
      if (aggregateRow === undefined) {
        throw new Error("Provider cost baseline aggregate is missing");
      }
      const requestBreakdown = await client.query(`
        SELECT endpoint,request_intent AS "requestIntent",status,
          count(*)::int AS "providerBatchRequests",
          sum(request_count)::bigint AS "providerRequestItems"
        FROM provider_batch_requests
        WHERE organization_id=$1::uuid
          AND workspace_id=$2::uuid
          AND website_project_id=$3::uuid
          AND started_at >= $4
          AND started_at < $5
        GROUP BY endpoint,request_intent,status
        ORDER BY endpoint,request_intent,status
      `, values.slice(0, 5));
      const purposeBreakdown = await client.query(`
        SELECT usage_purpose AS "usagePurpose",
          count(*)::int AS "usageCount",
          sum(allocated_cost_micros)::bigint AS "allocatedCostMicros",
          round(avg(allocated_cost_micros))::bigint AS "averageCostMicros"
        FROM provider_artifact_usages
        WHERE organization_id=$1::uuid
          AND workspace_id=$2::uuid
          AND website_project_id=$3::uuid
          AND used_at >= $4
          AND used_at < $5
        GROUP BY usage_purpose
        ORDER BY usage_purpose
      `, values.slice(0, 5));

      const providerSpendMicros = safeNumber(
        aggregateRow.providerSpendMicros,
        "providerSpendMicros",
      );
      const outcomes = validateBusinessOutcomes(input.businessOutcomes);
      return {
        providerRequestsTotal: safeNumber(
          aggregateRow.providerRequestsTotal,
          "providerRequestsTotal",
        ),
        providerRequestItemsTotal: safeNumber(
          aggregateRow.providerRequestItemsTotal,
          "providerRequestItemsTotal",
        ),
        providerSpendMicros,
        providerEstimateErrorRatio: nullableRatio(
          aggregateRow.providerEstimateErrorRatio,
          "providerEstimateErrorRatio",
        ),
        providerCacheHitRate: ratio(
          aggregateRow.providerCacheHitRate,
          "providerCacheHitRate",
        ),
        providerStaleHitRate: ratio(
          aggregateRow.providerStaleHitRate,
          "providerStaleHitRate",
        ),
        providerHitRate: ratio(
          aggregateRow.providerHitRate,
          "providerHitRate",
        ),
        providerSingleFlightSavedCalls: safeNumber(
          aggregateRow.providerSingleFlightSavedCalls,
          "providerSingleFlightSavedCalls",
        ),
        providerBulkFillRatio: ratio(
          aggregateRow.providerBulkFillRatio,
          "providerBulkFillRatio",
        ),
        providerPartialFailureRate: ratio(
          aggregateRow.providerPartialFailureRate,
          "providerPartialFailureRate",
        ),
        providerNegativeCacheHitRate: ratio(
          aggregateRow.providerNegativeCacheHitRate,
          "providerNegativeCacheHitRate",
        ),
        providerCostPerReadyProspectMicros: unitCost(
          providerSpendMicros,
          outcomes.readyProspectCount,
        ),
        providerCostPerOpportunityMicros: unitCost(
          providerSpendMicros,
          outcomes.opportunityCount,
        ),
        providerCostPerAcquiredLinkMicros: unitCost(
          providerSpendMicros,
          outcomes.acquiredLinkCount,
        ),
        crossWorkspaceArtifactReuseRate: ratio(
          aggregateRow.crossWorkspaceArtifactReuseRate,
          "crossWorkspaceArtifactReuseRate",
        ),
        unusedEnrichmentRatio: outcomes.totalEnrichmentCount === 0
          ? null
          : outcomes.unusedEnrichmentCount / outcomes.totalEnrichmentCount,
        unknownChargeCount: safeNumber(
          aggregateRow.unknownChargeCount,
          "unknownChargeCount",
        ),
        readyInventoryWaitP95Ms: outcomes.readyInventoryWaitP95Ms,
        requestsByEndpointIntentStatus: requestBreakdown.rows.map((row) => ({
          endpoint: String(row.endpoint),
          requestIntent: String(row.requestIntent),
          status: String(row.status),
          providerBatchRequests: safeNumber(
            row.providerBatchRequests,
            "providerBatchRequests",
          ),
          providerRequestItems: safeNumber(
            row.providerRequestItems,
            "providerRequestItems",
          ),
        })),
        averageCostByUsagePurpose: purposeBreakdown.rows.map((row) => ({
          usagePurpose: String(row.usagePurpose),
          usageCount: safeNumber(row.usageCount, "usageCount"),
          allocatedCostMicros: safeNumber(
            row.allocatedCostMicros,
            "allocatedCostMicros",
          ),
          averageCostMicros: safeNumber(
            row.averageCostMicros,
            "averageCostMicros",
          ),
        })),
      };
    },
  };
}
