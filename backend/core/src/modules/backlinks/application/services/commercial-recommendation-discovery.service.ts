import { createHash, randomUUID } from "node:crypto";

import type {
  DataForSeoCallGate,
} from "../policies/dataforseo-call.policy.js";
import type {
  CommercialDataForSeoRuntime,
} from "../../adapters/dataforseo/commercial-official-runtime.js";
import {
  buildCommercialDiscoveryBlueprint,
  type CommercialDiscoveryBlueprint,
} from "../../domain/recommendations/commercial-discovery-blueprint.js";
import {
  createCommercialDiscoveryPlan,
  fingerprintCommercialDiscoveryCall,
  mergeCommercialDiscoveryArtifacts,
  type CommercialDiscoveryArtifact,
  type CommercialDiscoverySourceType,
} from "../../domain/recommendations/commercial-discovery-source.js";
import {
  evaluateCommercialCandidate,
} from "../../domain/recommendations/commercial-candidate-evaluation.js";
import {
  rankCommercialRecommendations,
  type CommercialScoreDecision,
} from "../../domain/recommendations/commercial-score.js";
import {
  assessCommercialCandidateSite,
  type CommercialStaticAssessment,
} from "../../domain/recommendations/commercial-static-assessment.js";
import type {
  SafeFetchPort,
} from "../../ports/safe-fetch.port.js";
import type {
  ProviderRequestContext,
} from "../../ports/dataforseo.port.js";
import {
  CommercialDiscoveryRequestService,
  type CommercialDiscoveryQueryClient,
} from "./commercial-discovery-request.service.js";

const blockedDiscoveryDomains = Object.freeze([
  "ahrefs.com",
  "bing.com",
  "dataforseo.com",
  "duckduckgo.com",
  "facebook.com",
  "google.com",
  "instagram.com",
  "linkedin.com",
  "moz.com",
  "pinterest.com",
  "reddit.com",
  "semrush.com",
  "similarweb.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "yahoo.com",
  "youtube.com",
]);
const staticAssessmentConcurrency = 4;

export type CommercialRecommendationContext = Readonly<{
  snapshotVersion: number;
  canonicalDomain: string;
  locale: string;
  countryCode: string;
  products: readonly string[];
  keywords: readonly string[];
  targetUrls: readonly string[];
}>;

export type CommercialRecommendationDiscoveryConfiguration = Readonly<{
  endpointAllowlist: readonly string[];
  estimatedCostMicros: number;
  absoluteBudgetMicros: number;
  candidateLimit: number;
  locationCode: string;
  languageCode: string;
  discoveryTargets: readonly string[];
}>;

export type CommercialReadyCandidate = Readonly<{
  hostnameAscii: string;
  sourceTypes: readonly CommercialDiscoverySourceType[];
  provider: Readonly<{
    rank: number | null;
    backlinkCount: number | null;
    referringDomainCount: number | null;
    spamScore: number | null;
    evidenceRefs: readonly string[];
    collectedAt: string;
  }>;
  staticAssessment: CommercialStaticAssessment;
  commercialScore: CommercialScoreDecision;
}>;

export type CommercialRecommendationDiscoveryResult = Readonly<{
  candidates: readonly CommercialReadyCandidate[];
  provider: Readonly<{
    source: "cache" | "stale-cache" | "single-flight" | "provider";
    acquiredAt: string;
    costMicros: number;
    requestFingerprint: string;
  }>;
}>;

type Scope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

type CandidateHistory = Readonly<{
  excludedDomains: ReadonlySet<string>;
  previouslyExcludedDomains: ReadonlySet<string>;
}>;

function aggregateHash(values: readonly string[]): string {
  return createHash("sha256")
    .update([...values].sort().join("\n"), "utf8")
    .digest("hex");
}

function hostnameFromUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<readonly R[]> {
  const output: R[] = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) output[index] = await mapper(value);
      }
    },
  ));
  return Object.freeze(output);
}

async function collectBlueprintEvidence(input: Readonly<{
  scope: Scope;
  contextVersionId: string;
  context: CommercialRecommendationContext;
  safeFetch: Pick<SafeFetchPort, "fetch">;
}>): Promise<readonly string[]> {
  const evidence = new Set<string>([
    `postgresql:project-context:${input.contextVersionId}:snapshot:${input.context.snapshotVersion}`,
  ]);
  for (const targetUrl of input.context.targetUrls.slice(0, 5)) {
    try {
      const fetched = await input.safeFetch.fetch({
        url: targetUrl,
        purpose: "seo-assessment",
        workspaceId: input.scope.workspaceId,
        websiteProjectId: input.scope.websiteProjectId,
        maxBytes: 512_000,
        maxRedirects: 4,
      });
      if (fetched.status >= 200 && fetched.status < 400) {
        evidence.add(`safefetch:${fetched.finalUrl}:${fetched.fetchedAt}`);
      }
    } catch {
      // Project context remains authoritative when target evidence is unavailable.
    }
  }
  return Object.freeze([...evidence].sort());
}

async function loadHistory(
  client: CommercialDiscoveryQueryClient,
  scope: Scope,
  context: CommercialRecommendationContext,
): Promise<CandidateHistory> {
  const prospects = await client.query(
    `SELECT p.hostname_ascii AS hostname,
            bool_or(
              r.status='excluded' OR inventory.status='rejected'
            ) AS "previouslyExcluded"
       FROM backlink_prospects AS p
       LEFT JOIN backlink_recommendations AS r
         ON (r.organization_id,r.workspace_id,r.website_project_id,
             r.prospect_id,r.recommendation_context_version_id)=
            (p.organization_id,p.workspace_id,p.website_project_id,
             p.id,p.recommendation_context_version_id)
       LEFT JOIN backlink_recommendation_inventory AS inventory
         ON (inventory.organization_id,inventory.workspace_id,
             inventory.website_project_id,inventory.recommendation_id)=
            (r.organization_id,r.workspace_id,
             r.website_project_id,r.id)
      WHERE p.organization_id=$1 AND p.workspace_id=$2
        AND p.website_project_id=$3
      GROUP BY p.hostname_ascii`,
    [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
  );
  const placements = await client.query(
    `SELECT normalized_source_url AS "sourceUrl"
       FROM backlink_placements
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3`,
    [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
  );
  const opportunities = await client.query(
    `SELECT target_host_ascii AS hostname
       FROM backlink_opportunities
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3`,
    [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
  );
  const excluded = new Set<string>(blockedDiscoveryDomains);
  const previouslyExcluded = new Set<string>();
  for (const row of prospects.rows) {
    const hostname = String(row.hostname ?? "").trim().toLowerCase();
    if (hostname.length === 0) continue;
    excluded.add(hostname);
    if (row.previouslyExcluded === true) previouslyExcluded.add(hostname);
  }
  for (const row of placements.rows) {
    const hostname = hostnameFromUrl(row.sourceUrl);
    if (hostname !== null) excluded.add(hostname);
  }
  for (const row of opportunities.rows) {
    const hostname = String(row.hostname ?? "").trim().toLowerCase();
    if (hostname.length > 0) excluded.add(hostname);
  }
  for (const targetUrl of context.targetUrls) {
    const hostname = hostnameFromUrl(targetUrl);
    if (hostname !== null) excluded.add(hostname);
  }
  return Object.freeze({
    excludedDomains: excluded,
    previouslyExcludedDomains: previouslyExcluded,
  });
}

async function persistBlueprint(input: Readonly<{
  client: CommercialDiscoveryQueryClient;
  scope: Scope;
  contextVersionId: string;
  blueprint: CommercialDiscoveryBlueprint;
  actorId: string;
  generatedAt: Date;
}>): Promise<string> {
  await input.client.query(
    `UPDATE backlink_commercial_discovery_blueprints
        SET status='stale_context'
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND project_context_version_id<>$4
        AND status='active'`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.contextVersionId,
    ],
  );
  await input.client.query(
    `UPDATE backlink_commercial_discovery_batches
        SET status='stale_context',pause_reason='stale_context',
            finished_at=COALESCE(finished_at,$5)
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND project_context_version_id<>$4
        AND status IN ('running','completed','paused','unavailable')`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.contextVersionId,
      input.generatedAt,
    ],
  );
  await input.client.query(
    `UPDATE backlink_commercial_candidates
        SET state='stale_context',updated_at=$5,updated_by=$6,
            version=version+1
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND project_context_version_id<>$4
        AND state NOT IN ('published','stale_context')`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.contextVersionId,
      input.generatedAt,
      input.actorId,
    ],
  );
  const blueprintId = randomUUID();
  await input.client.query(
    `INSERT INTO backlink_commercial_discovery_blueprints (
       id,organization_id,workspace_id,website_project_id,
       project_context_version_id,blueprint_version,status,generator,
       schema_version,prompt_version,model_version,rule_version,
       blueprint,evidence_refs,generated_at,created_by
     ) VALUES (
       $1,$2,$3,$4,$5,1,'active',$6,$7,$8,$9,$10,$11::jsonb,
       $12::jsonb,$13,$14
     )
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,
       project_context_version_id,blueprint_version
     ) DO NOTHING`,
    [
      blueprintId,
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.contextVersionId,
      input.blueprint.generator,
      input.blueprint.schemaVersion,
      input.blueprint.promptVersion,
      input.blueprint.modelVersion,
      input.blueprint.ruleVersion,
      JSON.stringify(input.blueprint),
      JSON.stringify(input.blueprint.evidenceRefs),
      input.generatedAt,
      input.actorId,
    ],
  );
  const selected = await input.client.query(
    `SELECT id
       FROM backlink_commercial_discovery_blueprints
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND project_context_version_id=$4
        AND blueprint_version=1
      LIMIT 1`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.contextVersionId,
    ],
  );
  const storedId = selected.rows[0]?.id;
  if (storedId === undefined) {
    throw new Error("COMMERCIAL_DISCOVERY_BLUEPRINT_NOT_STORED");
  }
  return String(storedId);
}

async function openBatch(input: Readonly<{
  client: CommercialDiscoveryQueryClient;
  scope: Scope;
  blueprintId: string;
  contextVersionId: string;
  jobId: string;
  actorId: string;
  startedAt: Date;
}>): Promise<string> {
  const batchId = randomUUID();
  const result = await input.client.query(
    `INSERT INTO backlink_commercial_discovery_batches (
       id,organization_id,workspace_id,website_project_id,blueprint_id,
       project_context_version_id,status,idempotency_key,request_intent,
       source_types,started_at,created_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,'running',$7,'DISCOVERY',
       '["EXISTING_HISTORY"]'::jsonb,$8,$9
     )
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,
       project_context_version_id,idempotency_key
     ) DO UPDATE SET
       status='running',pause_reason=NULL,finished_at=NULL
     RETURNING id`,
    [
      batchId,
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.blueprintId,
      input.contextVersionId,
      `commercial-discovery:${input.jobId}`,
      input.startedAt,
      input.actorId,
    ],
  );
  const storedId = result.rows[0]?.id;
  if (storedId === undefined) {
    throw new Error("COMMERCIAL_DISCOVERY_BATCH_NOT_STORED");
  }
  return String(storedId);
}

async function remainingBudgetMicros(input: Readonly<{
  client: CommercialDiscoveryQueryClient;
  scope: Scope;
  absoluteBudgetMicros: number;
}>): Promise<number> {
  const result = await input.client.query(
    `SELECT GREATEST(limit_micros-spent_micros-reserved_micros,0)
            AS remaining
       FROM backlink_provider_budgets
      WHERE organization_id=$1 AND workspace_id=$2
        AND provider='dataforseo'
        AND period_start<=now() AND period_end>now()
      ORDER BY period_start DESC
      LIMIT 1`,
    [input.scope.organizationId, input.scope.workspaceId],
  );
  const remaining = Number(result.rows[0]?.remaining ?? 0);
  return Math.max(0, Math.min(input.absoluteBudgetMicros, remaining));
}

function providerSource(
  sources: readonly (
    "cache" | "stale-cache" | "single-flight" | "provider"
  )[],
): "cache" | "stale-cache" | "single-flight" | "provider" {
  if (sources.includes("provider")) return "provider";
  if (sources.includes("single-flight")) return "single-flight";
  if (sources.includes("stale-cache")) return "stale-cache";
  return "cache";
}

function candidateState(
  decision: CommercialScoreDecision["decision"],
): "candidate_ready" | "excluded" | "insufficient_data" | "manual_review" {
  return decision === "ready" ? "candidate_ready" : decision;
}

export async function executeCommercialRecommendationDiscovery(
  input: Readonly<{
    client: CommercialDiscoveryQueryClient;
    provider: CommercialDataForSeoRuntime;
    gate: DataForSeoCallGate;
    safeFetch: Pick<SafeFetchPort, "fetch">;
    scope: Scope;
    contextVersionId: string;
    context: CommercialRecommendationContext;
    configuration: CommercialRecommendationDiscoveryConfiguration;
    requestedCount: number;
    jobId: string;
    actorId: string;
    now(): Date;
  }>,
): Promise<CommercialRecommendationDiscoveryResult> {
  const startedAt = input.now();
  const evidenceRefs = await collectBlueprintEvidence({
    scope: input.scope,
    contextVersionId: input.contextVersionId,
    context: input.context,
    safeFetch: input.safeFetch,
  });
  const blueprint = buildCommercialDiscoveryBlueprint({
    context: {
      projectContextVersionId: input.contextVersionId,
      countries: [input.context.countryCode],
      languages: [input.context.locale, input.configuration.languageCode],
      products: input.context.products,
      keywords: input.context.keywords,
      promotionTargetUrls: input.context.targetUrls,
      explicitCompetitorDomains: input.configuration.discoveryTargets,
      evidenceRefs,
    },
  });
  const blueprintId = await persistBlueprint({
    client: input.client,
    scope: input.scope,
    contextVersionId: input.contextVersionId,
    blueprint,
    actorId: input.actorId,
    generatedAt: startedAt,
  });
  await input.client.query(
    `INSERT INTO backlink_commercial_inventory_policies (
       organization_id,workspace_id,website_project_id,
       project_context_version_id,updated_by
     ) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,
       project_context_version_id
     ) DO UPDATE SET updated_at=now(),updated_by=EXCLUDED.updated_by`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.contextVersionId,
      input.actorId,
    ],
  );
  const batchId = await openBatch({
    client: input.client,
    scope: input.scope,
    blueprintId,
    contextVersionId: input.contextVersionId,
    jobId: input.jobId,
    actorId: input.actorId,
    startedAt,
  });
  const history = await loadHistory(
    input.client,
    input.scope,
    input.context,
  );
  const budget = await remainingBudgetMicros({
    client: input.client,
    scope: input.scope,
    absoluteBudgetMicros: input.configuration.absoluteBudgetMicros,
  });
  const plan = createCommercialDiscoveryPlan({
    searchQueries: blueprint.searchQueryClusters,
    verifiedCompetitorDomains: [
      ...blueprint.explicitCompetitorDomains,
      ...blueprint.discoveredCompetitorSeeds,
    ],
    userDomain: input.context.canonicalDomain,
    locationCode: input.configuration.locationCode,
    languageCode: input.configuration.languageCode,
    endpointAllowlist: input.configuration.endpointAllowlist,
    estimatedCostMicros: input.configuration.estimatedCostMicros,
    remainingBudgetMicros: budget,
  });
  const requestService = new CommercialDiscoveryRequestService({
    client: input.client,
    provider: input.provider,
    gate: input.gate,
    now: input.now,
  });
  const artifacts: CommercialDiscoveryArtifact[] = [];
  const sources: (
    "cache" | "stale-cache" | "single-flight" | "provider"
  )[] = [];
  let pauseReason: string | null = plan.length === 0
    ? "budget_or_endpoint_allowlist"
    : null;
  let failureStatus: "paused" | "unavailable" | null = plan.length === 0
    ? "paused"
    : null;
  for (const [index, call] of plan.entries()) {
    const fingerprint = fingerprintCommercialDiscoveryCall(call);
    const context: ProviderRequestContext = {
      ...input.scope,
      requestId: `${input.jobId}:${index + 1}`,
      idempotencyKey: `commercial-discovery:${input.jobId}:${fingerprint}`,
      budgetReservationId: `${input.jobId}:${fingerprint}`,
    };
    try {
      const result = await requestService.execute({
        context,
        projectContextVersionId: input.contextVersionId,
        call,
        locationCode: input.configuration.locationCode,
        languageCode: input.configuration.languageCode,
        refreshMode: "CACHE_PREFERRED",
        actorId: input.actorId,
      });
      artifacts.push(result.artifact);
      sources.push(result.source);
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "DATAFORSEO_DISCOVERY_UNAVAILABLE";
      if (
        message.includes("CHARGE_RECONCILIATION")
        || message.includes("unknown_charge")
      ) {
        throw error;
      }
      pauseReason = message.slice(0, 255);
      failureStatus = error instanceof Error
        && error.name === "DataForSeoCallBlockedError"
        ? "paused"
        : "unavailable";
      break;
    }
  }

  const merged = mergeCommercialDiscoveryArtifacts({
    artifacts,
    userDomain: input.context.canonicalDomain,
    excludedDomains: [...history.excludedDomains],
  }).slice(0, Math.min(
    input.configuration.candidateLimit,
    Math.max(10, input.requestedCount * 4),
  ));
  const collectedAt = artifacts.map(({ collectedAt }) => collectedAt)
    .sort().at(-1) ?? startedAt.toISOString();
  const evaluated = await mapConcurrent(
    merged,
    staticAssessmentConcurrency,
    async (candidate) => {
      const staticAssessment = await assessCommercialCandidateSite({
        canonicalDomain: candidate.canonicalDomain,
        workspaceId: input.scope.workspaceId,
        websiteProjectId: input.scope.websiteProjectId,
        projectTerms: [
          ...input.context.products,
          ...input.context.keywords,
          ...blueprint.topicClusters,
        ],
        safeFetch: input.safeFetch,
        now: () => input.now().toISOString(),
      });
      const commercialScore = evaluateCommercialCandidate({
        business: {
          selfOrRelatedDomain:
            candidate.canonicalDomain === input.context.canonicalDomain,
          existingBacklinkOrOpportunity: false,
          permanentlyRejectedOrSuppressed:
            history.previouslyExcludedDomains.has(candidate.canonicalDomain),
          unsafeOrDisallowedIndustry: false,
          strictMarketMode: false,
          expectedLanguages: [
            input.context.locale,
            input.configuration.languageCode,
          ],
        },
        provider: {
          rank: candidate.rank,
          backlinkCount: candidate.backlinkCount,
          referringDomainCount: candidate.referringDomainCount,
          spamScore: candidate.spamScore,
          evidenceRefs: candidate.evidenceRefs,
          collectedAt,
        },
        staticAssessment,
      });
      return Object.freeze({
        hostnameAscii: candidate.canonicalDomain,
        sourceTypes: candidate.sourceTypes,
        provider: Object.freeze({
          rank: candidate.rank,
          backlinkCount: candidate.backlinkCount,
          referringDomainCount: candidate.referringDomainCount,
          spamScore: candidate.spamScore,
          evidenceRefs: candidate.evidenceRefs,
          collectedAt,
        }),
        staticAssessment,
        commercialScore,
      });
    },
  );

  for (const candidate of evaluated) {
    await input.client.query(
      `INSERT INTO backlink_commercial_candidates (
         id,organization_id,workspace_id,website_project_id,blueprint_id,
         discovery_batch_id,project_context_version_id,canonical_domain,
         source_types,static_assessment,gate_decision,commercial_score,
         score_model_version,state,provider_collected_at,
         created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,
         $12::jsonb,$13,$14,$15,$16,$16
       )
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         project_context_version_id,canonical_domain
       ) DO UPDATE SET
         blueprint_id=EXCLUDED.blueprint_id,
         discovery_batch_id=EXCLUDED.discovery_batch_id,
         source_types=EXCLUDED.source_types,
         static_assessment=EXCLUDED.static_assessment,
         gate_decision=EXCLUDED.gate_decision,
         commercial_score=EXCLUDED.commercial_score,
         score_model_version=EXCLUDED.score_model_version,
         state=CASE
           WHEN backlink_commercial_candidates.state IN (
             'contact_enrichment','published'
           ) THEN backlink_commercial_candidates.state
           ELSE EXCLUDED.state
         END,
         provider_collected_at=EXCLUDED.provider_collected_at,
         updated_at=now(),updated_by=EXCLUDED.updated_by,
         version=backlink_commercial_candidates.version+1`,
      [
        randomUUID(),
        input.scope.organizationId,
        input.scope.workspaceId,
        input.scope.websiteProjectId,
        blueprintId,
        batchId,
        input.contextVersionId,
        candidate.hostnameAscii,
        JSON.stringify(candidate.sourceTypes),
        JSON.stringify(candidate.staticAssessment),
        JSON.stringify({
          decision: candidate.commercialScore.decision,
          hitGates: candidate.commercialScore.hitGates,
          missingEvidence: candidate.commercialScore.missingEvidence,
        }),
        JSON.stringify(candidate.commercialScore),
        candidate.commercialScore.scoreModelVersion,
        candidateState(candidate.commercialScore.decision),
        collectedAt,
        input.actorId,
      ],
    );
  }

  const finishedAt = input.now();
  const batchStatus = failureStatus
    ?? (artifacts.length > 0 || plan.length === 0 ? "completed" : "unavailable");
  const sourceTypes = [
    "EXISTING_HISTORY",
    ...new Set(artifacts.map(({ sourceType }) => sourceType)),
  ];
  const fingerprints = artifacts.map(({ requestFingerprint }) =>
    requestFingerprint
  );
  const paidCostMicros = artifacts.reduce(
    (sum, artifact) => sum + artifact.costMicros,
    0,
  );
  await input.client.query(
    `UPDATE backlink_commercial_discovery_batches
        SET status=$5,source_types=$6::jsonb,
            provider_request_fingerprints=$7::jsonb,
            provider_collected_at=$8,paid_cost_micros=$9,
            pause_reason=$10,finished_at=$11
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND id=$4`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      batchId,
      batchStatus,
      JSON.stringify(sourceTypes),
      JSON.stringify(fingerprints),
      artifacts.length === 0 ? null : collectedAt,
      paidCostMicros,
      pauseReason,
      finishedAt,
    ],
  );
  await input.client.query(
    `UPDATE backlink_commercial_inventory_policies
        SET latest_refill_at=$5,next_refill_at=$6,
            latest_provider_collected_at=$7,pause_reason=$8,
            updated_at=$5,updated_by=$9,version=version+1
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND project_context_version_id=$4`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.contextVersionId,
      finishedAt,
      new Date(finishedAt.getTime() + 15 * 60_000),
      artifacts.length === 0 ? null : collectedAt,
      pauseReason,
      input.actorId,
    ],
  );
  const ranked = rankCommercialRecommendations(evaluated)
    .filter(({ commercialScore }) => commercialScore.decision === "ready")
    .slice(0, input.requestedCount);
  return Object.freeze({
    candidates: Object.freeze(ranked),
    provider: Object.freeze({
      source: providerSource(sources),
      acquiredAt: collectedAt,
      costMicros: paidCostMicros,
      requestFingerprint: aggregateHash(
        fingerprints.length === 0
          ? [`commercial-discovery:${batchId}`]
          : fingerprints,
      ),
    }),
  });
}
