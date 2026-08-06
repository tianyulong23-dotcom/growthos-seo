import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  calculateCommercialGoldMetrics,
  commercialGoldLabels,
  type CommercialGoldMetrics,
  type CommercialGoldPrediction,
} from "../../domain/recommendations/commercial-gold-set.js";
import {
  createRecommendationDomainKey,
} from "../../domain/recommendations/domain-key.js";

export type CommercialGoldSetQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

const nonBlank = z.string().trim().min(1);
const importSchema = z.object({
  name: nonBlank,
  datasetVersion: nonBlank,
  lock: z.boolean().default(false),
  labels: z.array(z.object({
    canonicalDomain: nonBlank,
    marketCode: z.string().trim().min(2).max(12),
    label: z.enum(commercialGoldLabels),
    notes: z.string().trim().max(2_000).nullable().optional(),
  }).strict()).min(1),
}).strict();

type Scope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

function predictionFromRow(
  row: Record<string, unknown>,
): CommercialGoldPrediction {
  const score = typeof row.commercialScore === "object"
    && row.commercialScore !== null
    && !Array.isArray(row.commercialScore)
    ? row.commercialScore as Record<string, unknown>
    : {};
  const decision = score.decision;
  if (
    decision !== "ready"
    && decision !== "excluded"
    && decision !== "insufficient_data"
    && decision !== "manual_review"
  ) {
    throw new TypeError("Stored commercial score decision is invalid");
  }
  return Object.freeze({
    canonicalDomain: String(row.canonicalDomain),
    score: typeof score.total === "number" ? score.total : null,
    decision,
    hitGates: Array.isArray(score.hitGates)
      ? score.hitGates.filter((item): item is string =>
        typeof item === "string"
      )
      : [],
  });
}

export async function importCommercialGoldSet(input: Readonly<{
  client: CommercialGoldSetQueryClient;
  scope: Scope;
  actorId: string;
  importedAt: Date;
  payload: unknown;
}>): Promise<Readonly<{
  goldSetId: string;
  datasetVersion: string;
  status: "labeled" | "locked";
  labelCount: number;
}>> {
  const payload = importSchema.parse(input.payload);
  const duplicateDomains = new Set<string>();
  const labels = payload.labels.map((label) => {
    const canonicalDomain =
      createRecommendationDomainKey(label.canonicalDomain).hostnameAscii;
    if (duplicateDomains.has(canonicalDomain)) {
      throw new TypeError(`Duplicate Gold Set domain: ${canonicalDomain}`);
    }
    duplicateDomains.add(canonicalDomain);
    return {
      ...label,
      canonicalDomain,
      marketCode: label.marketCode.toUpperCase(),
      notes: label.notes ?? null,
    };
  });
  const existing = await input.client.query(
    `SELECT id,status
       FROM backlink_commercial_gold_sets
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND dataset_version=$4
      LIMIT 1`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      payload.datasetVersion,
    ],
  );
  if (existing.rows[0]?.status === "locked") {
    throw new Error("COMMERCIAL_GOLD_SET_LOCKED");
  }
  const goldSetId = String(existing.rows[0]?.id ?? randomUUID());
  await input.client.query(
    `INSERT INTO backlink_commercial_gold_sets (
       id,organization_id,workspace_id,website_project_id,
       name,dataset_version,status,created_at,created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8)
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,dataset_version
     ) DO UPDATE SET name=EXCLUDED.name`,
    [
      goldSetId,
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      payload.name,
      payload.datasetVersion,
      input.importedAt,
      input.actorId,
    ],
  );
  for (const label of labels) {
    await input.client.query(
      `INSERT INTO backlink_commercial_gold_labels (
         id,organization_id,workspace_id,website_project_id,gold_set_id,
         canonical_domain,market_code,label,notes,labeled_at,labeled_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         gold_set_id,canonical_domain
       ) DO UPDATE SET
         market_code=EXCLUDED.market_code,label=EXCLUDED.label,
         notes=EXCLUDED.notes,labeled_at=EXCLUDED.labeled_at,
         labeled_by=EXCLUDED.labeled_by`,
      [
        randomUUID(),
        input.scope.organizationId,
        input.scope.workspaceId,
        input.scope.websiteProjectId,
        goldSetId,
        label.canonicalDomain,
        label.marketCode,
        label.label,
        label.notes,
        input.importedAt,
        input.actorId,
      ],
    );
  }
  const status = payload.lock ? "locked" as const : "labeled" as const;
  await input.client.query(
    `UPDATE backlink_commercial_gold_sets
        SET status=$5
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND id=$4`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      goldSetId,
      status,
    ],
  );
  return Object.freeze({
    goldSetId,
    datasetVersion: payload.datasetVersion,
    status,
    labelCount: labels.length,
  });
}

export async function reportCommercialGoldSetMetrics(input: Readonly<{
  client: CommercialGoldSetQueryClient;
  scope: Scope;
  datasetVersion: string;
  discoveryBatchId: string;
  previousDiscoveryBatchId?: string;
}>): Promise<CommercialGoldMetrics> {
  const labels = await input.client.query(
    `SELECT label.canonical_domain "canonicalDomain",
            label.market_code "marketCode",label.label
       FROM backlink_commercial_gold_sets AS gold_set
       JOIN backlink_commercial_gold_labels AS label
         ON (label.organization_id,label.workspace_id,
             label.website_project_id,label.gold_set_id)=
            (gold_set.organization_id,gold_set.workspace_id,
             gold_set.website_project_id,gold_set.id)
      WHERE gold_set.organization_id=$1 AND gold_set.workspace_id=$2
        AND gold_set.website_project_id=$3
        AND gold_set.dataset_version=$4`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.datasetVersion,
    ],
  );
  if (labels.rows.length === 0) {
    throw new Error("COMMERCIAL_GOLD_SET_NOT_FOUND_OR_EMPTY");
  }
  const predictions = await input.client.query(
    `SELECT canonical_domain "canonicalDomain",
            commercial_score "commercialScore"
       FROM backlink_commercial_candidates
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND discovery_batch_id=$4`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.discoveryBatchId,
    ],
  );
  const previousPredictions = input.previousDiscoveryBatchId === undefined
    ? undefined
    : (await input.client.query(
        `SELECT canonical_domain "canonicalDomain",
                commercial_score "commercialScore"
           FROM backlink_commercial_candidates
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND discovery_batch_id=$4`,
        [
          input.scope.organizationId,
          input.scope.workspaceId,
          input.scope.websiteProjectId,
          input.previousDiscoveryBatchId,
        ],
      )).rows.map(predictionFromRow);
  const batch = await input.client.query(
    `SELECT paid_cost_micros "paidCostMicros"
       FROM backlink_commercial_discovery_batches
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND id=$4`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.discoveryBatchId,
    ],
  );
  return calculateCommercialGoldMetrics({
    labels: labels.rows.map((row) => ({
      canonicalDomain: String(row.canonicalDomain),
      marketCode: String(row.marketCode),
      label: z.enum(commercialGoldLabels).parse(row.label),
    })),
    predictions: predictions.rows.map(predictionFromRow),
    ...(previousPredictions === undefined ? {} : { previousPredictions }),
    totalCostMicros: Number(batch.rows[0]?.paidCostMicros ?? 0),
  });
}
