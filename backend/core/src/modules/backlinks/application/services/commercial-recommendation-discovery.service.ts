import { createHash, randomUUID } from "node:crypto";

import type { DataForSeoCallGate } from "../policies/dataforseo-call.policy.js";
import type { CommercialDataForSeoRuntime } from "../../adapters/dataforseo/commercial-official-runtime.js";
import { commercialPageParser } from "../../adapters/html/commercial-page-parser.adapter.js";
import {
  assessCommercialDiscoveryInputReadiness,
  buildCommercialDiscoveryBlueprint,
  commercialDiscoveryBlueprintSchemaVersion,
  commercialDiscoveryBlueprintVersion,
  type CommercialDiscoveryBlueprint,
  type CommercialDiscoveryAiGeneration,
  type CommercialDiscoveryAiModel,
  type CommercialDiscoveryBlueprintContext,
} from "../../domain/recommendations/commercial-discovery-blueprint.js";
import {
  commercialDiscoveryCallSchema,
  commercialDiscoverySemanticPlanningQueryLimit,
  createCommercialDiscoveryPlan,
  fingerprintCommercialDiscoveryCall,
  fingerprintCommercialDiscoverySemanticRequest,
  mergeCommercialDiscoveryArtifacts,
  parseCommercialDiscoveryRequestPayload,
  type CommercialBacklinkPageEvidence,
  type CommercialDiscoveryArtifact,
  type CommercialDiscoveryCall,
  type CommercialDiscoverySourceType,
} from "../../domain/recommendations/commercial-discovery-source.js";
import {
  applyProgressiveCommercialCandidateAdmission,
  evaluateCommercialCandidate,
} from "../../domain/recommendations/commercial-candidate-evaluation.js";
import {
  selectCommercialCandidateEnrichment,
  type CommercialCandidateEnrichmentDecision,
} from "../../domain/recommendations/commercial-candidate-enrichment.js";
import {
  rankCommercialRecommendationFits,
  type CommercialFitAdmission,
  type CommercialFitDecision,
} from "../../domain/recommendations/commercial-score-v4.js";
import {
  commercialSemanticDiscoveryPaidCallReserve,
} from "../../domain/recommendations/provider-operation-budget.js";
import {
  recommendationDiscoveryRoundBudgetMicros,
} from "../../domain/recommendations/recommendation-pool-v2-policy.js";
import {
  buildCommercialRefillWindowKey,
  type CommercialRefillTier,
} from "../../domain/recommendations/commercial-refill-cycle.js";
import { calculateProjectAuthority } from "../../domain/recommendations/resource-library-authority.js";
import type { CommercialCandidateFitDecision } from "../../domain/recommendations/commercial-candidate-evaluation.js";
import {
  assessCommercialCandidateSite,
  commercialStaticAssessmentRuleVersion,
  type CommercialStaticAssessment,
} from "../../domain/recommendations/commercial-static-assessment.js";
import type { SafeFetchPort } from "../../ports/safe-fetch.port.js";
import type { ProviderRequestContext } from "../../ports/dataforseo.port.js";
import type { AiCommercialDiscoveryBlueprintPort } from "../../ports/ai-commercial-discovery-blueprint.port.js";
import type {
  GenerationInputBinding,
} from "../../ports/shared-seo-evidence.port.js";
import {
  CommercialDiscoveryRequestService,
  type CommercialDiscoveryQueryClient,
  type CommercialDiscoveryRequestResult,
} from "./commercial-discovery-request.service.js";
import type {
  CommercialDiscoveryEvidenceReusePort,
} from "./shared-seo-commercial-discovery.service.js";
import {
  extractTargetLanguageSearchPhrases,
} from "./target-language-search-phrase.js";

const nativeV2BlueprintIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
const defaultProviderRequestConcurrency = 1;
const maximumProviderRequestConcurrency = 4;
const crossGenerationReassessmentStates = new Set([
  "candidate_ready",
  "enrichment_eligible",
  "insufficient_data",
  "manual_review",
]);
const currentV4VisiblePoolPredicate = `(
  policy.visible_pool_state='building'
  OR (
    policy.visible_pool_state='active'
    AND EXISTS (
      SELECT 1
        FROM backlink_recommendation_generation_contracts AS contract
       WHERE (
         contract.organization_id,contract.workspace_id,
         contract.website_project_id,
         contract.recommendation_context_version_id,
         contract.visible_pool_generation
       )=(
         policy.organization_id,policy.workspace_id,
         policy.website_project_id,
         policy.project_context_version_id,
         policy.visible_pool_generation
       )
         AND contract.qualification_contract_version=
           'recommendation-qualification.v1'
         AND contract.visibility_contract_version=
           'recommendation-visibility.v1'
         AND contract.score_model_version=
           'recommendation-commercial-fit.v4'
    )
  )
)`;

function providerRequestStatus(
  error: unknown,
): "failed" | "unknown_charge" | null {
  if (
    typeof error !== "object"
    || error === null
    || !("providerRequestStatus" in error)
  ) {
    return null;
  }
  return error.providerRequestStatus === "failed"
    || error.providerRequestStatus === "unknown_charge"
    ? error.providerRequestStatus
    : null;
}

function isExpectedProviderFailure(error: unknown): boolean {
  return providerRequestStatus(error) !== null
    || (error instanceof Error
      && error.name === "DataForSeoCallBlockedError");
}

export type CommercialRecommendationContext = Readonly<{
  snapshotVersion: number;
  profileVersionId: string;
  promotionTargetVersionId: string;
  projectSettingsVersionId: string;
  projectSettingsVersion: number;
  canonicalDomain: string;
  locale: string;
  countryCode: string;
  products: readonly string[];
  keywords: readonly string[];
  targetUrls: readonly string[];
  targetAudiences: readonly string[];
  partnershipGoals: readonly string[];
  explicitCompetitorDomains: readonly string[];
}>;

export type CommercialRecommendationDiscoveryConfiguration = Readonly<{
  endpointAllowlist: readonly string[];
  estimatedCostMicros: number;
  absoluteBudgetMicros: number;
  candidateLimit: number;
  locationCode: string;
  languageCode: string;
  providerRequestConcurrency?: number;
}>;

export type CommercialRecommendationNativeV2RequestPort = Readonly<{
  authoritativeBlueprintId: string;
  verifiedCompetitorDomains?: readonly string[];
  maxRequests: number;
  maxAuthorizedCostMicros: number;
  requestOffset?: number;
  excludedSemanticRequestFingerprints?: readonly string[];
  recordRequestPlan?(
    input: Readonly<{
      calls: readonly CommercialDiscoveryCall[];
      selectedCalls: readonly CommercialDiscoveryCall[];
    }>,
  ): Promise<void>;
  shouldContinue?(): Promise<boolean>;
  prepareRequest(input: Readonly<{
    call: CommercialDiscoveryCall;
    index: number;
    requestFingerprint: string;
  }>): Promise<Readonly<{
    context: ProviderRequestContext;
    actorId: string;
    refreshMode: "CACHE_PREFERRED" | "FORCE_LIVE";
    replayResult?: CommercialDiscoveryRequestResult;
  }>>;
  recordRequestStarted?(input: Readonly<{
    call: CommercialDiscoveryCall;
    index: number;
    requestFingerprint: string;
    replayed: boolean;
  }>): Promise<void>;
  recordRequestCompleted?(input: Readonly<{
    call: CommercialDiscoveryCall;
    index: number;
    requestFingerprint: string;
    replayed: boolean;
    status: "SUCCEEDED" | "FAILED";
  }>): Promise<void>;
  recordRequestSuccess(input: Readonly<{
    call: CommercialDiscoveryCall;
    index: number;
    requestFingerprint: string;
    result: CommercialDiscoveryRequestResult;
  }>): Promise<void>;
  recordRequestFailure(input: Readonly<{
    call: CommercialDiscoveryCall;
    index: number;
    requestFingerprint: string;
    error: unknown;
  }>): Promise<void>;
}>;

export type CommercialRecommendationNativeV2RequestResult = Readonly<{
  call: CommercialDiscoveryCall;
  index: number;
  requestFingerprint: string;
  result: CommercialDiscoveryRequestResult;
}>;

export type CommercialReadyCandidate = Readonly<{
  hostnameAscii: string;
  sourceTypes: readonly CommercialDiscoverySourceType[];
  business: Parameters<typeof evaluateCommercialCandidate>[0]["business"];
  provider: Readonly<{
    rank: number | null;
    traffic: number | null;
    backlinkCount: number | null;
    referringDomainCount: number | null;
    spamScore: number | null;
    countryCode: string | null;
    backlinkPageEvidence: readonly CommercialBacklinkPageEvidence[];
    evidenceRefs: readonly string[];
    collectedAt: string;
  }>;
  staticAssessment: CommercialStaticAssessment;
  commercialScore: CommercialCandidateFitDecision;
}>;

export type CommercialRecommendationDiscoveryResult = Readonly<{
  candidates: readonly CommercialReadyCandidate[];
  enrichmentCandidates: readonly CommercialReadyCandidate[];
  admission: CommercialFitAdmission;
  provider: Readonly<{
    source: "cache" | "stale-cache" | "single-flight" | "provider";
    acquiredAt: string;
    costMicros: number;
    requestFingerprint: string;
  }>;
  discovery: Readonly<{
    semanticStatus: "not_required" | "completed" | "paused" | "unavailable";
    semanticRequiredCallCount: number;
    semanticCompletedCallCount: number;
    reason: string | null;
  }>;
}>;

export type CommercialRecommendationNativeV2DiscoveryResult = Readonly<{
  candidates: readonly never[];
  requests: readonly CommercialRecommendationNativeV2RequestResult[];
  provider: CommercialRecommendationDiscoveryResult["provider"];
  discovery: CommercialRecommendationDiscoveryResult["discovery"];
}>;

export function orderCommercialNativeV2DiscoveryCalls(
  calls: readonly CommercialDiscoveryCall[],
): readonly CommercialDiscoveryCall[] {
  const competitors = calls.filter(
    (call) => call.sourceType === "VERIFIED_COMPETITOR_REFERRING_DOMAINS",
  );
  const searches = calls.filter(
    (call) => call.sourceType === "BLUEPRINT_SERP_STANDARD_QUEUE",
  );
  const ordered: CommercialDiscoveryCall[] = [];
  for (let index = 0; index < Math.max(competitors.length, searches.length); index += 1) {
    const competitor = competitors[index];
    const search = searches[index];
    if (competitor !== undefined) ordered.push(competitor);
    if (search !== undefined) ordered.push(search);
  }
  return Object.freeze(ordered);
}

export function selectCommercialNativeV2RequestPlan(
  input: Readonly<{
    calls: readonly CommercialDiscoveryCall[];
    requestOffset?: number;
    maxRequests: number;
    maxAuthorizedCostMicros: number;
  }>,
): readonly CommercialDiscoveryCall[] {
  const requestOffset = input.requestOffset ?? 0;
  if (
    !Number.isSafeInteger(requestOffset)
    || requestOffset < 0
    || !Number.isSafeInteger(input.maxRequests)
    || input.maxRequests < 1
    || input.maxRequests > commercialSemanticDiscoveryPaidCallReserve
    || !Number.isSafeInteger(input.maxAuthorizedCostMicros)
    || input.maxAuthorizedCostMicros < 0
    || input.maxAuthorizedCostMicros > recommendationDiscoveryRoundBudgetMicros
  ) {
    throw new TypeError(
      "Recommendation V2 native discovery request plan is invalid.",
    );
  }

  const selected: CommercialDiscoveryCall[] = [];
  let authorizedCostMicros = 0;
  for (const call of input.calls.slice(requestOffset)) {
    if (selected.length >= input.maxRequests) break;
    if (
      authorizedCostMicros + call.estimatedCostMicros
      > input.maxAuthorizedCostMicros
    ) {
      break;
    }
    selected.push(call);
    authorizedCostMicros += call.estimatedCostMicros;
  }
  return Object.freeze(selected);
}

type CommercialDiscoveryRequestClientLease = Readonly<{
  client: CommercialDiscoveryQueryClient;
  gate?: DataForSeoCallGate;
  release(): Promise<void> | void;
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

export type CuratedResourceProjectMatch = Readonly<{
  eligible: boolean;
  score: number;
  resourceType: "free" | "paid";
  matchedTerms: readonly string[];
  marketMatched: boolean;
  languageMatched: boolean;
  authorityMatched: boolean;
  reasonCodes: readonly string[];
}>;

type CuratedResourceMatchInput = Readonly<{
  categories: readonly string[];
  tags: readonly string[];
  countryLanguage: string | null;
  resourceType: "free" | "paid";
  authorityScore: number;
  riskLevel: string | null;
}>;

const projectMatchStopWords = new Set([
  "and",
  "app",
  "application",
  "business",
  "digital",
  "for",
  "from",
  "guide",
  "industry",
  "management",
  "marketing",
  "online",
  "platform",
  "service",
  "site",
  "software",
  "solution",
  "system",
  "technology",
  "the",
  "tool",
  "with",
]);

const nonSemanticResourceLabels = new Set([
  "other / needs review",
]);

function projectMatchTokens(values: readonly string[]): ReadonlySet<string> {
  return new Set(
    values
      .filter(
        (value) =>
          !nonSemanticResourceLabels.has(value.trim().toLowerCase()),
      )
      .flatMap((value) =>
        value
          .toLowerCase()
          .split(/[^a-z0-9]+/u)
          .filter(
            (token) => token.length >= 3 && !projectMatchStopWords.has(token),
          ),
      ),
  );
}

export function scoreCuratedResourceForProject(
  input: Readonly<{
    resource: CuratedResourceMatchInput;
    blueprint: CommercialDiscoveryBlueprint;
    minimumAuthorityScore: number;
  }>,
): CuratedResourceProjectMatch {
  const resourceTokens = projectMatchTokens([
    ...input.resource.categories,
    ...input.resource.tags,
  ]);
  const projectTokens = projectMatchTokens([
    ...input.blueprint.products,
    ...input.blueprint.keywords,
    ...input.blueprint.topicClusters,
    ...input.blueprint.targetAudience,
    ...input.blueprint.targetSiteArchetypes,
  ]);
  const matchedTerms = [...projectTokens]
    .filter((token) => resourceTokens.has(token))
    .sort();
  const market = input.resource.countryLanguage?.toLowerCase() ?? "";
  const marketMatched = input.blueprint.countries.some((country) =>
    market.includes(country.toLowerCase()),
  );
  const languageMatched = input.blueprint.languages.some((language) => {
    const normalized = language.toLowerCase();
    return (
      market.includes(normalized) ||
      market.includes(normalized.split("-")[0] ?? normalized)
    );
  });
  const marketEvidenceMissing = market.length === 0;
  const authorityMatched =
    input.resource.authorityScore >= input.minimumAuthorityScore;
  const lowRisk = input.resource.riskLevel === "low";
  const projectMatched = matchedTerms.length > 0;
  const marketCompatible =
    marketEvidenceMissing || marketMatched || languageMatched;
  const reasonCodes = [
    ...(projectMatched ? [] : ["RESOURCE_PROJECT_TOPIC_MISMATCH"]),
    ...(marketCompatible ? [] : ["RESOURCE_PROJECT_MARKET_MISMATCH"]),
    ...(authorityMatched ? [] : ["RESOURCE_AUTHORITY_BELOW_PROJECT"]),
    ...(lowRisk ? [] : ["RESOURCE_RISK_NOT_LOW"]),
  ];
  return Object.freeze({
    eligible: projectMatched && marketCompatible && authorityMatched && lowRisk,
    score: Math.min(
      100,
      Math.min(60, matchedTerms.length * 15) +
        (marketMatched ? 15 : languageMatched ? 10 : 5) +
        Math.min(25, Math.round(input.resource.authorityScore / 4)),
    ),
    resourceType: input.resource.resourceType,
    matchedTerms: Object.freeze(matchedTerms),
    marketMatched,
    languageMatched,
    authorityMatched,
    reasonCodes: Object.freeze(reasonCodes),
  });
}

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
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value !== undefined) output[index] = await mapper(value);
      }
    }),
  );
  return Object.freeze(output);
}

async function collectBlueprintEvidence(
  input: Readonly<{
    contextVersionId: string;
    context: CommercialRecommendationContext;
    inputBinding: GenerationInputBinding;
  }>,
): Promise<readonly string[]> {
  const evidence = new Set<string>([
    `postgresql:project-context:${input.contextVersionId}:snapshot:${input.context.snapshotVersion}`,
    `postgresql:project-settings:${input.context.projectSettingsVersionId}:version:${input.context.projectSettingsVersion}`,
    `postgresql:outreach-profile:${input.inputBinding.outreachProfileRecordId}:profile-version:${input.context.profileVersionId}`,
    `postgresql:generation-input-pin:${input.inputBinding.inputPinId}`,
  ]);
  for (const item of input.inputBinding.sharedEvidence) {
    evidence.add(
      `platform-evidence:${item.recordId}:${item.snapshot.sourceModule}:${item.snapshot.sourceVersion}`,
    );
  }
  return Object.freeze([...evidence].sort());
}

async function loadHistory(
  client: CommercialDiscoveryQueryClient,
  scope: Scope,
  contextVersionId: string,
  context: CommercialRecommendationContext,
  allowCrossGenerationReassessment: boolean,
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
  const candidates = await client.query(
    `SELECT canonical_domain AS hostname,state,
            recommendation_id AS "recommendationId",
            prospect_id AS "prospectId"
       FROM backlink_commercial_candidates
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND project_context_version_id=$4
        AND state<>'stale_context'
        AND static_assessment->>'ruleVersion'=$5`,
    [
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      contextVersionId,
      commercialStaticAssessmentRuleVersion,
    ],
  );
  const excluded = new Set<string>(blockedDiscoveryDomains);
  const previouslyExcluded = new Set<string>();
  for (const row of prospects.rows) {
    const hostname = String(row.hostname ?? "")
      .trim()
      .toLowerCase();
    if (hostname.length === 0) continue;
    excluded.add(hostname);
    if (row.previouslyExcluded === true) previouslyExcluded.add(hostname);
  }
  for (const row of placements.rows) {
    const hostname = hostnameFromUrl(row.sourceUrl);
    if (hostname !== null) excluded.add(hostname);
  }
  for (const row of opportunities.rows) {
    const hostname = String(row.hostname ?? "")
      .trim()
      .toLowerCase();
    if (hostname.length > 0) excluded.add(hostname);
  }
  for (const row of candidates.rows) {
    const hostname = String(row.hostname ?? "")
      .trim()
      .toLowerCase();
    if (hostname.length === 0) continue;
    const canReassess =
      allowCrossGenerationReassessment
      && row.recommendationId == null
      && row.prospectId == null
      && crossGenerationReassessmentStates.has(String(row.state));
    if (!canReassess) excluded.add(hostname);
    if (row.state === "excluded") previouslyExcluded.add(hostname);
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

async function persistBlueprint(
  input: Readonly<{
    client: CommercialDiscoveryQueryClient;
    scope: Scope;
    contextVersionId: string;
    blueprint: CommercialDiscoveryBlueprint;
    actorId: string;
    generatedAt: Date;
  }>,
): Promise<string> {
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
       $1,$2,$3,$4,$5,${commercialDiscoveryBlueprintVersion},'active',
       $6,$7,$8,$9,$10,$11::jsonb,
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
        AND blueprint_version=${commercialDiscoveryBlueprintVersion}
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

function storedBlueprint(
  value: unknown,
  contextVersionId: string,
): CommercialDiscoveryBlueprint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("COMMERCIAL_DISCOVERY_BLUEPRINT_INVALID");
  }
  const record = value as Record<string, unknown>;
  if (
    record.blueprintVersion !== commercialDiscoveryBlueprintVersion ||
    record.schemaVersion !== commercialDiscoveryBlueprintSchemaVersion ||
    record.projectContextVersionId !== contextVersionId ||
    !Array.isArray(record.searchQueryClusters) ||
    !Array.isArray(record.explicitCompetitorDomains) ||
    !Array.isArray(record.discoveredCompetitorSeeds) ||
    !Array.isArray(record.evidenceRefs) ||
    !["AI", "DETERMINISTIC_FALLBACK"].includes(String(record.generator))
  ) {
    throw new Error("COMMERCIAL_DISCOVERY_BLUEPRINT_INVALID");
  }
  return Object.freeze(value as CommercialDiscoveryBlueprint);
}

async function loadBlueprint(
  input: Readonly<{
    client: CommercialDiscoveryQueryClient;
    scope: Scope;
    contextVersionId: string;
    projectSettingsVersionId: string;
  }>,
): Promise<Readonly<{
  id: string;
  blueprint: CommercialDiscoveryBlueprint;
}> | null> {
  const result = await input.client.query(
    `SELECT id,blueprint
       FROM backlink_commercial_discovery_blueprints
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND project_context_version_id=$4
        AND blueprint_version=${commercialDiscoveryBlueprintVersion}
      LIMIT 1`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.contextVersionId,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const blueprint = storedBlueprint(row.blueprint, input.contextVersionId);
  if (blueprint.projectSettingsVersionId !== input.projectSettingsVersionId) {
    throw new Error("COMMERCIAL_DISCOVERY_CONTEXT_SETTINGS_MISMATCH");
  }
  return Object.freeze({
    id: String(row.id),
    blueprint,
  });
}

function blueprintContext(
  input: Readonly<{
    contextVersionId: string;
    context: CommercialRecommendationContext;
    configuration: CommercialRecommendationDiscoveryConfiguration;
    evidenceRefs: readonly string[];
    historicalFeedbackDomains: readonly string[];
  }>,
): CommercialDiscoveryBlueprintContext {
  return Object.freeze({
    projectContextVersionId: input.contextVersionId,
    projectSettingsVersionId: input.context.projectSettingsVersionId,
    projectSettingsVersion: input.context.projectSettingsVersion,
    canonicalDomain: input.context.canonicalDomain,
    countries: [input.context.countryCode],
    languages: [input.context.locale, input.configuration.languageCode],
    products: input.context.products,
    keywords: input.context.keywords,
    promotionTargetUrls: input.context.targetUrls,
    declaredTargetAudiences: input.context.targetAudiences,
    partnershipGoals: input.context.partnershipGoals,
    explicitCompetitorDomains: input.context.explicitCompetitorDomains,
    historicalFeedbackDomains: input.historicalFeedbackDomains,
    evidenceRefs: input.evidenceRefs,
  });
}

export type CommercialDiscoveryBatchClaim = Readonly<{
  batchId: string;
  disposition: "resumed" | "same_owner";
}>;

export async function claimPausedCommercialDiscoveryBatch(
  input: Readonly<{
    client: CommercialDiscoveryQueryClient;
    scope: Scope;
    contextVersionId: string;
    visiblePoolGeneration: number;
    jobId: string;
    refillKey: string;
    inputBinding: GenerationInputBinding;
    actorId: string;
    claimedAt: Date;
    acceptedProviderRecoveryPending?: boolean;
  }>,
): Promise<CommercialDiscoveryBatchClaim | null> {
  const lifecycleId = randomUUID();
  const auditId = randomUUID();
  const lineageKey = [
    "commercial-discovery-batch-resumed",
    input.scope.websiteProjectId,
    input.contextVersionId,
    input.visiblePoolGeneration,
    input.jobId,
  ].join(":");
  const auditRequestId = `${lineageKey}:audit`;
  const integrityHash = aggregateHash([
    lineageKey,
    input.inputBinding.inputPinId,
    input.inputBinding.immutableFingerprint,
  ]);
  const result = await input.client.query(
    `/* COMMERCIAL_DISCOVERY_BATCH_TAKEOVER */
     WITH locked_batch AS MATERIALIZED (
       SELECT batch.*
         FROM backlink_commercial_discovery_batches AS batch
        WHERE (batch.organization_id,batch.workspace_id,
               batch.website_project_id)=($1::uuid,$2::uuid,$3::uuid)
          AND batch.project_context_version_id=$4::uuid
          AND batch.visible_pool_generation=$5
          AND batch.idempotency_key=$6
        FOR UPDATE OF batch
     ),
     old_owner AS MATERIALIZED (
       SELECT job.id,job.status,refill.id AS refill_id
         FROM locked_batch AS batch
         JOIN backlink_jobs AS job
           ON (job.organization_id,job.workspace_id,
               job.website_project_id,job.id)=(
                batch.organization_id,batch.workspace_id,
                batch.website_project_id,batch.refill_job_id
              )
         JOIN backlink_recommendation_refills AS refill
           ON (refill.organization_id,refill.workspace_id,
               refill.website_project_id,refill.job_id)=(
                job.organization_id,job.workspace_id,
                job.website_project_id,job.id
              )
          AND refill.recommendation_context_version_id=$4::uuid
          AND refill.visible_pool_generation=$5
        FOR UPDATE OF job,refill
     ),
     new_owner AS MATERIALIZED (
       SELECT job.id,job.status,job.version,job.correlation_id,
              job.result_summary,refill.id AS refill_id
         FROM backlink_jobs AS job
         JOIN backlink_recommendation_refills AS refill
           ON (refill.organization_id,refill.workspace_id,
               refill.website_project_id,refill.job_id)=(
                job.organization_id,job.workspace_id,
                job.website_project_id,job.id
              )
          AND refill.recommendation_context_version_id=$4::uuid
          AND refill.visible_pool_generation=$5
        WHERE (job.organization_id,job.workspace_id,
               job.website_project_id,job.id)=(
                $1::uuid,$2::uuid,$3::uuid,$7::uuid
              )
          AND job.job_type='recommendation_refill'
          AND job.source_object_type='recommendation_context'
          AND job.source_object_id=$4::uuid
        FOR UPDATE OF job,refill
     ),
     locked_requests AS MATERIALIZED (
       SELECT request.*
         FROM provider_batch_requests AS request
         JOIN locked_batch AS batch
           ON (request.organization_id,request.workspace_id,
               request.website_project_id)=(
                batch.organization_id,batch.workspace_id,
                batch.website_project_id
              )
          AND request.request_id LIKE
              regexp_replace(
                batch.idempotency_key,
                '^commercial-discovery:',
                ''
              )||':%'
        FOR UPDATE OF request
     ),
     locked_provider_requests AS MATERIALIZED (
       SELECT provider_request.*
         FROM backlink_provider_requests AS provider_request
         JOIN locked_requests AS request
           ON (provider_request.organization_id,
               provider_request.workspace_id,
               provider_request.website_project_id,
               provider_request.id)=(
                request.organization_id,request.workspace_id,
                request.website_project_id,request.id
              )
        FOR UPDATE OF provider_request
     ),
     locked_usage AS MATERIALIZED (
       SELECT usage.*
         FROM backlink_provider_usage_ledger AS usage
         JOIN locked_requests AS request
           ON (usage.organization_id,usage.workspace_id,
               usage.website_project_id,usage.provider_request_id)=(
                request.organization_id,request.workspace_id,
                request.website_project_id,request.id
              )
          AND usage.provider='dataforseo'
          AND usage.reservation_key=request.budget_reservation_id
        FOR UPDATE OF usage
     ),
     locked_leases AS MATERIALIZED (
       SELECT lease.*
         FROM provider_fetch_leases AS lease
         JOIN locked_requests AS request
           ON lease.artifact_fingerprint=request.normalized_request_hash
          AND lease.owner_request_id=request.request_id
        FOR UPDATE OF lease
     ),
     safety AS MATERIALIZED (
       SELECT NOT EXISTS (
                SELECT 1 FROM locked_requests
                 WHERE status IN ('running','unknown_charge')
              )
              AND NOT EXISTS (
                SELECT 1 FROM locked_provider_requests
                 WHERE status IN ('running','unknown_charge')
              )
              AND NOT EXISTS (
                SELECT 1 FROM locked_usage WHERE status='reserved'
              )
              AND NOT EXISTS (
                SELECT 1 FROM locked_leases
                 WHERE status IN ('acquired','unknown_charge')
              ) AS safe_to_resume
     ),
     authority AS MATERIALIZED (
       SELECT batch.id AS batch_id,
              batch.refill_job_id AS old_job_id,
              old_owner.refill_id AS old_refill_id,
              new_owner.refill_id AS new_refill_id,
              new_owner.version AS new_job_version,
              new_owner.correlation_id,
              (
                batch.refill_job_id=$7::uuid
                AND (
                  safety.safe_to_resume
                  OR $20::boolean
                )
              ) AS same_owner,
              (
                batch.refill_job_id<>$7::uuid
                AND batch.status='paused'
                AND old_owner.status IN ('partial_success','cancelled')
                AND new_owner.status IN ('queued','running','waiting_provider')
                AND safety.safe_to_resume
              ) AS claimable
         FROM locked_batch AS batch
         JOIN old_owner ON true
         JOIN new_owner ON true
         CROSS JOIN safety
         JOIN backlink_project_context_snapshots AS context
           ON (context.organization_id,context.workspace_id,
               context.website_project_id,context.id)=(
                batch.organization_id,batch.workspace_id,
                batch.website_project_id,$4::uuid
              )
          AND context.snapshot_version=$8
          AND context.profile_version_id=$9
          AND context.promotion_target_version_id=$10
         JOIN backlink_generation_input_pins AS pin
           ON (pin.organization_id,pin.workspace_id,
               pin.website_project_id,pin.id)=(
                batch.organization_id,batch.workspace_id,
                batch.website_project_id,$11::uuid
              )
          AND pin.project_context_version=$8
          AND pin.site_profile_version_id=$9
          AND pin.promotion_target_version_id=$10
          AND pin.immutable_fingerprint=$12
        WHERE (
                batch.status='paused'
                OR (
                  batch.refill_job_id=$7::uuid
                  AND batch.status='running'
                  AND $20::boolean
                )
              )
          AND new_owner.status IN ('queued','running','waiting_provider')
          AND NOT EXISTS (
            SELECT 1
              FROM backlink_project_context_snapshots AS newer
             WHERE (newer.organization_id,newer.workspace_id,
                    newer.website_project_id)=(
                     batch.organization_id,batch.workspace_id,
                     batch.website_project_id
                   )
               AND newer.snapshot_version>context.snapshot_version
          )
     ),
     lineaged_job AS (
       UPDATE backlink_jobs AS job
          SET result_summary=jsonb_set(
                COALESCE(job.result_summary,'{}'::jsonb),
                '{commercialDiscoveryResume}',
                jsonb_build_object(
                  'resumedFromJobId',authority.old_job_id,
                  'resumedFromBatchId',authority.batch_id,
                  'resumedFromRefillId',authority.old_refill_id,
                  'contextVersionId',$4::uuid,
                  'visiblePoolGeneration',$5,
                  'generationInputPinId',$11::uuid,
                  'generationInputFingerprint',$12,
                  'claimedAt',$14::timestamptz
                ),
                true
              ),
              updated_at=$14,
              updated_by=$13,
              version=job.version+1
         FROM authority
        WHERE job.id=$7::uuid
          AND authority.claimable
          AND NOT COALESCE(
            job.result_summary ? 'commercialDiscoveryResume',
            false
          )
       RETURNING job.id,job.version,job.correlation_id
     ),
     claimed_batch AS (
       UPDATE backlink_commercial_discovery_batches AS batch
          SET refill_job_id=$7::uuid
         FROM authority,lineaged_job
        WHERE batch.id=authority.batch_id
          AND batch.refill_job_id=authority.old_job_id
          AND authority.claimable
       RETURNING batch.id
     ),
     lifecycle AS (
       INSERT INTO backlink_lifecycle_events (
         id,organization_id,workspace_id,website_project_id,job_id,
         aggregate_type,aggregate_id,sequence,aggregate_version,event_type,
         actor_type,actor_id,before_state,after_state,reason,correlation_id,
         idempotency_key,created_at
       )
       SELECT $15,$1,$2,$3,$7,
              'recommendation_refill',authority.new_refill_id,
              lineaged_job.version,lineaged_job.version,
              'recommendation_refill.discovery_batch_resumed',
              'system',$13,
              jsonb_build_object(
                'jobId',authority.old_job_id,
                'batchId',authority.batch_id
              ),
              jsonb_build_object(
                'jobId',$7::uuid,
                'batchId',authority.batch_id,
                'resumedFromJobId',authority.old_job_id,
                'resumedFromBatchId',authority.batch_id
              ),
              'resume_paused_commercial_discovery_batch',
              lineaged_job.correlation_id,$17,$14
         FROM authority,lineaged_job,claimed_batch
       ON CONFLICT (workspace_id,idempotency_key) DO NOTHING
       RETURNING id
     ),
     audit AS (
       INSERT INTO backlink_audit_events (
         id,organization_id,workspace_id,website_project_id,job_id,
         lifecycle_event_id,actor_id,actor_kind,action,target_type,target_id,
         outcome,reason,before_redacted,after_redacted,request_id,
         correlation_id,integrity_hash,created_at
       )
       SELECT $16,$1,$2,$3,$7,lifecycle.id,$13,'system',
              'recommendation_refill.discovery_batch_resumed',
              'commercial_discovery_batch',authority.batch_id,
              'success','resume_paused_commercial_discovery_batch',
              jsonb_build_object('jobId',authority.old_job_id),
              jsonb_build_object(
                'jobId',$7::uuid,
                'resumedFromJobId',authority.old_job_id,
                'resumedFromBatchId',authority.batch_id
              ),
              $18,lineaged_job.correlation_id,$19,$14
         FROM authority,lineaged_job,claimed_batch,lifecycle
       RETURNING id
     )
     SELECT claimed_batch.id,
            'resumed'::text AS disposition
       FROM claimed_batch
     UNION ALL
     SELECT authority.batch_id,
            'same_owner'::text AS disposition
       FROM authority
      WHERE authority.same_owner
     LIMIT 1`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.contextVersionId,
      input.visiblePoolGeneration,
      `commercial-discovery:${input.refillKey}`,
      input.jobId,
      input.inputBinding.pins.projectContextVersion,
      input.inputBinding.pins.siteProfileVersionId,
      input.inputBinding.pins.promotionTargetVersionId,
      input.inputBinding.inputPinId,
      input.inputBinding.immutableFingerprint,
      input.actorId,
      input.claimedAt,
      lifecycleId,
      auditId,
      lineageKey,
      auditRequestId,
      integrityHash,
      input.acceptedProviderRecoveryPending === true,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    const existing = await input.client.query(
      `SELECT id
         FROM backlink_commercial_discovery_batches
        WHERE (organization_id,workspace_id,website_project_id)=
              ($1::uuid,$2::uuid,$3::uuid)
          AND project_context_version_id=$4::uuid
          AND visible_pool_generation=$5
          AND idempotency_key=$6`,
      [
        input.scope.organizationId,
        input.scope.workspaceId,
        input.scope.websiteProjectId,
        input.contextVersionId,
        input.visiblePoolGeneration,
        `commercial-discovery:${input.refillKey}`,
      ],
    );
    if (existing.rows[0] === undefined) return null;
    throw new Error("COMMERCIAL_DISCOVERY_BATCH_TAKEOVER_BLOCKED");
  }
  return Object.freeze({
    batchId: String(row.id),
    disposition:
      row.disposition === "same_owner" ? "same_owner" : "resumed",
  });
}

async function openBatch(
  input: Readonly<{
    client: CommercialDiscoveryQueryClient;
    scope: Scope;
    blueprintId: string;
    contextVersionId: string;
    visiblePoolGeneration: number;
    jobId: string;
    refillKey: string;
    refillTier: CommercialRefillTier;
    refillRound: number;
    actorId: string;
    startedAt: Date;
    allowCompletedReplay: boolean;
  }>,
): Promise<string> {
  const batchId = randomUUID();
  const result = await input.client.query(
    `WITH opened AS (
       INSERT INTO backlink_commercial_discovery_batches (
         id,organization_id,workspace_id,website_project_id,blueprint_id,
         project_context_version_id,visible_pool_generation,refill_job_id,
         status,idempotency_key,request_intent,source_types,refill_tier,
         refill_round,started_at,created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,'running',$9,'DISCOVERY',
         '["EXISTING_HISTORY"]'::jsonb,$10,$11,$12,$13
       )
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         project_context_version_id,idempotency_key
       ) DO UPDATE SET
         status='running',
         pause_reason=NULL,
         finished_at=NULL
       WHERE backlink_commercial_discovery_batches.refill_job_id=
               EXCLUDED.refill_job_id
         AND backlink_commercial_discovery_batches.status
               IN ('paused','running')
       RETURNING id
     ),
     completed_replay AS (
       SELECT batch.id
         FROM backlink_commercial_discovery_batches AS batch
        WHERE (batch.organization_id,batch.workspace_id,
               batch.website_project_id)=($2::uuid,$3::uuid,$4::uuid)
          AND batch.blueprint_id=$5::uuid
          AND batch.project_context_version_id=$6::uuid
          AND batch.visible_pool_generation=$7
          AND batch.refill_job_id=$8::uuid
          AND batch.idempotency_key=$9
          AND batch.status='completed'
          AND $14::boolean
     )
     SELECT id FROM opened
     UNION ALL
     SELECT id FROM completed_replay
      WHERE NOT EXISTS (SELECT 1 FROM opened)
     LIMIT 1`,
    [
      batchId,
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.blueprintId,
      input.contextVersionId,
      input.visiblePoolGeneration,
      input.jobId,
      `commercial-discovery:${input.refillKey}`,
      input.refillTier,
      input.refillRound,
      input.startedAt,
      input.actorId,
      input.allowCompletedReplay,
    ],
  );
  const storedId = result.rows[0]?.id;
  if (storedId === undefined) {
    throw new Error("COMMERCIAL_DISCOVERY_BATCH_NOT_STORED");
  }
  return String(storedId);
}

type AcceptedProviderRecoveryCall = Readonly<{
  call: CommercialDiscoveryCall;
  requestId: string;
  budgetReservationId: string;
}>;

async function loadAcceptedProviderRecoveryPlan(
  input: Readonly<{
    client: CommercialDiscoveryQueryClient;
    scope: Scope;
    contextVersionId: string;
    visiblePoolGeneration: number;
    jobId: string;
    refillKey: string;
    now: Date;
  }>,
): Promise<readonly AcceptedProviderRecoveryCall[]> {
  const result = await input.client.query(
    `/* DATAFORSEO_ACCEPTED_TASK_RECOVERY_PLAN */
     SELECT batch.endpoint,
            blueprint.id::text AS "blueprintId",
            batch.response_schema_version AS "responseSchemaVersion",
            batch.normalized_request_hash AS "requestFingerprint",
            batch.estimated_cost_micros AS "estimatedCostMicros",
            batch.request_id AS "requestId",
            batch.budget_reservation_id AS "budgetReservationId",
            provider_request.request_payload AS "requestPayload"
       FROM backlink_jobs AS job
       JOIN backlink_recommendation_refills AS refill
         ON (refill.organization_id,refill.workspace_id,
             refill.website_project_id,refill.job_id)=(
              job.organization_id,job.workspace_id,
              job.website_project_id,job.id
            )
        AND refill.recommendation_context_version_id=$4::uuid
        AND refill.visible_pool_generation=$5
        AND refill.refill_window_key=$7
       JOIN provider_batch_requests AS batch
         ON (batch.organization_id,batch.workspace_id,
             batch.website_project_id)=(
              job.organization_id,job.workspace_id,
              job.website_project_id
            )
        AND batch.request_id LIKE $9
       JOIN backlink_provider_requests AS provider_request
         ON (provider_request.organization_id,provider_request.workspace_id,
             provider_request.website_project_id,provider_request.id)=(
              batch.organization_id,batch.workspace_id,
              batch.website_project_id,batch.id
            )
       JOIN backlink_commercial_discovery_blueprints AS blueprint
         ON (blueprint.organization_id,blueprint.workspace_id,
             blueprint.website_project_id)=(
              job.organization_id,job.workspace_id,
              job.website_project_id
            )
        AND blueprint.project_context_version_id=$4::uuid
        AND blueprint.id::text=provider_request.request_payload
              #>>'{__growthosDiscoveryPlannerLineage,blueprintId}'
       JOIN backlink_provider_usage_ledger AS usage
         ON (usage.organization_id,usage.workspace_id,
             usage.website_project_id,usage.provider_request_id)=(
              batch.organization_id,batch.workspace_id,
              batch.website_project_id,batch.id
            )
        AND usage.provider='dataforseo'
        AND usage.reservation_key=batch.budget_reservation_id
        AND usage.status='reserved'
       JOIN provider_fetch_leases AS lease
         ON lease.artifact_fingerprint=batch.normalized_request_hash
        AND lease.owner_request_id=batch.request_id
      WHERE (job.organization_id,job.workspace_id,
             job.website_project_id,job.id)=(
              $1::uuid,$2::uuid,$3::uuid,$6::uuid
            )
        AND job.job_type='recommendation_refill'
        AND job.source_object_type='recommendation_context'
        AND job.source_object_id=$4::uuid
        AND batch.provider='dataforseo'
        AND batch.endpoint='/v3/serp/google/organic/task_post'
        AND batch.budget_reservation_id LIKE $10
        AND batch.created_at>=job.created_at
        AND provider_request.request_payload
              #>>'{__growthosDiscoveryPlannerLineage,queryId}'
              ~ '^[0-9a-f]{64}$'
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_commercial_discovery_batches AS conflicting
           WHERE (conflicting.organization_id,conflicting.workspace_id,
                  conflicting.website_project_id)=(
                   job.organization_id,job.workspace_id,
                   job.website_project_id
                 )
             AND conflicting.project_context_version_id=$4::uuid
             AND conflicting.visible_pool_generation=$5
             AND conflicting.idempotency_key=
                   'commercial-discovery:'||$7
             AND conflicting.refill_job_id<>job.id
        )
        AND (
          (
            batch.status='running'
            AND provider_request.status='running'
            AND lease.status='acquired'
            AND lease.lease_expires_at<=$8
          )
          OR (
            batch.status='unknown_charge'
            AND provider_request.status='unknown_charge'
            AND lease.status='unknown_charge'
          )
        )
      ORDER BY batch.request_id`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.contextVersionId,
      input.visiblePoolGeneration,
      input.jobId,
      input.refillKey,
      input.now,
      `${input.refillKey}:%`,
      `commercial-refill-operation:${input.jobId}:discovery:`
        + `${input.refillKey}:%`,
    ],
  );
  return Object.freeze(result.rows.map((row) => {
    const persistedRequest = parseCommercialDiscoveryRequestPayload(
      row.requestPayload,
    );
    const sourceTypes = ["BLUEPRINT_SERP_STANDARD_QUEUE"] as const;
    const matchingCalls = sourceTypes.flatMap((sourceType) => {
      try {
        const call = commercialDiscoveryCallSchema.parse({
          endpoint: row.endpoint,
          intent: "DISCOVERY",
          sourceType,
          request: persistedRequest.request,
          ...(persistedRequest.plannerLineage === undefined
            ? {}
            : { plannerLineage: persistedRequest.plannerLineage }),
          responseSchemaVersion: row.responseSchemaVersion,
          estimatedCostMicros: Number(row.estimatedCostMicros),
        });
        return fingerprintCommercialDiscoveryCall(call)
          === String(row.requestFingerprint)
          ? [call]
          : [];
      } catch {
        return [];
      }
    });
    if (matchingCalls.length !== 1) {
      throw new Error("DATAFORSEO_ACCEPTED_TASK_RECOVERY_CALL_MISMATCH");
    }
    const call = matchingCalls[0];
    if (call === undefined) {
      throw new Error("DATAFORSEO_ACCEPTED_TASK_RECOVERY_CALL_MISMATCH");
    }
    if (call.plannerLineage === undefined) {
      throw new Error("DATAFORSEO_SEMANTIC_LINEAGE_REQUIRED");
    }
    if (call.plannerLineage.blueprintId !== String(row.blueprintId ?? "")) {
      throw new Error("DATAFORSEO_ACCEPTED_TASK_RECOVERY_BLUEPRINT_MISMATCH");
    }
    const requestId = String(row.requestId ?? "").trim();
    const budgetReservationId =
      String(row.budgetReservationId ?? "").trim();
    if (requestId === "" || budgetReservationId === "") {
      throw new Error("DATAFORSEO_ACCEPTED_TASK_RECOVERY_CONTEXT_INVALID");
    }
    return Object.freeze({
      call,
      requestId,
      budgetReservationId,
    });
  }));
}

function providerSource(
  sources: readonly ("cache" | "stale-cache" | "single-flight" | "provider")[],
): "cache" | "stale-cache" | "single-flight" | "provider" {
  if (sources.includes("provider")) return "provider";
  if (sources.includes("single-flight")) return "single-flight";
  if (sources.includes("stale-cache")) return "stale-cache";
  return "cache";
}

function candidateState(
  decision: CommercialFitDecision["decision"],
  enrichmentDecision: CommercialCandidateEnrichmentDecision["decision"],
):
  | "enrichment_eligible"
  | "excluded"
  | "insufficient_data"
  | "manual_review" {
  if (enrichmentDecision === "enrichment_eligible") {
    return "enrichment_eligible";
  }
  if (enrichmentDecision === "not_selected") {
    return "insufficient_data";
  }
  if (enrichmentDecision === "excluded" || decision === "ineligible") {
    return "excluded";
  }
  return decision === "eligible" ? "insufficient_data" : decision;
}

function uniqueQueries(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return Object.freeze(values.map((value) => value.trim()).filter((value) => {
    if (!value) return false;
    const normalized = value.toLocaleLowerCase().replace(/\s+/gu, " ");
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }));
}

function discoveryLanguageInputRequired(languageCode: string): Error {
  return new Error(
    "WEBSITE_PROJECT_DISCOVERY_LANGUAGE_INPUT_REQUIRED "
      + "owner=WEBSITE_PROJECT "
      + "recovery=add_target_language_keyword_or_content_topic "
      + `reason=no_target_language_semantic_seed:${languageCode}`,
  );
}

function commercialRefillPageIndex(round: number, window: number): number {
  const roundIndex = Math.max(0, Math.floor(round) - 1);
  const windowIndex = Math.max(0, Math.floor(window) - 1);
  const diagonal = roundIndex + windowIndex;
  return diagonal * (diagonal + 1) / 2 + roundIndex;
}

function discoveryMarketName(
  countryCode: string,
  languageCode: string,
): string {
  try {
    return new Intl.DisplayNames(
      [languageCode || "en"],
      { type: "region" },
    ).of(countryCode.toUpperCase())?.trim() || countryCode.toUpperCase();
  } catch {
    return countryCode.toUpperCase();
  }
}

function removeDiscoveryProjectBrand(
  value: string,
  canonicalDomain: string,
): string {
  const brand = canonicalDomain.trim().toLowerCase().split(".")[0] ?? "";
  if (brand.length < 3) return value.trim();
  const escaped = brand.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return value
    .replace(new RegExp(`\\b${escaped}\\b`, "giu"), " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function buildCommercialTierSearchQueries(
  input: Readonly<{
    tier: CommercialRefillTier;
    blueprint: CommercialDiscoveryBlueprint;
    context: CommercialRecommendationContext;
    refillRound: number;
    refillWindow: number;
    languageCode: string;
    queryOffset?: number;
    queryLimit?: number;
    includeDeterministicExpansion?: boolean;
  }>,
): readonly string[] {
  if (input.tier === "curated_resource_library") {
    return Object.freeze([]);
  }
  if (input.blueprint.inputReadiness !== "READY") {
    throw discoveryLanguageInputRequired(input.languageCode);
  }
  const market = discoveryMarketName(
    input.context.countryCode,
    input.languageCode,
  );
  const normalize = (value: string) =>
    value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
  const forbiddenGoals = new Set(
    extractTargetLanguageSearchPhrases(
      input.context.partnershipGoals,
      input.languageCode,
    ).map(normalize),
  );
  const canonicalDomain = normalize(input.context.canonicalDomain);
  const projectBrand = canonicalDomain.split(".")[0] ?? "";
  const phrases = (values: readonly string[], limit: number) =>
    extractTargetLanguageSearchPhrases(values, input.languageCode)
      .map((value) =>
        removeDiscoveryProjectBrand(value, input.context.canonicalDomain)
      )
      .filter((value) => {
        const normalized = normalize(value);
        return normalized.length > 0
          && ![...forbiddenGoals].some((goal) =>
            normalized.includes(goal)
          )
          && !normalized.includes(canonicalDomain)
          && (projectBrand.length < 3
            || !normalized.includes(projectBrand));
      })
      .slice(0, limit);
  const products = phrases(input.context.products, 4);
  const keywords = phrases(input.context.keywords, 4);
  const topics = phrases(input.blueprint.topicClusters, 6);
  const audiences = phrases(input.context.targetAudiences, 4);
  const competitors = phrases(
    [
      ...input.context.explicitCompetitorDomains,
      ...input.blueprint.discoveredCompetitorSeeds,
    ],
    4,
  );
  const blueprintQueries = phrases(
    input.blueprint.searchQueryClusters,
    20,
  );
  const targetMarketScoped = input.tier !== "same_language_expansion";
  const subjectBuckets =
    input.tier === "exact_product_target_market"
      ? [keywords, products, topics, competitors, audiences]
      : input.tier === "same_topic_target_market"
        ? [topics, keywords, products, competitors, audiences]
        : input.tier === "adjacent_industry_same_audience"
          ? [audiences, topics, products, keywords, competitors]
          : input.tier === "resource_media_review_partner_ecosystem"
            ? [products, topics, keywords, competitors, audiences]
            : [topics, keywords, products, competitors, audiences];
  const interleavedSubjects: string[] = [];
  const maximumBucketLength = Math.max(
    0,
    ...subjectBuckets.map((bucket) => bucket.length),
  );
  for (let index = 0; index < maximumBucketLength; index += 1) {
    for (const bucket of subjectBuckets) {
      const subject = bucket[index];
      if (subject !== undefined) interleavedSubjects.push(subject);
    }
  }
  const subjects = uniqueQueries(interleavedSubjects).slice(0, 6);
  if (subjects.length === 0 && blueprintQueries.length === 0) {
    throw discoveryLanguageInputRequired(input.languageCode);
  }
  const scopeQuery = (value: string) => {
    if (!targetMarketScoped) return value;
    const normalized = normalize(value);
    return normalized.includes(normalize(market))
        || normalized.includes(normalize(input.context.countryCode))
      ? value
      : `${value} ${market}`;
  };
  const query = (...parts: readonly string[]) =>
    parts.map((part) => part.trim()).filter(Boolean).join(" ");
  const patterns = input.tier === "adjacent_industry_same_audience"
    ? [
        "consumer technology blogs",
        "telecom publications",
        "digital lifestyle websites",
        "adjacent industry publications",
        "\"write for us\"",
        "\"media kit\"",
      ]
    : input.tier === "resource_media_review_partner_ecosystem"
      ? [
          "\"submit a resource\"",
          "useful links",
          "resource directory",
          "\"media kit\"",
          "review publications",
          "partner publications",
        ]
      : [
          "blogs",
          "publications",
          "review websites",
          "\"write for us\"",
          "\"contribute\"",
          "\"advertise with us\"",
          "\"media kit\"",
          "\"submit a resource\"",
          "useful links",
          "resource directory",
        ];
  const generatedQueries = patterns.flatMap((pattern) =>
    subjects.map((subject) =>
      query(
        targetMarketScoped ? market : "",
        subject,
        pattern,
      )
    )
  );
  const plannedQueries = input.blueprint.generator === "AI"
      && input.includeDeterministicExpansion !== true
    ? blueprintQueries
    : uniqueQueries([
        ...blueprintQueries.map(scopeQuery),
        ...generatedQueries,
      ]);
  const allQueries = extractTargetLanguageSearchPhrases(
    plannedQueries,
    input.languageCode,
  ).filter((value) => {
    const normalized = normalize(value);
    return ![...forbiddenGoals].some((goal) => normalized.includes(goal))
      && !normalized.includes(canonicalDomain)
      && (projectBrand.length < 3
        || !normalized.includes(projectBrand));
  });
  const pageIndex = commercialRefillPageIndex(
    input.refillRound,
    input.refillWindow,
  );
  const queryOffset = input.queryOffset ?? pageIndex * 6;
  const queryLimit = input.queryLimit ?? 6;
  if (
    !Number.isSafeInteger(queryOffset)
    || queryOffset < 0
    || !Number.isSafeInteger(queryLimit)
    || queryLimit < 1
    || queryLimit > commercialDiscoverySemanticPlanningQueryLimit
  ) {
    throw new TypeError("Commercial discovery query window is invalid.");
  }
  return Object.freeze(
    allQueries.slice(queryOffset, queryOffset + queryLimit),
  );
}

async function loadProjectAuthority(
  input: Readonly<{
    client: CommercialDiscoveryQueryClient;
    scope: Scope;
  }>,
): Promise<ReturnType<typeof calculateProjectAuthority>> {
  const authorityResult = await input.client.query(
    `SELECT referring_domains "referringDomains"
       FROM backlink_profile_snapshots
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND completeness<>'unavailable'
      ORDER BY observed_at DESC,id DESC
      LIMIT 1`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
    ],
  );
  const referringDomainsValue = authorityResult.rows[0]?.referringDomains;
  const referringDomains =
    referringDomainsValue === null || referringDomainsValue === undefined
      ? null
      : Number(referringDomainsValue);
  return calculateProjectAuthority(
    referringDomains !== null && Number.isFinite(referringDomains)
      ? referringDomains
      : null,
  );
}

async function loadCuratedResourceLibraryArtifact(
  input: Readonly<{
    client: CommercialDiscoveryQueryClient;
    scope: Scope;
    blueprint: CommercialDiscoveryBlueprint;
    requestedCount: number;
    candidateLimit: number;
    refillRound: number;
    refillWindow: number;
    collectedAt: string;
  }>,
): Promise<CommercialDiscoveryArtifact> {
  const projectAuthority = await loadProjectAuthority(input);
  const limit = Math.min(
    input.candidateLimit,
    Math.max(10, input.requestedCount * 4),
  );
  const windowOffset =
    commercialRefillPageIndex(input.refillRound, input.refillWindow) * limit;
  const result = await input.client.query(
    `SELECT resource_key "resourceKey",
            canonical_domain "canonicalDomain",
            resource_type "resourceType",
            categories,tags,authority_score "authorityScore",
            risk_level "riskLevel",recommendation,
            dataforseo_rank rank,
            monthly_organic_traffic traffic,
            backlinks "backlinkCount",
            referring_domains "referringDomainCount",
            spam_score "spamScore",
            country_language "countryLanguage",
            source_bundle_sha256 "sourceBundleSha256",
            source_generated_at "sourceGeneratedAt"
       FROM backlink_resource_library_items
      WHERE organization_id=$1 AND workspace_id=$2
        AND active=true
        AND quality_bucket IN ('recommend','review')
        AND quality_reviewed=true
      ORDER BY canonical_domain`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
    ],
  );
  const stringArray = (value: unknown): readonly string[] =>
    Array.isArray(value)
      ? Object.freeze(
          value.flatMap((item) =>
            typeof item === "string" && item.trim().length > 0
              ? [item.trim()]
              : [],
          ),
        )
      : Object.freeze([]);
  const scored = result.rows
    .map((row) => {
      const resourceType = row.resourceType === "paid" ? "paid" : "free";
      const match = scoreCuratedResourceForProject({
        resource: {
          categories: stringArray(row.categories),
          tags: stringArray(row.tags),
          countryLanguage:
            row.countryLanguage === null || row.countryLanguage === undefined
              ? null
              : String(row.countryLanguage),
          resourceType,
          authorityScore: Number(row.authorityScore ?? 0),
          riskLevel:
            row.riskLevel === null || row.riskLevel === undefined
              ? null
              : String(row.riskLevel),
        },
        blueprint: input.blueprint,
        minimumAuthorityScore: projectAuthority.minimumResourceAuthorityScore,
      });
      return Object.freeze({ row, resourceType, match });
    })
    .filter(({ match }) => match.eligible)
    .sort(
      (left, right) =>
        right.match.score - left.match.score ||
        Number(right.row.authorityScore ?? 0) -
          Number(left.row.authorityScore ?? 0) ||
        String(left.row.canonicalDomain).localeCompare(
          String(right.row.canonicalDomain),
        ),
    )
    .slice(windowOffset, windowOffset + limit);
  const keys = scored.map(({ row }) => String(row.resourceKey));
  return Object.freeze({
    sourceType: "CURATED_RESOURCE_LIBRARY",
    endpoint: null,
    requestFingerprint: aggregateHash([
      `resource-library:${input.blueprint.inputSummary.fingerprint}`,
      `minimum-authority:${projectAuthority.minimumResourceAuthorityScore}`,
      ...keys,
    ]),
    responseSchemaVersion: "growthos.resource-library-commercial.v1",
    collectedAt: input.collectedAt,
    costMicros: 0,
    providerTaskIds: Object.freeze([]),
    candidates: Object.freeze(
      scored.map(({ row, resourceType, match }) => {
        const numberOrNull = (value: unknown): number | null => {
          if (value === null || value === undefined || value === "")
            return null;
          const parsed = Number(value);
          return Number.isFinite(parsed) ? parsed : null;
        };
        const countryLanguage =
          row.countryLanguage === null || row.countryLanguage === undefined
            ? null
            : String(row.countryLanguage);
        const countryCode =
          countryLanguage?.match(/\b[A-Z]{2}\b/u)?.[0] ?? null;
        return Object.freeze({
          canonicalDomain: String(row.canonicalDomain),
          discoveryUrls: Object.freeze([]),
          backlinkPageEvidence: Object.freeze([]),
          rank: numberOrNull(row.rank),
          traffic: numberOrNull(row.traffic),
          backlinkCount: numberOrNull(row.backlinkCount),
          referringDomainCount: numberOrNull(row.referringDomainCount),
          spamScore: numberOrNull(row.spamScore),
          countryCode,
          evidenceRefs: Object.freeze([
            `resource-library:${String(row.resourceKey)}:${String(
              row.sourceBundleSha256,
            )}`,
            `resource-type:${resourceType}`,
            `project-match:${match.score}:${match.matchedTerms.join(",")}`,
          ]),
        });
      }),
    ),
  });
}

function eliminationReasonCounts(
  evaluated: readonly CommercialReadyCandidate[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const candidate of evaluated) {
    if (candidate.commercialScore.decision === "eligible") continue;
    const reasons =
      candidate.commercialScore.hitGates.length > 0
        ? candidate.commercialScore.hitGates
        : candidate.commercialScore.missingEvidence.length > 0
          ? candidate.commercialScore.missingEvidence
          : [candidate.commercialScore.decision.toUpperCase()];
    for (const reason of reasons) counts[reason] = (counts[reason] ?? 0) + 1;
  }
  return Object.freeze(counts);
}

type CommercialRecommendationDiscoveryInput = Readonly<{
    client: CommercialDiscoveryQueryClient;
    provider: CommercialDataForSeoRuntime;
    gate: DataForSeoCallGate;
    safeFetch: Pick<SafeFetchPort, "fetch">;
    browserFetch?: Pick<SafeFetchPort, "fetch">;
    scope: Scope;
    contextVersionId: string;
    context: CommercialRecommendationContext;
    inputBinding: GenerationInputBinding;
    configuration: CommercialRecommendationDiscoveryConfiguration;
    blueprintGenerator?: AiCommercialDiscoveryBlueprintPort | undefined;
    sharedEvidence?: CommercialDiscoveryEvidenceReusePort | undefined;
    requestClientFactory?:
      | (() => Promise<CommercialDiscoveryRequestClientLease>)
      | undefined;
    providerBudgetOperationPrefix?: string | undefined;
    nativeV2?: CommercialRecommendationNativeV2RequestPort | undefined;
    requestedCount: number;
    jobId: string;
    visiblePoolGeneration: number;
    refillTier: CommercialRefillTier;
    refillRound: number;
    refillWindow?: number | undefined;
    actorId: string;
    now(): Date;
  }>;

export function executeCommercialRecommendationDiscovery(
  input: CommercialRecommendationDiscoveryInput &
    Readonly<{ nativeV2: CommercialRecommendationNativeV2RequestPort }>,
): Promise<CommercialRecommendationNativeV2DiscoveryResult>;
export function executeCommercialRecommendationDiscovery(
  input: CommercialRecommendationDiscoveryInput &
    Readonly<{ nativeV2?: undefined }>,
): Promise<CommercialRecommendationDiscoveryResult>;
export function executeCommercialRecommendationDiscovery(
  input: CommercialRecommendationDiscoveryInput,
): Promise<
  | CommercialRecommendationDiscoveryResult
  | CommercialRecommendationNativeV2DiscoveryResult
>;
export async function executeCommercialRecommendationDiscovery(
  input: CommercialRecommendationDiscoveryInput,
): Promise<
  | CommercialRecommendationDiscoveryResult
  | CommercialRecommendationNativeV2DiscoveryResult
> {
  const startedAt = input.now();
  const providerBudgetOperationPrefix = (
    input.providerBudgetOperationPrefix
    ?? `commercial-refill-operation:${input.jobId}`
  ).trim().replace(/:+$/u, "");
  if (providerBudgetOperationPrefix.length === 0) {
    throw new TypeError(
      "Commercial discovery provider budget operation prefix is required.",
    );
  }
  if (
    input.nativeV2 !== undefined &&
    (!nativeV2BlueprintIdPattern.test(
      input.nativeV2.authoritativeBlueprintId.trim(),
    ) ||
      !Number.isSafeInteger(input.nativeV2.maxRequests) ||
      input.nativeV2.maxRequests < 1 ||
      input.nativeV2.maxRequests > commercialSemanticDiscoveryPaidCallReserve ||
      !Number.isSafeInteger(input.nativeV2.maxAuthorizedCostMicros) ||
      input.nativeV2.maxAuthorizedCostMicros < 0 ||
      input.nativeV2.maxAuthorizedCostMicros >
        recommendationDiscoveryRoundBudgetMicros ||
      (input.nativeV2.requestOffset !== undefined &&
        (!Number.isSafeInteger(input.nativeV2.requestOffset) ||
          input.nativeV2.requestOffset < 0)))
  ) {
    throw new TypeError(
      "Recommendation V2 native discovery request limit is invalid.",
    );
  }
  const authorizedSources = new Set(
    input.inputBinding.outreachProfile.authorizedDiscoverySources,
  );
  const requiredSource = input.refillTier === "curated_resource_library"
    ? "CURATED_RESOURCE_LIBRARY"
    : "WEBSITE_PROJECT";
  if (!authorizedSources.has(requiredSource)) {
    throw new Error(
      `WEBSITE_PROJECT_DISCOVERY_INPUT_REQUIRED owner=WEBSITE_PROJECT recovery=reproject_current_website_project reason=source_not_authorized:${requiredSource}`,
    );
  }
  if (input.nativeV2 === undefined) {
    const activePool = await input.client.query(
      `SELECT visible_pool_generation AS "visiblePoolGeneration"
         FROM backlink_commercial_inventory_policies AS policy
        WHERE policy.organization_id=$1 AND policy.workspace_id=$2
          AND policy.website_project_id=$3
          AND policy.project_context_version_id=$4
          AND policy.visible_pool_generation=$5
          AND ${currentV4VisiblePoolPredicate}
        FOR SHARE`,
      [
        input.scope.organizationId,
        input.scope.workspaceId,
        input.scope.websiteProjectId,
        input.contextVersionId,
        input.visiblePoolGeneration,
      ],
    );
    if (activePool.rows[0] === undefined) {
      throw new Error("COMMERCIAL_VISIBLE_POOL_GENERATION_STALE");
    }
  }
  const refillKey = buildCommercialRefillWindowKey({
    websiteProjectId: input.scope.websiteProjectId,
    projectContextVersionId: input.contextVersionId,
    visiblePoolGeneration: input.visiblePoolGeneration,
    tier: input.refillTier,
    round: input.refillRound,
    window: input.refillWindow,
  });
  const history = await loadHistory(
    input.client,
    input.scope,
    input.contextVersionId,
    input.context,
    input.nativeV2 !== undefined,
  );
  const curatedResourceLibrary =
    input.refillTier === "curated_resource_library";
  const artifacts: CommercialDiscoveryArtifact[] = [];
  const nativeRequestResults: CommercialRecommendationNativeV2RequestResult[] =
    [];
  const sources: ("cache" | "stale-cache" | "single-flight" | "provider")[] =
    [];
  let paidCostMicros = 0;
  let blueprint: CommercialDiscoveryBlueprint;
  let blueprintId: string;
  let acceptedRecoveryPlan =
    Object.freeze([]) as readonly AcceptedProviderRecoveryCall[];
  let pauseReason: string | null = null;
  let failureStatus: "paused" | "unavailable" | null = null;
  let semanticRequiredCallCount = 0;
  let semanticCompletedCallCount = 0;
  let requiredSemanticQueryIds = new Set<string>();
  let stoppedByNativePolicy = false;
  let batchId = "";
  const lockKey = [
    input.scope.organizationId,
    input.scope.workspaceId,
    input.scope.websiteProjectId,
    input.contextVersionId,
    `g${input.visiblePoolGeneration}`,
    `blueprint-v${commercialDiscoveryBlueprintVersion}`,
  ].join(":");
  await input.client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
    lockKey,
  ]);
  try {
    const cached = await loadBlueprint({
      client: input.client,
      scope: input.scope,
      contextVersionId: input.contextVersionId,
      projectSettingsVersionId: input.context.projectSettingsVersionId,
    });
    let generatedContext: CommercialDiscoveryBlueprintContext | null = null;
    let aiOutput: unknown;
    let aiModel: CommercialDiscoveryAiModel | undefined;
    let aiGeneration: CommercialDiscoveryAiGeneration | undefined;
    let fallbackReason =
      input.blueprintGenerator === undefined ? "AI_NOT_CONFIGURED" : undefined;
    if (cached !== null) {
      blueprint = cached.blueprint;
      blueprintId = cached.id;
    } else {
      const evidenceRefs = await collectBlueprintEvidence({
        contextVersionId: input.contextVersionId,
        context: input.context,
        inputBinding: input.inputBinding,
      });
      generatedContext = blueprintContext({
        contextVersionId: input.contextVersionId,
        context: input.context,
        configuration: input.configuration,
        evidenceRefs,
        historicalFeedbackDomains: [...history.previouslyExcludedDomains],
      });
      const inputReadiness =
        assessCommercialDiscoveryInputReadiness(generatedContext);
      if (
        input.blueprintGenerator !== undefined
        && inputReadiness === "READY"
      ) {
        try {
          const generated = await input.blueprintGenerator.generate({
            ...input.scope,
            context: generatedContext,
          });
          aiOutput = generated.output;
          aiModel = generated.model;
          aiGeneration = generated.generation;
        } catch {
          aiOutput = undefined;
          aiModel = undefined;
          aiGeneration = undefined;
          fallbackReason = "AI_PROVIDER_UNAVAILABLE";
        }
      } else if (inputReadiness !== "READY") {
        fallbackReason = "PROJECT_EVIDENCE_REFRESH_REQUIRED";
      }
      blueprint = buildCommercialDiscoveryBlueprint({
        context: generatedContext,
        aiOutput,
        aiModel,
        aiGeneration,
        fallbackReason,
      });
      blueprintId = "";
    }
    if (!curatedResourceLibrary && input.nativeV2 === undefined) {
      acceptedRecoveryPlan = await loadAcceptedProviderRecoveryPlan({
        client: input.client,
        scope: input.scope,
        contextVersionId: input.contextVersionId,
        visiblePoolGeneration: input.visiblePoolGeneration,
        jobId: input.jobId,
        refillKey,
        now: startedAt,
      });
    }
    if (input.nativeV2 === undefined) {
      const claimedBatch = await claimPausedCommercialDiscoveryBatch({
        client: input.client,
        scope: input.scope,
        contextVersionId: input.contextVersionId,
        visiblePoolGeneration: input.visiblePoolGeneration,
        jobId: input.jobId,
        refillKey,
        inputBinding: input.inputBinding,
        actorId: input.actorId,
        claimedAt: startedAt,
        acceptedProviderRecoveryPending: acceptedRecoveryPlan.length > 0,
      });
      if (claimedBatch !== null) {
        batchId = claimedBatch.batchId;
      }
    }
    const persistGeneratedBlueprintWithObservedEvidence = async () => {
      if (generatedContext === null || blueprintId !== "") return;
      const competitorEvidence = artifacts.filter(
        ({ sourceType }) => sourceType === "VERIFIED_COMPETITOR_BACKLINK_GAP",
      );
      blueprint = buildCommercialDiscoveryBlueprint({
        context: generatedContext,
        aiOutput,
        aiModel,
        aiGeneration,
        fallbackReason,
        observedCompetitorDomains: competitorEvidence.flatMap(
          ({ candidates }) =>
            candidates.map(({ canonicalDomain }) => canonicalDomain),
        ),
        additionalEvidenceRefs: competitorEvidence.flatMap((artifact) => [
          `dataforseo-artifact:${artifact.requestFingerprint}`,
          ...artifact.candidates.flatMap(({ evidenceRefs }) => evidenceRefs),
        ]),
      });
      blueprintId = await persistBlueprint({
        client: input.client,
        scope: input.scope,
        contextVersionId: input.contextVersionId,
        blueprint,
        actorId: input.actorId,
        generatedAt: startedAt,
      });
    };
    const ensureBatchOpen = async () => {
      if (batchId.length > 0) return;
      await persistGeneratedBlueprintWithObservedEvidence();
      if (input.nativeV2 !== undefined) return;
      if (input.nativeV2 === undefined) {
        const activePolicy = await input.client.query(
          `UPDATE backlink_commercial_inventory_policies AS policy
              SET updated_at=now(),updated_by=$6
            WHERE policy.organization_id=$1 AND policy.workspace_id=$2
              AND policy.website_project_id=$3
              AND policy.project_context_version_id=$4
              AND policy.visible_pool_generation=$5
              AND ${currentV4VisiblePoolPredicate}
            RETURNING visible_pool_generation`,
          [
            input.scope.organizationId,
            input.scope.workspaceId,
            input.scope.websiteProjectId,
            input.contextVersionId,
            input.visiblePoolGeneration,
            input.actorId,
          ],
        );
        if (activePolicy.rows[0] === undefined) {
          throw new Error("COMMERCIAL_VISIBLE_POOL_GENERATION_STALE");
        }
      }
      batchId = await openBatch({
        client: input.client,
        scope: input.scope,
        blueprintId,
        contextVersionId: input.contextVersionId,
        visiblePoolGeneration: input.visiblePoolGeneration,
        jobId: input.jobId,
        refillKey,
        refillTier: input.refillTier,
        refillRound: input.refillRound,
        actorId: input.actorId,
        startedAt,
        allowCompletedReplay: input.nativeV2 !== undefined,
      });
    };
    if (curatedResourceLibrary) {
      artifacts.push(
        await loadCuratedResourceLibraryArtifact({
          client: input.client,
          scope: input.scope,
          blueprint,
          requestedCount: input.requestedCount,
          candidateLimit: input.configuration.candidateLimit,
          refillRound: input.refillRound,
          refillWindow: input.refillWindow ?? 1,
          collectedAt: startedAt.toISOString(),
        }),
      );
      sources.push("cache");
    } else {
      const configuredConcurrency =
        input.configuration.providerRequestConcurrency
        ?? defaultProviderRequestConcurrency;
      if (
        !Number.isSafeInteger(configuredConcurrency)
        || configuredConcurrency < 1
        || configuredConcurrency > maximumProviderRequestConcurrency
      ) {
        throw new TypeError(
          "Commercial discovery provider concurrency must be between 1 and 4.",
        );
      }
      const concurrency =
        input.requestClientFactory === undefined ? 1 : configuredConcurrency;
      let nextPlanIndex = 0;
      const executePlan = async (
        calls: readonly CommercialDiscoveryCall[],
        recoveryPlan: readonly AcceptedProviderRecoveryCall[],
      ): Promise<boolean> => {
        const indexedPlan: Array<Readonly<{
          call: CommercialDiscoveryCall;
          index: number;
          recovery: AcceptedProviderRecoveryCall | null;
        }>> = [];
        for (const [localIndex, call] of calls.entries()) {
          const index = nextPlanIndex;
          nextPlanIndex += 1;
          const recovery = recoveryPlan[localIndex] ?? null;
          if (recovery !== null) {
            indexedPlan.push({ call, index, recovery });
            continue;
          }
          const reusable =
            input.nativeV2 !== undefined
              || input.sharedEvidence === undefined
              ? null
              : await input.sharedEvidence.readReusable(call);
          if (reusable === null) {
            indexedPlan.push({ call, index, recovery: null });
          } else {
            artifacts.push(reusable);
            sources.push("cache");
          }
        }
        for (
          let offset = 0;
          offset < indexedPlan.length;
          offset += concurrency
        ) {
          const group = indexedPlan.slice(offset, offset + concurrency);
          const settled = await Promise.allSettled(
            group.map(async ({ call, index, recovery }) => {
              const lease =
                input.requestClientFactory === undefined
                  ? Object.freeze({
                      client: input.client,
                      gate: input.gate,
                      release: () => undefined,
                    })
                  : await input.requestClientFactory();
              try {
                if (
                  call.sourceType === "BLUEPRINT_SERP_STANDARD_QUEUE"
                  && call.plannerLineage === undefined
                ) {
                  throw new Error("DATAFORSEO_SEMANTIC_LINEAGE_REQUIRED");
                }
                const requestService = new CommercialDiscoveryRequestService({
                  client: lease.client,
                  provider: input.provider,
                  gate: lease.gate ?? input.gate,
                  now: input.now,
                });
                const fingerprint = fingerprintCommercialDiscoveryCall(call);
                const nativeRequest =
                  input.nativeV2 === undefined
                    ? null
                    : await input.nativeV2.prepareRequest({
                        call,
                        index,
                        requestFingerprint: fingerprint,
                      });
                const context: ProviderRequestContext =
                  nativeRequest?.context ?? {
                    ...input.scope,
                    requestId:
                      recovery?.requestId ?? `${refillKey}:${index + 1}`,
                    idempotencyKey:
                      `commercial-discovery:${refillKey}:${fingerprint}`,
                    budgetReservationId:
                      recovery?.budgetReservationId
                      ?? [
                        providerBudgetOperationPrefix,
                        "discovery",
                        refillKey,
                        fingerprint,
                      ].join(":"),
                  };
                const replayed = nativeRequest?.replayResult !== undefined;
                await input.nativeV2?.recordRequestStarted?.({
                  call,
                  index,
                  requestFingerprint: fingerprint,
                  replayed,
                });
                try {
                  const result =
                    nativeRequest?.replayResult
                    ?? await requestService.execute({
                        context,
                        projectContextVersionId: input.contextVersionId,
                        call,
                        locationCode: input.configuration.locationCode,
                        languageCode: input.configuration.languageCode,
                        refreshMode:
                          nativeRequest?.refreshMode ?? "CACHE_PREFERRED",
                        actorId: nativeRequest?.actorId ?? input.actorId,
                        recoveryOnly: recovery !== null,
                        preserveBudgetReservationId:
                          input.nativeV2 !== undefined,
                        allowSucceededRequestReplay:
                          input.nativeV2 !== undefined,
                      });
                  await input.nativeV2?.recordRequestCompleted?.({
                    call,
                    index,
                    requestFingerprint: fingerprint,
                    replayed,
                    status: "SUCCEEDED",
                  });
                  return Object.freeze({
                    call,
                    index,
                    requestFingerprint: fingerprint,
                    result,
                  });
                } catch (error) {
                  await input.nativeV2?.recordRequestCompleted?.({
                    call,
                    index,
                    requestFingerprint: fingerprint,
                    replayed,
                    status: "FAILED",
                  });
                  throw error;
                }
              } finally {
                await lease.release();
              }
            }),
          );
          let firstFailure: unknown;
          let internalFailure: unknown;
          let unknownChargeFailure: unknown;
          for (const [settledIndex, outcome] of settled.entries()) {
            if (outcome.status === "fulfilled") {
              const completed = outcome.value;
              await input.nativeV2?.recordRequestSuccess(completed);
              nativeRequestResults.push(completed);
              artifacts.push(completed.result.artifact);
              sources.push(completed.result.source);
              if (completed.result.source === "provider") {
                paidCostMicros += completed.result.artifact.costMicros;
              }
              continue;
            }
            const failed = group[settledIndex];
            if (failed !== undefined) {
              await input.nativeV2?.recordRequestFailure({
                call: failed.call,
                index: failed.index,
                requestFingerprint:
                  fingerprintCommercialDiscoveryCall(failed.call),
                error: outcome.reason,
              });
            }
            const message =
              outcome.reason instanceof Error
                ? outcome.reason.message
                : "DATAFORSEO_DISCOVERY_UNAVAILABLE";
            if (
              providerRequestStatus(outcome.reason) === "unknown_charge"
              || message.includes("CHARGE_RECONCILIATION")
              || message.includes("unknown_charge")
            ) {
              unknownChargeFailure ??= outcome.reason;
            } else if (isExpectedProviderFailure(outcome.reason)) {
              firstFailure ??= outcome.reason;
            } else {
              internalFailure ??= outcome.reason;
            }
          }
          if (internalFailure !== undefined) {
            throw internalFailure;
          }
          if (unknownChargeFailure !== undefined) {
            await persistGeneratedBlueprintWithObservedEvidence();
            throw unknownChargeFailure;
          }
          if (firstFailure !== undefined) {
            const message =
              firstFailure instanceof Error
                ? firstFailure.message
                : "DATAFORSEO_DISCOVERY_UNAVAILABLE";
            pauseReason = message.slice(0, 255);
            failureStatus =
              firstFailure instanceof Error
                && firstFailure.name === "DataForSeoCallBlockedError"
                ? "paused"
                : "unavailable";
            return false;
          }
          if (
            input.nativeV2?.shouldContinue !== undefined
            && !(await input.nativeV2.shouldContinue())
          ) {
            stoppedByNativePolicy = true;
            return true;
          }
        }
        return true;
      };
      await persistGeneratedBlueprintWithObservedEvidence();
      const searchQueries = buildCommercialTierSearchQueries({
        tier: input.refillTier,
        blueprint,
        context: input.context,
        refillRound: input.refillRound,
        refillWindow: input.refillWindow ?? 1,
        languageCode: input.configuration.languageCode,
        ...(input.nativeV2 === undefined
          ? {}
          : {
              queryOffset: 0,
              queryLimit: commercialDiscoverySemanticPlanningQueryLimit,
              includeDeterministicExpansion: true,
            }),
      });
      const candidatePlan = createCommercialDiscoveryPlan({
        blueprintId:
          input.nativeV2?.authoritativeBlueprintId.trim() ?? blueprintId,
        searchQueries,
        verifiedCompetitorDomains: input.nativeV2 === undefined
          ? blueprint.explicitCompetitorDomains
          : input.nativeV2.verifiedCompetitorDomains ?? [],
        userDomain: input.context.canonicalDomain,
        locationCode: input.configuration.locationCode,
        languageCode: input.configuration.languageCode,
        endpointAllowlist: input.configuration.endpointAllowlist,
        estimatedCostMicros: input.configuration.estimatedCostMicros,
        remainingBudgetMicros: Number.MAX_SAFE_INTEGER,
      });
      const excludedSemanticRequestFingerprints = new Set(
        input.nativeV2?.excludedSemanticRequestFingerprints ?? [],
      );
      const orderedCandidatePlan = input.nativeV2 === undefined
        ? candidatePlan
        : orderCommercialNativeV2DiscoveryCalls(candidatePlan);
      const availableSemanticPlan = orderedCandidatePlan.filter(
        (call) =>
          (call.sourceType === "BLUEPRINT_SERP_STANDARD_QUEUE"
            || (input.nativeV2 !== undefined
              && call.sourceType === "VERIFIED_COMPETITOR_REFERRING_DOMAINS"))
          && !excludedSemanticRequestFingerprints.has(
            fingerprintCommercialDiscoverySemanticRequest(call),
          ),
      );
      const semanticPlan = input.nativeV2 === undefined
        ? availableSemanticPlan.slice(
            0,
            commercialSemanticDiscoveryPaidCallReserve,
          )
        : selectCommercialNativeV2RequestPlan({
            calls: availableSemanticPlan,
            maxRequests: input.nativeV2.maxRequests,
            maxAuthorizedCostMicros: input.nativeV2.maxAuthorizedCostMicros,
            ...(input.nativeV2.requestOffset === undefined
              ? {}
              : { requestOffset: input.nativeV2.requestOffset }),
          });
      await input.nativeV2?.recordRequestPlan?.({
        calls: availableSemanticPlan,
        selectedCalls: semanticPlan,
      });
      requiredSemanticQueryIds = new Set(
        semanticPlan.flatMap(({ plannerLineage, sourceType }) =>
          plannerLineage === undefined || sourceType !== "BLUEPRINT_SERP_STANDARD_QUEUE"
            ? [] : [plannerLineage.queryId]
        ),
      );
      semanticRequiredCallCount = requiredSemanticQueryIds.size;

      if (
        input.nativeV2 === undefined
        && input.sharedEvidence !== undefined
      ) {
        for (const call of candidatePlan) {
          const reusable = await input.sharedEvidence.readReusable(call);
          if (
            reusable !== null
            && !artifacts.some(
              ({ requestFingerprint }) =>
                requestFingerprint === reusable.requestFingerprint,
            )
          ) {
            artifacts.push(reusable);
            sources.push("cache");
          }
        }
      }

      await ensureBatchOpen();
      if (acceptedRecoveryPlan.length > 0) {
        const recoveryCalls = Object.freeze(
          acceptedRecoveryPlan.map(({ call }) => call),
        );
        await executePlan(recoveryCalls, acceptedRecoveryPlan);
      }
      if (failureStatus === null) {
        const collectedFingerprints = new Set(
          artifacts.map(({ requestFingerprint }) => requestFingerprint),
        );
        const pendingSemanticPlan = semanticPlan.filter(
          (call) =>
            !collectedFingerprints.has(
              fingerprintCommercialDiscoveryCall(call),
            ),
        );
        await executePlan(pendingSemanticPlan, []);
      }
      if (stoppedByNativePolicy) {
        requiredSemanticQueryIds = new Set(
          nativeRequestResults.flatMap(({ call }) =>
            call.plannerLineage === undefined
              || call.sourceType !== "BLUEPRINT_SERP_STANDARD_QUEUE"
              ? []
              : [call.plannerLineage.queryId]
          ),
        );
        semanticRequiredCallCount = requiredSemanticQueryIds.size;
      }
      if (semanticPlan.length === 0) {
        pauseReason = "semantic_discovery_not_planned_endpoint_allowlist";
      }
    }
    await persistGeneratedBlueprintWithObservedEvidence();
    await ensureBatchOpen();
  } finally {
    await input.client.query(
      "SELECT pg_advisory_unlock(hashtextextended($1,0))",
      [lockKey],
    );
  }
  if (input.nativeV2 !== undefined) {
    const authoritativeBlueprintId =
      input.nativeV2.authoritativeBlueprintId.trim();
    const collectedAt =
      artifacts
        .map(({ collectedAt }) => collectedAt)
        .sort()
        .at(-1) ?? startedAt.toISOString();
    if (!curatedResourceLibrary) {
      semanticCompletedCallCount = new Set(
        artifacts.flatMap(({ sourceType, plannerLineage }) =>
          sourceType === "BLUEPRINT_SERP_STANDARD_QUEUE" &&
          plannerLineage !== undefined &&
          plannerLineage.blueprintId === authoritativeBlueprintId &&
          requiredSemanticQueryIds.has(plannerLineage.queryId)
            ? [plannerLineage.queryId]
            : [],
        ),
      ).size;
      if (semanticCompletedCallCount < semanticRequiredCallCount) {
        failureStatus ??= "paused";
        pauseReason ??=
          semanticCompletedCallCount === 0
            ? "semantic_discovery_not_executed"
            : "semantic_discovery_incomplete";
      }
    }
    const batchStatus = failureStatus ?? "completed";
    const fingerprints = artifacts.map(
      ({ requestFingerprint }) => requestFingerprint,
    );
    return Object.freeze({
      candidates: Object.freeze([]),
      requests: Object.freeze(nativeRequestResults),
      provider: Object.freeze({
        source: providerSource(sources),
        acquiredAt: collectedAt,
        costMicros: paidCostMicros,
        requestFingerprint: aggregateHash(
          fingerprints.length === 0
            ? [`commercial-discovery-native-v2:${input.jobId}`]
            : fingerprints,
        ),
      }),
      discovery: Object.freeze({
        semanticStatus: curatedResourceLibrary
          ? "not_required"
          : semanticRequiredCallCount === 0
            ? "not_required"
            : batchStatus === "completed"
              ? "completed"
              : batchStatus,
        semanticRequiredCallCount,
        semanticCompletedCallCount,
        reason: pauseReason,
      }),
    });
  }
  if (batchId.length === 0) {
    throw new Error("COMMERCIAL_DISCOVERY_BATCH_NOT_OPEN");
  }

  const projectAuthority = await loadProjectAuthority(input);
  const merged = mergeCommercialDiscoveryArtifacts({
    artifacts,
    userDomain: input.context.canonicalDomain,
    excludedDomains: [...history.excludedDomains],
  }).slice(
    0,
    Math.min(
      input.configuration.candidateLimit,
      Math.max(10, input.requestedCount * 4),
    ),
  );
  const collectedAt =
    artifacts
      .map(({ collectedAt }) => collectedAt)
      .sort()
      .at(-1) ?? startedAt.toISOString();
  const baselineEvaluated = await mapConcurrent(
    merged,
    staticAssessmentConcurrency,
    async (candidate) => {
      const staticAssessment = await assessCommercialCandidateSite({
        canonicalDomain: candidate.canonicalDomain,
        discoveryUrls: candidate.discoveryUrls,
        workspaceId: input.scope.workspaceId,
        websiteProjectId: input.scope.websiteProjectId,
        project: {
          products: input.context.products,
          topics: blueprint.topicClusters,
          keywords: input.context.keywords,
          targetPages: input.context.targetUrls,
          targetAudiences: input.context.targetAudiences,
          partnershipGoals: input.context.partnershipGoals,
        },
        safeFetch: input.safeFetch,
        ...(input.browserFetch === undefined
          ? {}
          : { browserFetch: input.browserFetch }),
        pageParser: commercialPageParser,
        now: () => input.now().toISOString(),
      });
      const business = Object.freeze({
        selfOrRelatedDomain:
          candidate.canonicalDomain === input.context.canonicalDomain,
        existingBacklinkOrOpportunity: false,
        permanentlyRejectedOrSuppressed:
          history.previouslyExcludedDomains.has(candidate.canonicalDomain),
        unsafeOrDisallowedIndustry: false,
        targetCountryCode: input.context.countryCode,
        candidateCountryCode: candidate.countryCode,
        targetLanguages: [
          input.context.locale,
          input.configuration.languageCode,
        ],
        allowSameLanguageExpansion:
          input.refillTier === "same_language_expansion" ||
          input.refillTier === "curated_resource_library",
        targetMarketScopedDiscovery: [
          "exact_product_target_market",
          "same_topic_target_market",
          "adjacent_industry_same_audience",
          "resource_media_review_partner_ecosystem",
        ].includes(input.refillTier),
        projectAuthorityScore: projectAuthority.score,
      });
      const commercialScore = evaluateCommercialCandidate({
        business,
        provider: {
          rank: candidate.rank,
          traffic: candidate.traffic,
          backlinkCount: candidate.backlinkCount,
          referringDomainCount: candidate.referringDomainCount,
          spamScore: candidate.spamScore,
          backlinkPageEvidence: candidate.backlinkPageEvidence,
          evidenceRefs: candidate.evidenceRefs,
          collectedAt,
        },
        staticAssessment,
      });
      return Object.freeze({
        hostnameAscii: candidate.canonicalDomain,
        sourceTypes: candidate.sourceTypes,
        business,
        provider: Object.freeze({
          rank: candidate.rank,
          traffic: candidate.traffic,
          backlinkCount: candidate.backlinkCount,
          referringDomainCount: candidate.referringDomainCount,
          spamScore: candidate.spamScore,
          countryCode: candidate.countryCode,
          backlinkPageEvidence: candidate.backlinkPageEvidence,
          evidenceRefs: candidate.evidenceRefs,
          collectedAt,
        }),
        staticAssessment,
        commercialScore,
      });
    },
  );
  const progressiveAdmission =
    applyProgressiveCommercialCandidateAdmission(
      baselineEvaluated.map(({ commercialScore }) => commercialScore),
      { visiblePoolGeneration: input.visiblePoolGeneration },
    );
  const evaluated = Object.freeze(
    baselineEvaluated.map((candidate, index) => {
      const commercialScore = progressiveAdmission.scores[index];
      if (commercialScore === undefined) {
        throw new Error("COMMERCIAL_PROGRESSIVE_ADMISSION_SCORE_MISSING");
      }
      return Object.freeze({
        ...candidate,
        commercialScore,
      });
    }),
  );
  const enrichment = selectCommercialCandidateEnrichment(evaluated);
  const enrichmentDecisions = new Map(
    enrichment.decisions.map((decision) => [
      decision.hostnameAscii,
      decision,
    ]),
  );

  for (const candidate of evaluated) {
    const enrichmentDecision = enrichmentDecisions.get(
      candidate.hostnameAscii,
    );
    if (enrichmentDecision === undefined) {
      throw new Error("COMMERCIAL_ENRICHMENT_DECISION_MISSING");
    }
    await input.client.query(
      `INSERT INTO backlink_commercial_candidates (
         id,organization_id,workspace_id,website_project_id,blueprint_id,
         discovery_batch_id,project_context_version_id,
         visible_pool_generation,canonical_domain,
         source_types,static_assessment,gate_decision,commercial_score,
         score_model_version,state,provider_collected_at,
         created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,
         $13::jsonb,$14,$15,$16,$17,$17
       )
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         project_context_version_id,visible_pool_generation,
         canonical_domain,score_model_version
       ) DO UPDATE SET
         blueprint_id=EXCLUDED.blueprint_id,
         discovery_batch_id=EXCLUDED.discovery_batch_id,
         source_types=EXCLUDED.source_types,
         static_assessment=EXCLUDED.static_assessment,
         gate_decision=EXCLUDED.gate_decision,
         commercial_score=EXCLUDED.commercial_score,
         state=CASE
           WHEN backlink_commercial_candidates.state IN (
             'contact_enrichment','published'
           )
             AND EXCLUDED.state='candidate_ready'
             THEN backlink_commercial_candidates.state
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
        input.visiblePoolGeneration,
        candidate.hostnameAscii,
        JSON.stringify(candidate.sourceTypes),
        JSON.stringify(candidate.staticAssessment),
        JSON.stringify({
          decision: candidate.commercialScore.decision,
          hitGates: candidate.commercialScore.hitGates,
          missingEvidence: candidate.commercialScore.missingEvidence,
          enrichment: enrichmentDecision,
        }),
        JSON.stringify(candidate.commercialScore),
        candidate.commercialScore.scoreModelVersion,
        candidateState(
          candidate.commercialScore.decision,
          enrichmentDecision.decision,
        ),
        collectedAt,
        input.actorId,
      ],
    );
  }

  const finishedAt = input.now();
  if (!curatedResourceLibrary) {
    semanticCompletedCallCount = new Set(
      artifacts.flatMap(({ sourceType, plannerLineage }) =>
        sourceType === "BLUEPRINT_SERP_STANDARD_QUEUE"
          && plannerLineage !== undefined
          && plannerLineage.blueprintId === blueprintId
          && requiredSemanticQueryIds.has(plannerLineage.queryId)
          ? [plannerLineage.queryId]
          : []
      ),
    ).size;
    if (semanticCompletedCallCount < semanticRequiredCallCount) {
      failureStatus ??= "paused";
      pauseReason ??= semanticCompletedCallCount === 0
        ? "semantic_discovery_not_executed"
        : "semantic_discovery_incomplete";
    }
  }
  const batchStatus = failureStatus ?? "completed";
  const sourceTypes = [
    "EXISTING_HISTORY",
    ...new Set(artifacts.map(({ sourceType }) => sourceType)),
  ];
  const fingerprints = artifacts.map(
    ({ requestFingerprint }) => requestFingerprint,
  );
  const ranked = rankCommercialRecommendationFits(evaluated)
    .filter(({ commercialScore }) => commercialScore.decision === "eligible")
    .slice(0, input.requestedCount);
  const eliminationCounts = eliminationReasonCounts(evaluated);
  await input.client.query(
    `UPDATE backlink_commercial_discovery_batches
        SET status=$5,source_types=$6::jsonb,
            provider_request_fingerprints=$7::jsonb,
            provider_collected_at=$8,paid_cost_micros=$9,
            pause_reason=$10,
            finished_at=CASE
              WHEN backlink_commercial_discovery_batches.status
                     IN ('paused','unavailable')
               AND $5 IN ('paused','unavailable')
                THEN COALESCE(
                  backlink_commercial_discovery_batches.finished_at,
                  $11
                )
              ELSE $11
            END,
            raw_candidate_count=$12,
            eligible_candidate_count=$13,
            elimination_reason_counts=$14::jsonb
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND id=$4
        AND visible_pool_generation=$15`,
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
      evaluated.length,
      ranked.length,
      JSON.stringify(eliminationCounts),
      input.visiblePoolGeneration,
    ],
  );
  if (input.nativeV2 === undefined) {
    await input.client.query(
      `UPDATE backlink_commercial_inventory_policies AS policy
          SET latest_refill_at=$5,next_refill_at=$6,
              latest_provider_collected_at=$7,pause_reason=$8,
              last_raw_candidate_count=$9,
              elimination_reason_counts=$10::jsonb,
              updated_at=$5,updated_by=$11,version=version+1
        WHERE policy.organization_id=$1 AND policy.workspace_id=$2
          AND policy.website_project_id=$3
          AND policy.project_context_version_id=$4
          AND policy.visible_pool_generation=$12
          AND ${currentV4VisiblePoolPredicate}`,
      [
        input.scope.organizationId,
        input.scope.workspaceId,
        input.scope.websiteProjectId,
        input.contextVersionId,
        finishedAt,
        new Date(finishedAt.getTime() + 15 * 60_000),
        artifacts.length === 0 ? null : collectedAt,
        pauseReason,
        evaluated.length,
        JSON.stringify(eliminationCounts),
        input.actorId,
        input.visiblePoolGeneration,
      ],
    );
  }
  return Object.freeze({
    candidates: Object.freeze(ranked),
    enrichmentCandidates: enrichment.candidates,
    admission: progressiveAdmission.admission,
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
    discovery: Object.freeze({
      semanticStatus: curatedResourceLibrary
        ? "not_required"
        : semanticRequiredCallCount === 0
          ? "not_required"
        : batchStatus === "completed"
          ? "completed"
          : batchStatus,
      semanticRequiredCallCount,
      semanticCompletedCallCount,
      reason: pauseReason,
    }),
  });
}
