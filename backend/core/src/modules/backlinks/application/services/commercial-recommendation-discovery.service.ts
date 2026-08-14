import { createHash, randomUUID } from "node:crypto";

import type { DataForSeoCallGate } from "../policies/dataforseo-call.policy.js";
import type { CommercialDataForSeoRuntime } from "../../adapters/dataforseo/commercial-official-runtime.js";
import { commercialPageParser } from "../../adapters/html/commercial-page-parser.adapter.js";
import {
  buildCommercialDiscoveryBlueprint,
  commercialDiscoveryBlueprintSchemaVersion,
  commercialDiscoveryBlueprintVersion,
  type CommercialDiscoveryBlueprint,
  type CommercialDiscoveryAiGeneration,
  type CommercialDiscoveryAiModel,
  type CommercialDiscoveryBlueprintContext,
} from "../../domain/recommendations/commercial-discovery-blueprint.js";
import {
  createCommercialDiscoveryPlan,
  fingerprintCommercialDiscoveryCall,
  mergeCommercialDiscoveryArtifacts,
  type CommercialDiscoveryArtifact,
  type CommercialDiscoverySourceType,
} from "../../domain/recommendations/commercial-discovery-source.js";
import { evaluateCommercialCandidate } from "../../domain/recommendations/commercial-candidate-evaluation.js";
import {
  rankCommercialRecommendationFits,
  type CommercialFitDecision,
} from "../../domain/recommendations/commercial-score-v3.js";
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
const providerRequestConcurrency = 1;

export type CommercialRecommendationContext = Readonly<{
  snapshotVersion: number;
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
}>;

export type CommercialReadyCandidate = Readonly<{
  hostnameAscii: string;
  sourceTypes: readonly CommercialDiscoverySourceType[];
  provider: Readonly<{
    rank: number | null;
    traffic: number | null;
    backlinkCount: number | null;
    referringDomainCount: number | null;
    spamScore: number | null;
    countryCode: string | null;
    evidenceRefs: readonly string[];
    collectedAt: string;
  }>;
  staticAssessment: CommercialStaticAssessment;
  commercialScore: CommercialCandidateFitDecision;
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

function projectMatchTokens(values: readonly string[]): ReadonlySet<string> {
  return new Set(
    values.flatMap((value) =>
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
    scope: Scope;
    contextVersionId: string;
    context: CommercialRecommendationContext;
    safeFetch: Pick<SafeFetchPort, "fetch">;
  }>,
): Promise<readonly string[]> {
  const evidence = new Set<string>([
    `postgresql:project-context:${input.contextVersionId}:snapshot:${input.context.snapshotVersion}`,
    `postgresql:project-settings:${input.context.projectSettingsVersionId}:version:${input.context.projectSettingsVersion}`,
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
  contextVersionId: string,
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
  const candidates = await client.query(
    `SELECT canonical_domain AS hostname,state
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
    excluded.add(hostname);
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

async function openBatch(
  input: Readonly<{
    client: CommercialDiscoveryQueryClient;
    scope: Scope;
    blueprintId: string;
    contextVersionId: string;
    visiblePoolGeneration: number;
    refillKey: string;
    refillTier: CommercialRefillTier;
    refillRound: number;
    actorId: string;
    startedAt: Date;
  }>,
): Promise<string> {
  const batchId = randomUUID();
  const result = await input.client.query(
    `INSERT INTO backlink_commercial_discovery_batches (
       id,organization_id,workspace_id,website_project_id,blueprint_id,
       project_context_version_id,visible_pool_generation,status,
       idempotency_key,request_intent,
       source_types,refill_tier,refill_round,started_at,created_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,'running',$8,'DISCOVERY',
       '["EXISTING_HISTORY"]'::jsonb,$9,$10,$11,$12
     )
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,
       project_context_version_id,idempotency_key
     ) DO UPDATE SET
       status=CASE
         WHEN backlink_commercial_discovery_batches.status='failed'
           THEN 'running'
         ELSE backlink_commercial_discovery_batches.status
       END,
       pause_reason=CASE
         WHEN backlink_commercial_discovery_batches.status='failed'
           THEN NULL
         ELSE backlink_commercial_discovery_batches.pause_reason
       END,
       finished_at=CASE
         WHEN backlink_commercial_discovery_batches.status='failed'
           THEN NULL
         ELSE backlink_commercial_discovery_batches.finished_at
       END
     RETURNING id`,
    [
      batchId,
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.blueprintId,
      input.contextVersionId,
      input.visiblePoolGeneration,
      `commercial-discovery:${input.refillKey}`,
      input.refillTier,
      input.refillRound,
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

async function remainingBudgetMicros(
  input: Readonly<{
    client: CommercialDiscoveryQueryClient;
    scope: Scope;
    absoluteBudgetMicros: number;
  }>,
): Promise<number> {
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
  sources: readonly ("cache" | "stale-cache" | "single-flight" | "provider")[],
): "cache" | "stale-cache" | "single-flight" | "provider" {
  if (sources.includes("provider")) return "provider";
  if (sources.includes("single-flight")) return "single-flight";
  if (sources.includes("stale-cache")) return "stale-cache";
  return "cache";
}

function candidateState(
  decision: CommercialFitDecision["decision"],
): "candidate_ready" | "excluded" | "insufficient_data" | "manual_review" {
  return decision === "eligible"
    ? "candidate_ready"
    : decision === "ineligible"
      ? "excluded"
      : decision;
}

function uniqueQueries(values: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(values.map((value) => value.trim()).filter(Boolean))],
  );
}

function commercialRefillPageIndex(round: number, window: number): number {
  const roundIndex = Math.max(0, Math.floor(round) - 1);
  const windowIndex = Math.max(0, Math.floor(window) - 1);
  const diagonal = roundIndex + windowIndex;
  return diagonal * (diagonal + 1) / 2 + roundIndex;
}

export function buildCommercialTierSearchQueries(
  input: Readonly<{
    tier: CommercialRefillTier;
    blueprint: CommercialDiscoveryBlueprint;
    context: CommercialRecommendationContext;
    refillRound: number;
    refillWindow: number;
  }>,
): readonly string[] {
  if (input.tier === "curated_resource_library") {
    return Object.freeze([]);
  }
  const market = input.context.countryCode;
  const products = input.context.products.slice(0, 8);
  const keywords = input.context.keywords.slice(0, 8);
  const topics = input.blueprint.topicClusters.slice(0, 16);
  const audiences = input.context.targetAudiences.slice(0, 8);
  const goals = input.context.partnershipGoals.slice(0, 8);
  const blueprintQueries = input.blueprint.searchQueryClusters.slice(0, 24);
  const archetypes = input.blueprint.targetSiteArchetypes.slice(0, 16);
  const cooperationAngles = input.blueprint.cooperationAngles.slice(0, 12);
  const valuePropositions =
    input.blueprint.productValuePropositions.slice(0, 12);
  const targetMarketScoped = input.tier !== "same_language_expansion";
  const subjects = uniqueQueries(
    input.tier === "exact_product_target_market"
      ? [...products, ...blueprintQueries]
      : input.tier === "same_topic_target_market"
        ? [...topics, ...keywords, ...blueprintQueries]
        : input.tier === "adjacent_industry_same_audience"
          ? [...topics, ...products, ...keywords]
          : input.tier === "resource_media_review_partner_ecosystem"
            ? [...products, ...topics, ...goals]
            : [...blueprintQueries, ...topics, ...keywords, ...products],
  );
  const intents =
    input.tier === "exact_product_target_market"
      ? [
          "review",
          "publication",
          "buying guide",
          "editorial",
          "comparison",
          "recommendations",
          "magazine",
          "blog",
          "expert roundup",
          "contributors",
        ]
      : input.tier === "same_topic_target_market"
        ? [
            "blog",
            "magazine",
            "resources",
            "editorial",
            "guide",
            "news",
            "association",
            "community",
            "experts",
            "contributors",
          ]
        : input.tier === "adjacent_industry_same_audience"
          ? [
              "industry resources",
              "industry publication",
              "trade association",
              "professional community",
              "buyer guide",
              "editorial magazine",
              "partner directory",
              "expert roundup",
              "contributors",
              "resource page",
            ]
          : [
              "resource",
              "media",
              "review",
              "partners",
              "guide",
              "association",
              "community",
              "directory",
              "expert roundup",
              "contributors",
            ];
  const qualifiers = uniqueQueries([
    ...(targetMarketScoped ? [market] : []),
    ...audiences,
    ...goals,
    ...cooperationAngles,
  ]);
  const boundedSubjects = subjects.length > 0
    ? subjects
    : uniqueQueries([
        ...blueprintQueries,
        ...valuePropositions,
        input.blueprint.canonicalDomain,
      ]);
  const boundedQualifiers =
    qualifiers.length > 0 ? qualifiers : targetMarketScoped ? [market] : [""];
  const query = (...parts: readonly string[]) => uniqueQueries(parts).join(" ");
  const allQueries = uniqueQueries(
    boundedSubjects.flatMap((subject) => [
      ...boundedQualifiers.flatMap((qualifier) =>
        intents.map((intent) =>
          query(
            subject,
            targetMarketScoped ? market : "",
            qualifier === market ? "" : qualifier,
            intent,
          )
        )
      ),
      ...archetypes.map((archetype) =>
        query(subject, targetMarketScoped ? market : "", archetype)
      ),
      ...cooperationAngles.map((angle) =>
        query(subject, targetMarketScoped ? market : "", angle)
      ),
      ...audiences.flatMap((audience) =>
        archetypes.map((archetype) =>
          query(
            audience,
            subject,
            targetMarketScoped ? market : "",
            archetype,
          )
        )
      ),
      ...valuePropositions.flatMap((value) =>
        intents.slice(0, 5).map((intent) =>
          query(value, targetMarketScoped ? market : "", intent)
        )
      ),
    ]),
  );
  const pageIndex = commercialRefillPageIndex(
    input.refillRound,
    input.refillWindow,
  );
  return Object.freeze(allQueries.slice(pageIndex * 20, pageIndex * 20 + 20));
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
  const projectAuthority = calculateProjectAuthority(
    referringDomains !== null && Number.isFinite(referringDomains)
      ? referringDomains
      : null,
  );
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
      ORDER BY authority_score DESC,canonical_domain
      LIMIT $3`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      455,
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
    blueprintGenerator?: AiCommercialDiscoveryBlueprintPort | undefined;
    requestClientFactory?:
      | (() => Promise<CommercialDiscoveryRequestClientLease>)
      | undefined;
    requestedCount: number;
    jobId: string;
    visiblePoolGeneration: number;
    refillTier: CommercialRefillTier;
    refillRound: number;
    refillWindow?: number | undefined;
    actorId: string;
    now(): Date;
  }>,
): Promise<CommercialRecommendationDiscoveryResult> {
  const startedAt = input.now();
  const activePool = await input.client.query(
    `SELECT visible_pool_generation AS "visiblePoolGeneration"
       FROM backlink_commercial_inventory_policies
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND project_context_version_id=$4
        AND visible_pool_generation=$5
        AND visible_pool_state='building'
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
  );
  const curatedResourceLibrary =
    input.refillTier === "curated_resource_library";
  const artifacts: CommercialDiscoveryArtifact[] = [];
  const sources: ("cache" | "stale-cache" | "single-flight" | "provider")[] =
    [];
  let blueprint: CommercialDiscoveryBlueprint;
  let blueprintId: string;
  let plan = Object.freeze([]) as ReturnType<
    typeof createCommercialDiscoveryPlan
  >;
  let pauseReason: string | null = null;
  let failureStatus: "paused" | "unavailable" | null = null;
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
        scope: input.scope,
        contextVersionId: input.contextVersionId,
        context: input.context,
        safeFetch: input.safeFetch,
      });
      generatedContext = blueprintContext({
        contextVersionId: input.contextVersionId,
        context: input.context,
        configuration: input.configuration,
        evidenceRefs,
        historicalFeedbackDomains: [...history.previouslyExcludedDomains],
      });
      if (input.blueprintGenerator !== undefined) {
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
      const budget = await remainingBudgetMicros({
        client: input.client,
        scope: input.scope,
        absoluteBudgetMicros: input.configuration.absoluteBudgetMicros,
      });
      plan = createCommercialDiscoveryPlan({
        searchQueries: buildCommercialTierSearchQueries({
          tier: input.refillTier,
          blueprint,
          context: input.context,
          refillRound: input.refillRound,
          refillWindow: input.refillWindow ?? 1,
        }),
        verifiedCompetitorDomains: blueprint.explicitCompetitorDomains,
        userDomain: input.context.canonicalDomain,
        locationCode: input.configuration.locationCode,
        languageCode: input.configuration.languageCode,
        endpointAllowlist: input.configuration.endpointAllowlist,
        estimatedCostMicros: input.configuration.estimatedCostMicros,
        remainingBudgetMicros: budget,
      });
      pauseReason = plan.length === 0 ? "budget_or_endpoint_allowlist" : null;
      failureStatus = plan.length === 0 ? "paused" : null;
      const concurrency =
        input.requestClientFactory === undefined
          ? 1
          : providerRequestConcurrency;
      const indexedPlan = plan.map((call, index) => ({ call, index }));
      for (
        let offset = 0;
        offset < indexedPlan.length;
        offset += concurrency
      ) {
        const group = indexedPlan.slice(offset, offset + concurrency);
        const settled = await Promise.allSettled(
          group.map(async ({ call, index }) => {
            const lease =
              input.requestClientFactory === undefined
                ? Object.freeze({
                    client: input.client,
                    gate: input.gate,
                    release: () => undefined,
                  })
                : await input.requestClientFactory();
            try {
              const requestService = new CommercialDiscoveryRequestService({
                client: lease.client,
                provider: input.provider,
                gate: lease.gate ?? input.gate,
                now: input.now,
              });
              const fingerprint = fingerprintCommercialDiscoveryCall(call);
              const context: ProviderRequestContext = {
                ...input.scope,
                requestId: `${refillKey}:${index + 1}`,
                idempotencyKey:
                  `commercial-discovery:${refillKey}:${fingerprint}`,
                budgetReservationId: `${refillKey}:${fingerprint}`,
              };
              return await requestService.execute({
                context,
                projectContextVersionId: input.contextVersionId,
                call,
                locationCode: input.configuration.locationCode,
                languageCode: input.configuration.languageCode,
                refreshMode: "CACHE_PREFERRED",
                actorId: input.actorId,
              });
            } finally {
              await lease.release();
            }
          }),
        );
        let firstFailure: unknown;
        let unknownChargeFailure: unknown;
        for (const outcome of settled) {
          if (outcome.status === "fulfilled") {
            artifacts.push(outcome.value.artifact);
            sources.push(outcome.value.source);
            continue;
          }
          const message =
            outcome.reason instanceof Error
              ? outcome.reason.message
              : "DATAFORSEO_DISCOVERY_UNAVAILABLE";
          if (
            message.includes("CHARGE_RECONCILIATION") ||
            message.includes("unknown_charge")
          ) {
            unknownChargeFailure ??= outcome.reason;
          } else {
            firstFailure ??= outcome.reason;
          }
        }
        if (unknownChargeFailure !== undefined) {
          if (generatedContext !== null) {
            blueprintId = await persistBlueprint({
              client: input.client,
              scope: input.scope,
              contextVersionId: input.contextVersionId,
              blueprint,
              actorId: input.actorId,
              generatedAt: startedAt,
            });
          }
          throw unknownChargeFailure;
        }
        if (firstFailure !== undefined) {
          const message =
            firstFailure instanceof Error
              ? firstFailure.message
              : "DATAFORSEO_DISCOVERY_UNAVAILABLE";
          pauseReason = message.slice(0, 255);
          failureStatus =
            firstFailure instanceof Error &&
            firstFailure.name === "DataForSeoCallBlockedError"
              ? "paused"
              : "unavailable";
          break;
        }
      }
    }
    if (generatedContext !== null) {
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
    }
  } finally {
    await input.client.query(
      "SELECT pg_advisory_unlock(hashtextextended($1,0))",
      [lockKey],
    );
  }

  const activePolicy = await input.client.query(
    `UPDATE backlink_commercial_inventory_policies
        SET updated_at=now(),updated_by=$6
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND project_context_version_id=$4
        AND visible_pool_generation=$5
        AND visible_pool_state='building'
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
  const batchId = await openBatch({
    client: input.client,
    scope: input.scope,
    blueprintId,
    contextVersionId: input.contextVersionId,
    visiblePoolGeneration: input.visiblePoolGeneration,
    refillKey,
    refillTier: input.refillTier,
    refillRound: input.refillRound,
    actorId: input.actorId,
    startedAt,
  });

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
  const evaluated = await mapConcurrent(
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
        pageParser: commercialPageParser,
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
        },
        provider: {
          rank: candidate.rank,
          traffic: candidate.traffic,
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
          traffic: candidate.traffic,
          backlinkCount: candidate.backlinkCount,
          referringDomainCount: candidate.referringDomainCount,
          spamScore: candidate.spamScore,
          countryCode: candidate.countryCode,
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
  const batchStatus =
    failureStatus ??
    (artifacts.length > 0 || plan.length === 0 ? "completed" : "unavailable");
  const sourceTypes = [
    "EXISTING_HISTORY",
    ...new Set(artifacts.map(({ sourceType }) => sourceType)),
  ];
  const fingerprints = artifacts.map(
    ({ requestFingerprint }) => requestFingerprint,
  );
  const paidCostMicros = artifacts.reduce(
    (sum, artifact) => sum + artifact.costMicros,
    0,
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
            raw_candidate_count=$12,eligible_candidate_count=$13,
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
  await input.client.query(
    `UPDATE backlink_commercial_inventory_policies
        SET latest_refill_at=$5,next_refill_at=$6,
            latest_provider_collected_at=$7,pause_reason=$8,
            last_raw_candidate_count=$9,
            elimination_reason_counts=$10::jsonb,
            updated_at=$5,updated_by=$11,version=version+1
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND project_context_version_id=$4
        AND visible_pool_generation=$12
        AND visible_pool_state='building'`,
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
