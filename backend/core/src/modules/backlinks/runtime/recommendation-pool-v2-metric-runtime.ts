import { z } from "zod";
import { createCommercialQualificationOfficialRuntime } from "../adapters/dataforseo/commercial-qualification-official-runtime.js";
import { resolveDataForSeoProjectLocale } from "../adapters/dataforseo/project-locale.js";
import { LocalProductSecretStoreClient, parseLocalProductSecretReference } from "../adapters/security/local-product-secret-store-client.js";
import { collectCommercialQualificationBulkMetrics, commercialQualificationBulkEndpoints } from "../application/services/commercial-qualification-bulk.service.js";
import { createGovernedCommercialQualificationRuntime } from "../application/services/commercial-qualification-request.service.js";
import type { RecommendationPoolV2WorkflowActivities } from "../application/services/recommendation-pool-v2-workflow.service.js";
import { createCommercialQualificationRequestRepository } from "../db/repositories/commercial-qualification-request.repository.js";
import { createRecommendationPoolV2CandidateRepository } from "../db/repositories/recommendation-pool-v2-candidate.repository.js";
import { withBacklinkTenantTransaction, type BacklinkTenantPool } from "../db/tenant-transaction.js";
import { parseProviderOperationBudgetAuthorization } from "../domain/recommendations/provider-operation-budget.js";
import { secretKinds } from "../ports/secret-store.port.js";
import { createLocalProductDataForSeoGate, resolveLocalProductDataForSeoOperationBudget, type LocalProductDataForSeoConfiguration } from "./local-product-dataforseo-runtime.js";

type Input = Parameters<RecommendationPoolV2WorkflowActivities["finalizeGeneration"]>[0];

// This runs before release snapshots are frozen, never inside a network-spanning transaction.
export function createRecommendationPoolV2MetricRuntime(options: Readonly<{
  pool: BacklinkTenantPool;
  configuration: LocalProductDataForSeoConfiguration;
  secretStoreRoot: string;
}>) {
  return async (input: Input): Promise<void> => {
    const transact = <T>(work: Parameters<typeof withBacklinkTenantTransaction<T>>[2]) =>
      withBacklinkTenantTransaction(options.pool, input, work);
    const loaded = await transact(async client => {
      const generation = await client.query(
        `SELECT generation.market,generation.location,generation.language,
                context.country_code "countryCode",context.locale,
                job.result_summary->'providerBudgetAuthorization' authorization
           FROM backlinks.backlink_recommendation_generation_contracts generation
           JOIN backlinks.backlink_project_context_snapshots context
             ON (context.organization_id,context.workspace_id,context.website_project_id,context.id)=
                (generation.organization_id,generation.workspace_id,generation.website_project_id,generation.recommendation_context_version_id)
           JOIN backlinks.backlink_jobs job
             ON (job.organization_id,job.workspace_id,job.website_project_id,job.id)=
                (generation.organization_id,generation.workspace_id,generation.website_project_id,$8::uuid)
            AND job.source_object_type='project-context-snapshot'
            AND job.source_object_id=generation.recommendation_context_version_id
          WHERE generation.organization_id=$1 AND generation.workspace_id=$2
            AND generation.website_project_id=$3 AND generation.id=$4
            AND generation.recommendation_context_version_id=$5
            AND generation.visible_pool_generation=$6 AND generation.input_pin_id=$7
            AND generation.pool_contract_version='recommendation-pool.v2'
            AND generation.discovery_completed_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM backlinks.backlink_project_context_snapshots newer
               WHERE newer.organization_id=context.organization_id
                 AND newer.workspace_id=context.workspace_id
                 AND newer.website_project_id=context.website_project_id
                 AND newer.snapshot_version>context.snapshot_version)`,
        [input.organizationId,input.workspaceId,input.websiteProjectId,input.generationContractId,
          input.recommendationContextVersionId,input.visiblePoolGeneration,input.inputPinId,input.jobId],
      );
      if (!generation.rows[0]) return null;
      const candidates = await client.query(
        `SELECT candidate.id,candidate.canonical_domain domain
           FROM backlinks.backlink_recommendation_generation_candidates candidate
          WHERE candidate.organization_id=$1 AND candidate.workspace_id=$2
            AND candidate.website_project_id=$3 AND candidate.generation_contract_id=$4
            AND candidate.admission_state='ADMITTED'
          ORDER BY candidate.canonical_domain LIMIT $5`,
        [input.organizationId,input.workspaceId,input.websiteProjectId,input.generationContractId,input.hardCandidateLimit],
      );
      return { generation: generation.rows[0], candidates: candidates.rows };
    });
    if (loaded === null || loaded.candidates.length === 0) return;
    const configuration = options.configuration;
    const allowed = new Set(configuration.endpointAllowlist.map(value => new URL(value, "https://api.dataforseo.com").pathname));
    if (Object.values(commercialQualificationBulkEndpoints).some(endpoint => !allowed.has(endpoint))) {
      // Missing configuration must not be misrepresented as provider "no data".
      throw new Error("RECOMMENDATION_METRIC_ENDPOINTS_NOT_ALLOWLISTED");
    }
    const locale = resolveDataForSeoProjectLocale({
      countryCode: String(loaded.generation.countryCode), locale: String(loaded.generation.locale),
    });
    const secretStore = new LocalProductSecretStoreClient({ rootDirectory: options.secretStoreRoot });
    const credentials = z.object({ login: z.string().min(1), password: z.string().min(1) }).parse(JSON.parse(
      await secretStore.resolve({
        reference: parseLocalProductSecretReference(configuration.credentialSecretRef, secretKinds.dataForSeoCredential),
        context: { organizationId: "local-product", subjectProvider: "dataforseo" },
      }),
    ));
    const scope = { organizationId: input.organizationId, workspaceId: input.workspaceId, websiteProjectId: input.websiteProjectId };
    const operationPrefix = `commercial-refill-operation:${input.jobId}`;
    const operationBudget = resolveLocalProductDataForSeoOperationBudget({
      configuration, authorization: loaded.generation.authorization == null
        ? null : parseProviderOperationBudgetAuthorization(loaded.generation.authorization),
    });
    const gate = createLocalProductDataForSeoGate({
      pool: options.pool, scope, configuration, operationBudget, now: () => new Date(),
    })({
      query: (sql, values) => transact(client => client.query(sql, values)),
      release() {},
    }, operationPrefix);
    const runtime = createGovernedCommercialQualificationRuntime({
      context: scope, operationId: input.jobId, budgetReservationPrefix: operationPrefix,
      recommendationLineage: { generationContractId: input.generationContractId, jobId: input.jobId },
      estimatedCostMicros: configuration.estimatedCostMicros,
      gate, store: createCommercialQualificationRequestRepository(options.pool),
      provider: createCommercialQualificationOfficialRuntime({
        credentials, endpointAllowlist: configuration.endpointAllowlist, timeoutMs: configuration.timeoutMs,
      }),
    });
    const result = await collectCommercialQualificationBulkMetrics({
      domains: loaded.candidates.map(row => String(row.domain)),
      metricScope: "TARGET_MARKET", locationCode: Number(locale.locationCode), languageCode: locale.languageCode,
      endpointAllowlist: configuration.endpointAllowlist, concurrency: 1, runtime,
    });
    if (result.state === "unknown_charge") throw new Error("RECOMMENDATION_METRICS_UNKNOWN_CHARGE");
    if (result.state === "unavailable") throw new Error("RECOMMENDATION_METRICS_UNAVAILABLE");
    await transact(async client => {
      const repository = createRecommendationPoolV2CandidateRepository(client);
      const ids = new Map(loaded.candidates.map(row => [String(row.domain),String(row.id)]));
      for (const record of result.records) {
        for (const [kind, metricType, value] of [
          ["traffic", "TRAFFIC_ORGANIC_ETV", record.trafficOrganicEtv],
          ["rank", "AUTHORITY_RANK", record.authorityRank],
          ["spam", "SPAM_SCORE", record.spamScore],
        ] as const) {
          const receipt = await client.query(
            `SELECT id,finished_at "finishedAt" FROM backlinks.provider_batch_requests
              WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
                AND provider='dataforseo' AND normalized_request_hash=$4
                AND endpoint=$5 AND status IN ('succeeded','partial')
              ORDER BY started_at DESC,id DESC LIMIT 1`,
            [input.organizationId,input.workspaceId,input.websiteProjectId,
              record.requestFingerprints[kind],commercialQualificationBulkEndpoints[kind]],
          );
          const evidence = receipt.rows[0];
          if (!evidence) continue;
          await repository.appendMetric({
            ...scope, generationCandidateId: ids.get(record.canonicalDomain)!,
            metricType, provider: "dataforseo", endpoint: commercialQualificationBulkEndpoints[kind],
            market: String(loaded.generation.market), location: String(loaded.generation.location),
            language: String(loaded.generation.language), requestIntent: "DEEP_ASSESSMENT",
            valueState: value === null ? "UNAVAILABLE" : "AVAILABLE", metricValue: value,
            requestRef: String(evidence.id), observedAt: new Date(String(evidence.finishedAt)).toISOString(),
            createdBy: input.actorId,
          });
        }
      }
    });
  };
}
