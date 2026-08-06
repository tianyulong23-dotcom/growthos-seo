import { randomUUID } from "node:crypto";

import { load } from "cheerio";
import { z } from "zod";

import {
  createCommercialOfficialDataForSeoRuntime,
} from "../adapters/dataforseo/commercial-official-runtime.js";
import { SafeFetchAdapter } from "../adapters/http/safe-fetch.adapter.js";
import {
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import { DataForSeoCallPolicy } from "../application/policies/dataforseo-call.policy.js";
import {
  executeCommercialRecommendationDiscovery,
} from "../application/services/commercial-recommendation-discovery.service.js";
import type {
  BacklinkRecommendationRefillActivities,
  RecommendationProviderExecutionSummary,
} from "../workflows/definitions/backlink-recommendation-refill.orchestration.js";
import type {
  EvidenceValue,
} from "../domain/evidence/evidence.js";
import {
  createRecommendationDomainKey,
} from "../domain/recommendations/domain-key.js";
import type {
  RecommendationEvidenceCandidate,
} from "../domain/recommendations/evaluation.js";
import {
  type RecommendationGateRuleId,
  type RecommendationRuleFacts,
} from "../domain/recommendations/gates.js";
import {
  recommendationScoreComponentIds,
  type RecommendationScoreComponentId,
  type RecommendationScoreComponentInput,
} from "../domain/recommendations/scoring.js";
import {
  createProviderAnalysisRepository,
} from "../db/repositories/provider-analysis.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantContext,
  type BacklinkTenantPool,
  type BacklinkTenantPoolClient,
} from "../db/tenant-transaction.js";
import type {
  ReferringDomainEvidence,
} from "../ports/dataforseo.port.js";
import type {
  SafeFetchPort,
} from "../ports/safe-fetch.port.js";
import {
  secretKinds,
} from "../ports/secret-store.port.js";
import {
  localProductDataForSeoCredentialReferenceSchema,
  localProductDataForSeoEndpointAllowlistSchema,
} from "./local-product-dataforseo-bootstrap.js";

const evidencePolicyVersion = "recommendation-evidence-policy.v1";
const evidenceDerivationRuleVersion =
  "local-product-dataforseo-evidence.v1";
const scoreNormalizationRuleVersion =
  "local-product-dataforseo-score-normalization.v1";
const maxWebsiteEvidenceBytes = 512_000;
const maxWebsiteRedirects = 4;
const websiteFetchConcurrency = 8;

const jsonStringArraySchema = z.array(
  z.string().trim().min(1).max(2_048),
).min(1).max(100);
const dataForSeoCredentialSchema = z.object({
  login: z.string().trim().min(1).max(512),
  password: z.string().min(1).max(2_048),
}).strict();
const storedCommercialScoreSchema = z.object({
  decision: z.literal("ready"),
  scoreModelVersion: z.literal("recommendation-commercial-fit.v2"),
  ruleVersion: z.string().trim().min(1),
  total: z.number().min(0).max(100),
  components: z.array(z.object({
    id: z.string().trim().min(1),
    weight: z.number().min(0).max(100),
  }).passthrough()),
  hitGates: z.array(z.string()),
  missingEvidence: z.array(z.string()),
}).passthrough();
const configurationSchema = z.object({
  credentialSecretRef: localProductDataForSeoCredentialReferenceSchema,
  endpointAllowlist: localProductDataForSeoEndpointAllowlistSchema,
  timeoutMs: z.number().int().positive().max(120_000),
  estimatedCostMicros: z.number().int().positive().max(100_000_000),
  absoluteBudgetMicros: z.number().int().positive().max(100_000_000),
  maxPaidCalls: z.number().int().min(1).max(1_000),
  candidateLimit: z.number().int().min(10).max(100),
  locationCode: z.string().trim().regex(/^[1-9][0-9]*$/u),
  languageCode: z.string().trim().min(2).max(32),
  discoveryTargets: z.array(
    z.string().trim().min(1).max(253),
  ).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (value.absoluteBudgetMicros < value.estimatedCostMicros) {
    context.addIssue({
      code: "custom",
      path: ["absoluteBudgetMicros"],
      message: "DataForSEO budget must cover the estimated request.",
    });
  }
});
const projectRecommendationContextSchema = z.object({
  snapshotVersion: z.coerce.number().int().positive(),
  projectStatus: z.literal("ACTIVE"),
  canonicalDomain: z.string().trim().min(1).max(253),
  locale: z.string().trim().min(1).max(32),
  countryCode: z.string().trim().min(1).max(64),
  products: jsonStringArraySchema,
  keywords: jsonStringArraySchema,
  targetUrls: z.array(
    z.string().trim().url().max(2_048),
  ).min(1).max(100),
}).strict().superRefine((value, context) => {
  try {
    createRecommendationDomainKey(value.canonicalDomain);
  } catch {
    context.addIssue({
      code: "custom",
      path: ["canonicalDomain"],
      message: "Project canonical domain must be a public domain.",
    });
  }
  for (const targetUrl of value.targetUrls) {
    const url = new URL(targetUrl);
    if (
      url.protocol !== "https:"
      || url.username !== ""
      || url.password !== ""
      || url.hostname === "example.invalid"
      || url.hostname.endsWith(".example.invalid")
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetUrls"],
        message: "Project target URLs must be real credential-free HTTPS URLs.",
      });
    }
  }
});

export type LocalProductDataForSeoConfiguration = Readonly<
  z.output<typeof configurationSchema>
>;
export type LocalProductRecommendationContext = Readonly<
  Omit<z.output<typeof projectRecommendationContextSchema>,
    "products" | "keywords" | "targetUrls">
  & Readonly<{
    products: readonly string[];
    keywords: readonly string[];
    targetUrls: readonly string[];
  }>
>;

export function parseLocalProductRecommendationContext(
  value: unknown,
): LocalProductRecommendationContext {
  const parsed = projectRecommendationContextSchema.parse(value);
  return Object.freeze({
    ...parsed,
    products: Object.freeze([...parsed.products]),
    keywords: Object.freeze([...parsed.keywords]),
    targetUrls: Object.freeze([...parsed.targetUrls]),
  });
}

export function isLocalProductDataForSeoPaidCallAllowed(
  paidCallCount: number,
  maxPaidCalls: number,
): boolean {
  return paidCallCount < maxPaidCalls;
}

type Environment = Readonly<Record<string, string | undefined>>;

function requiredEnvironmentValue(
  environment: Environment,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`INPUT_REQUIRED: ${name}`);
  }
  return value;
}

function positiveIntegerEnvironmentValue(
  environment: Environment,
  name: string,
): number {
  const value = requiredEnvironmentValue(environment, name);
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`INPUT_REQUIRED: ${name}`);
  }
  return Number(value);
}

function jsonArrayEnvironmentValue(
  environment: Environment,
  name: string,
): readonly string[] {
  const value = requiredEnvironmentValue(environment, name);
  try {
    return jsonStringArraySchema.parse(JSON.parse(value));
  } catch (error) {
    throw new Error(`INPUT_REQUIRED: ${name}`, { cause: error });
  }
}

export function readLocalProductDataForSeoConfiguration(
  environment: Environment = process.env,
): LocalProductDataForSeoConfiguration {
  return configurationSchema.parse({
    credentialSecretRef: requiredEnvironmentValue(
      environment,
      "DATAFORSEO_CREDENTIAL_SECRET_REF",
    ),
    endpointAllowlist: jsonArrayEnvironmentValue(
      environment,
      "DATAFORSEO_ENDPOINT_ALLOWLIST",
    ),
    timeoutMs: positiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_REQUEST_TIMEOUT_MS",
    ),
    estimatedCostMicros: positiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_ESTIMATED_COST_MICROS",
    ),
    absoluteBudgetMicros: positiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_ABSOLUTE_BUDGET_MICROS",
    ),
    maxPaidCalls: positiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_MAX_PAID_CALLS",
    ),
    candidateLimit: positiveIntegerEnvironmentValue(
      environment,
      "DATAFORSEO_CANDIDATE_LIMIT",
    ),
    locationCode: requiredEnvironmentValue(
      environment,
      "DATAFORSEO_LOCATION_CODE",
    ),
    languageCode: requiredEnvironmentValue(
      environment,
      "DATAFORSEO_LANGUAGE_CODE",
    ),
    discoveryTargets: jsonArrayEnvironmentValue(
      environment,
      "DATAFORSEO_DISCOVERY_TARGETS_JSON",
    ),
  });
}

function evidenceMetadata(input: Readonly<{
  sourceType: string;
  sourceReleaseId: string;
  observedAt: string;
  evidenceRefs: readonly string[];
}>) {
  return {
    sourceType: input.sourceType,
    sourceReleaseId: input.sourceReleaseId,
    observedAt: input.observedAt,
    stale: false,
    evidenceRefs: Object.freeze([...input.evidenceRefs]),
  } as const;
}

function derivedEvidence<T>(input: Readonly<{
  value: T;
  sourceType: string;
  sourceReleaseId: string;
  observedAt: string;
  confidence: number;
  evidenceRefs: readonly string[];
}>): EvidenceValue<T> {
  return Object.freeze({
    ...evidenceMetadata(input),
    availability: "derived",
    value: input.value,
    confidence: input.confidence,
    derivationRuleVersion: evidenceDerivationRuleVersion,
  });
}

function unavailableEvidence<T>(input: Readonly<{
  sourceType: string;
  sourceReleaseId: string;
  observedAt: string;
  evidenceRefs?: readonly string[];
}>): EvidenceValue<T> {
  return Object.freeze({
    ...evidenceMetadata({
      ...input,
      evidenceRefs: input.evidenceRefs ?? [],
    }),
    availability: "unavailable",
    confidence: 0,
    reason: "source_unavailable",
  });
}

function normalizeScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function tokenize(values: readonly string[]): ReadonlySet<string> {
  return new Set(values.flatMap((value) =>
    value.toLowerCase().split(/[^a-z0-9]+/u)
      .filter((token) => token.length >= 3)
  ));
}

function scoreComponent(input: Readonly<{
  id: RecommendationScoreComponentId;
  value: number;
  sourceType: string;
  sourceReleaseId: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  reasonCode: string;
}>): RecommendationScoreComponentInput {
  const value = normalizeScore(input.value);
  return Object.freeze({
    id: input.id,
    evidence: derivedEvidence({
      value,
      sourceType: input.sourceType,
      sourceReleaseId: input.sourceReleaseId,
      observedAt: input.observedAt,
      confidence: 0.85,
      evidenceRefs: input.evidenceRefs,
    }),
    normalizedValue: value,
    normalizationRuleVersion: scoreNormalizationRuleVersion,
    reasonCode: input.reasonCode,
  });
}

function unavailableScoreComponent(input: Readonly<{
  id: RecommendationScoreComponentId;
  sourceReleaseId: string;
  observedAt: string;
  evidenceRefs: readonly string[];
}>): RecommendationScoreComponentInput {
  return Object.freeze({
    id: input.id,
    evidence: unavailableEvidence<number>({
      sourceType: "static_safe_fetch",
      sourceReleaseId: input.sourceReleaseId,
      observedAt: input.observedAt,
      evidenceRefs: input.evidenceRefs,
    }),
    normalizedValue: null,
    normalizationRuleVersion: scoreNormalizationRuleVersion,
    reasonCode: "WEBSITE_EVIDENCE_UNAVAILABLE",
  });
}

function gateFact(
  ruleId: RecommendationGateRuleId,
  result: EvidenceValue<boolean>,
) {
  return Object.freeze({
    evidenceKey: `recommendation.gate.${ruleId}`,
    result,
  });
}

type BuildCandidateInput = Readonly<{
  context: Readonly<{
    workspaceId: string;
    websiteProjectId: string;
  }>;
  evidence: ReferringDomainEvidence;
  sourceReleaseId: string;
  acquiredAt: string;
  locationCode: string;
  languageCode: string;
  projectTerms: readonly string[];
  existingHostname: boolean;
  existingBacklink: boolean;
  previouslyExcluded: boolean;
  duplicateDomain: boolean;
  safeFetch: Pick<SafeFetchPort, "fetch">;
}>;

function databaseGateFacts(
  input: BuildCandidateInput,
  sourceRefs: readonly string[],
): Pick<
  RecommendationRuleFacts,
  | "user_suppressed"
  | "workspace_suppressed"
  | "platform_suppressed"
  | "existing_backlink"
  | "already_joined"
  | "previously_excluded"
  | "duplicate_domain"
> {
  const value = (flag: boolean, reason: string) => derivedEvidence({
    value: flag,
    sourceType: "postgresql_business_truth",
    sourceReleaseId: input.sourceReleaseId,
    observedAt: input.acquiredAt,
    confidence: 1,
    evidenceRefs: [...sourceRefs, reason],
  });
  return {
    user_suppressed: gateFact(
      "user_suppressed",
      value(false, "postgresql:user-suppression:none"),
    ),
    workspace_suppressed: gateFact(
      "workspace_suppressed",
      value(false, "postgresql:workspace-suppression:none"),
    ),
    platform_suppressed: gateFact(
      "platform_suppressed",
      value(false, "postgresql:platform-suppression:none"),
    ),
    existing_backlink: gateFact(
      "existing_backlink",
      value(input.existingBacklink, "postgresql:placement-dedup"),
    ),
    already_joined: gateFact(
      "already_joined",
      value(input.existingHostname, "postgresql:prospect-dedup"),
    ),
    previously_excluded: gateFact(
      "previously_excluded",
      value(input.previouslyExcluded, "postgresql:recommendation-history"),
    ),
    duplicate_domain: gateFact(
      "duplicate_domain",
      value(input.duplicateDomain, "provider:batch-domain-dedup"),
    ),
  };
}

export async function buildLocalProductRecommendationEvidenceCandidate(
  input: BuildCandidateInput,
): Promise<RecommendationEvidenceCandidate> {
  const domain = createRecommendationDomainKey(input.evidence.domain);
  const providerRef =
    `dataforseo:${input.sourceReleaseId}:${domain.hostnameAscii}`;
  const sourceRefs = Object.freeze([providerRef]);
  const databaseFacts = databaseGateFacts(input, sourceRefs);
  const providerGraphScore = normalizeScore(
    Math.log10(input.evidence.backlinkCount + 1) / 5 * 0.55
      + (input.evidence.rank ?? 0) / 100 * 0.45,
  );

  try {
    const fetched = await input.safeFetch.fetch({
      url: `https://${domain.hostnameAscii}/`,
      purpose: "seo-assessment",
      workspaceId: input.context.workspaceId,
      websiteProjectId: input.context.websiteProjectId,
      maxBytes: maxWebsiteEvidenceBytes,
      maxRedirects: maxWebsiteRedirects,
    });
    const $ = load(Buffer.from(fetched.body).toString("utf8"));
    const title = $("title").first().text().trim();
    const description =
      $("meta[name='description']").first().attr("content")?.trim() ?? "";
    const pageText = `${title} ${description} ${$("body").text()}`
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 200_000)
      .toLowerCase();
    const pageLanguage = ($("html").attr("lang") ?? "")
      .trim()
      .toLowerCase();
    const totalLinks = $("a[href]").length;
    let externalLinks = 0;
    $("a[href]").each((_index, element) => {
      const href = $(element).attr("href");
      if (href === undefined) return;
      try {
        const target = new URL(href, fetched.finalUrl);
        if (
          target.protocol === "http:"
          || target.protocol === "https:"
        ) {
          const targetDomain =
            createRecommendationDomainKey(target.hostname);
          if (targetDomain.registrableDomain !== domain.registrableDomain) {
            externalLinks += 1;
          }
        }
      } catch {
        return;
      }
    });

    const unsafeTerms = [
      "malware",
      "phishing",
      "credential theft",
      "ransomware",
    ];
    const linkFarmTerms = [
      "buy backlinks",
      "sell backlinks",
      "guest post marketplace",
      "link farm",
      "sponsored links for sale",
    ];
    const unsafe = unsafeTerms.some((term) => pageText.includes(term));
    const linkFarm = (input.evidence.spamScore ?? 0) >= 70
      || linkFarmTerms.some((term) => pageText.includes(term));
    const crawlNotPermitted = [401, 403, 451].includes(fetched.status);
    const expectedLanguage = input.languageCode.toLowerCase()
      .split(/[-_]/u)[0] ?? input.languageCode.toLowerCase();
    const languageMismatch = pageLanguage.length > 0
      && !pageLanguage.startsWith(expectedLanguage);
    const marketMismatch =
      input.evidence.countryCode !== null
      && input.evidence.countryCode !== input.locationCode.toUpperCase()
      && languageMismatch;
    const websiteRef =
      `safefetch:${domain.hostnameAscii}:${fetched.fetchedAt}`;
    const combinedRefs = Object.freeze([...sourceRefs, websiteRef]);
    const booleanEvidence = (
      value: boolean,
      sourceType = "static_safe_fetch",
    ) => derivedEvidence({
      value,
      sourceType,
      sourceReleaseId: input.sourceReleaseId,
      observedAt: fetched.fetchedAt,
      confidence: 0.9,
      evidenceRefs: combinedRefs,
    });
    const gates: RecommendationRuleFacts = Object.freeze({
      unsafe_or_malicious: gateFact(
        "unsafe_or_malicious",
        booleanEvidence(unsafe),
      ),
      high_confidence_pbn_or_link_farm: gateFact(
        "high_confidence_pbn_or_link_farm",
        booleanEvidence(linkFarm, "dataforseo_and_static_safe_fetch"),
      ),
      crawl_not_permitted: gateFact(
        "crawl_not_permitted",
        booleanEvidence(crawlNotPermitted),
      ),
      ...databaseFacts,
      market_mismatch: gateFact(
        "market_mismatch",
        booleanEvidence(marketMismatch, "provider_market_and_static_language"),
      ),
    });

    const projectTokens = tokenize(input.projectTerms);
    const pageTokens = tokenize([pageText]);
    const matchedTerms = [...projectTokens]
      .filter((term) => pageTokens.has(term)).length;
    const topicScore = projectTokens.size === 0
      ? 0
      : normalizeScore(matchedTerms / Math.min(projectTokens.size, 12));
    const outboundRatio = totalLinks === 0
      ? 0
      : externalLinks / totalLinks;
    const commercializationScore = normalizeScore(
      1 - outboundRatio * 0.7 - (linkFarm ? 0.3 : 0),
    );
    const networkRiskScore = normalizeScore(
      1 - (input.evidence.spamScore ?? (linkFarm ? 70 : 20)) / 100,
    );
    const technicalScore = normalizeScore(
      (fetched.status >= 200 && fetched.status < 400 ? 0.35 : 0)
        + (fetched.finalUrl.startsWith("https://") ? 0.25 : 0)
        + (title.length > 0 ? 0.25 : 0)
        + (!languageMismatch ? 0.15 : 0),
    );
    const components: readonly RecommendationScoreComponentInput[] =
      Object.freeze([
        scoreComponent({
          id: "graph_authority_diversity",
          value: providerGraphScore,
          sourceType: "dataforseo",
          sourceReleaseId: input.sourceReleaseId,
          observedAt: input.acquiredAt,
          evidenceRefs: sourceRefs,
          reasonCode: "PROVIDER_AUTHORITY_AND_REFERRING_LINKS",
        }),
        scoreComponent({
          id: "topic_content_editorial_quality",
          value: topicScore,
          sourceType: "static_safe_fetch",
          sourceReleaseId: input.sourceReleaseId,
          observedAt: fetched.fetchedAt,
          evidenceRefs: combinedRefs,
          reasonCode: "PROJECT_TERM_CONTENT_OVERLAP",
        }),
        scoreComponent({
          id: "outbound_commercialization",
          value: commercializationScore,
          sourceType: "static_safe_fetch",
          sourceReleaseId: input.sourceReleaseId,
          observedAt: fetched.fetchedAt,
          evidenceRefs: combinedRefs,
          reasonCode: "OUTBOUND_LINK_AND_SELL_LINK_SIGNAL",
        }),
        scoreComponent({
          id: "network_risk",
          value: networkRiskScore,
          sourceType: "dataforseo_and_static_safe_fetch",
          sourceReleaseId: input.sourceReleaseId,
          observedAt: fetched.fetchedAt,
          evidenceRefs: combinedRefs,
          reasonCode: "PROVIDER_SPAM_AND_LINK_FARM_SIGNAL",
        }),
        scoreComponent({
          id: "technical_health",
          value: technicalScore,
          sourceType: "static_safe_fetch",
          sourceReleaseId: input.sourceReleaseId,
          observedAt: fetched.fetchedAt,
          evidenceRefs: combinedRefs,
          reasonCode: "STATIC_FETCH_STATUS_TLS_TITLE_LANGUAGE",
        }),
      ]);
    return Object.freeze({
      hostnameAscii: domain.hostnameAscii,
      sourceReleaseId: input.sourceReleaseId,
      evidencePolicyVersion,
      gates,
      components,
    });
  } catch {
    const unavailable = <T>() => unavailableEvidence<T>({
      sourceType: "static_safe_fetch",
      sourceReleaseId: input.sourceReleaseId,
      observedAt: input.acquiredAt,
      evidenceRefs: sourceRefs,
    });
    const gates: RecommendationRuleFacts = Object.freeze({
      unsafe_or_malicious: gateFact(
        "unsafe_or_malicious",
        unavailable<boolean>(),
      ),
      high_confidence_pbn_or_link_farm: gateFact(
        "high_confidence_pbn_or_link_farm",
        input.evidence.spamScore === null
          ? unavailable<boolean>()
          : derivedEvidence({
              value: input.evidence.spamScore >= 70,
              sourceType: "dataforseo",
              sourceReleaseId: input.sourceReleaseId,
              observedAt: input.acquiredAt,
              confidence: 0.8,
              evidenceRefs: sourceRefs,
            }),
      ),
      crawl_not_permitted: gateFact(
        "crawl_not_permitted",
        unavailable<boolean>(),
      ),
      ...databaseFacts,
      market_mismatch: gateFact(
        "market_mismatch",
        unavailable<boolean>(),
      ),
    });
    const components = Object.freeze(
      recommendationScoreComponentIds.map((id) =>
        id === "graph_authority_diversity"
          ? scoreComponent({
              id,
              value: providerGraphScore,
              sourceType: "dataforseo",
              sourceReleaseId: input.sourceReleaseId,
              observedAt: input.acquiredAt,
              evidenceRefs: sourceRefs,
              reasonCode: "PROVIDER_AUTHORITY_AND_REFERRING_LINKS",
            })
          : unavailableScoreComponent({
              id,
              sourceReleaseId: input.sourceReleaseId,
              observedAt: input.acquiredAt,
              evidenceRefs: sourceRefs,
            })
      ),
    );
    return Object.freeze({
      hostnameAscii: domain.hostnameAscii,
      sourceReleaseId: input.sourceReleaseId,
      evidencePolicyVersion,
      gates,
      components,
    });
  }
}

type ExecuteInput = Parameters<
  BacklinkRecommendationRefillActivities["executeRecommendationRefill"]
>[0];
type StoreInput = Parameters<
  BacklinkRecommendationRefillActivities["storeReadyRecommendations"]
>[0];

export type LocalProductDataForSeoRuntime = Readonly<{
  execute(
    input: ExecuteInput,
  ): ReturnType<
    BacklinkRecommendationRefillActivities["executeRecommendationRefill"]
  >;
  store(
    input: StoreInput,
  ): ReturnType<
    BacklinkRecommendationRefillActivities["storeReadyRecommendations"]
  >;
}>;

type RuntimeOptions = Readonly<{
  pool: BacklinkTenantPool;
  secretStoreRoot: string;
  configuration: LocalProductDataForSeoConfiguration;
  now?: () => Date;
  safeFetch?: Pick<SafeFetchPort, "fetch">;
}>;

function scopeFrom(input: ExecuteInput | StoreInput): BacklinkTenantContext {
  return {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
  };
}

async function setSessionTenant(
  client: BacklinkTenantPoolClient,
  scope: BacklinkTenantContext,
): Promise<void> {
  await client.query(
    `SELECT set_config('app.current_organization_id',$1,false),
            set_config('app.current_workspace_id',$2,false),
            set_config('app.current_website_project_id',$3,false)`,
    [
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
    ],
  );
}

async function clearSessionTenant(
  client: BacklinkTenantPoolClient,
): Promise<void> {
  await client.query(
    `SELECT set_config('app.current_organization_id','',false),
            set_config('app.current_workspace_id','',false),
            set_config('app.current_website_project_id','',false)`,
  );
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
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
        if (value !== undefined) {
          output[index] = await mapper(value, index);
        }
      }
    },
  ));
  return Object.freeze(output);
}

export function createLocalProductDataForSeoRuntime(
  options: RuntimeOptions,
): LocalProductDataForSeoRuntime {
  const configuration = configurationSchema.parse(options.configuration);
  const now = options.now ?? (() => new Date());
  const safeFetch = options.safeFetch ?? new SafeFetchAdapter({
    timeoutMs: Math.min(configuration.timeoutMs, 15_000),
  });
  const secretStore = new LocalProductSecretStoreClient({
    rootDirectory: options.secretStoreRoot,
  });
  const credentialReference = parseLocalProductSecretReference(
    configuration.credentialSecretRef,
    secretKinds.dataForSeoCredential,
  );

  return Object.freeze({
    async execute(input) {
      const scope = scopeFrom(input);
      await withBacklinkTenantTransaction(
        options.pool,
        scope,
        async (client) => {
          await client.query(
            `UPDATE backlink_jobs
                SET status='waiting_provider',
                    step='provider_request_authorizing',
                    progress=10,updated_at=now(),version=version+1
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3 AND id=$4`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.jobId,
            ],
          );
        },
      );

      const providerClient = await options.pool.connect();
      try {
        await setSessionTenant(providerClient, scope);
        const contextResult = await providerClient.query(
          `SELECT snapshot_version AS "snapshotVersion",
                  project_status AS "projectStatus",
                  canonical_domain AS "canonicalDomain",
                  locale, country_code AS "countryCode",
                  products, keywords, target_urls AS "targetUrls"
             FROM backlink_project_context_snapshots
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3 AND id=$4`,
          [
            scope.organizationId,
            scope.workspaceId,
            scope.websiteProjectId,
            input.recommendationContextVersionId,
          ],
        );
        const contextRow = contextResult.rows[0];
        if (contextRow === undefined) {
          throw new Error("BACKLINK_RECOMMENDATION_CONTEXT_NOT_FOUND");
        }
        const recommendationContext =
          parseLocalProductRecommendationContext(
          contextRow,
        );
        const repository = createProviderAnalysisRepository(
          providerClient,
          now,
        );
        const gate = new DataForSeoCallPolicy({
          async checkKillSwitch(gateInput) {
            const result = await providerClient.query(
              `WITH ranked AS (
                 SELECT layer,provider,blocked,
                        row_number() OVER (
                          PARTITION BY layer,provider ORDER BY version DESC
                        ) AS rank
                   FROM backlink_kill_switch_versions
                  WHERE organization_id=$1 AND workspace_id=$2
                    AND website_project_id=$3 AND capability=$4
                    AND (
                      (layer='project' AND provider IS NULL)
                      OR (layer='provider' AND provider=$5)
                    )
               )
               SELECT layer,provider,blocked
                 FROM ranked WHERE rank=1`,
              [
                gateInput.context.organizationId,
                gateInput.context.workspaceId,
                gateInput.context.websiteProjectId,
                gateInput.killSwitchKey,
                gateInput.providerId,
              ],
            );
            const project = result.rows.find((row) =>
              row.layer === "project" && row.provider === null
            );
            const providerDecision = result.rows.find((row) =>
              row.layer === "provider"
              && row.provider === gateInput.providerId
            );
            return project?.blocked === false
              && providerDecision?.blocked === false
              ? "allow"
              : "deny";
          },
          async checkQuota(gateInput) {
            const result = await providerClient.query(
              `WITH current_batch AS (
                 SELECT id
                   FROM provider_batch_requests
                  WHERE organization_id=$1 AND workspace_id=$2
                    AND website_project_id=$3 AND provider=$4
                    AND request_id=$5 AND status='running'
                  ORDER BY started_at DESC,id DESC
                  LIMIT 1
               )
               SELECT count(*)::integer AS count
                 FROM provider_batch_requests AS batch
                WHERE batch.organization_id=$1 AND batch.workspace_id=$2
                  AND batch.website_project_id=$3 AND batch.provider=$4
                  AND batch.status IN ('running','succeeded','unknown_charge')
                  AND batch.id<>COALESCE(
                    (SELECT id FROM current_batch),
                    '00000000-0000-0000-0000-000000000000'::uuid
                  )
                  AND batch.started_at >= COALESCE((
                    SELECT period_start
                      FROM backlink_provider_budgets
                     WHERE organization_id=$1 AND workspace_id=$2
                       AND provider=$4
                       AND period_start<=now() AND period_end>now()
                     ORDER BY period_start DESC LIMIT 1
                  ),now())`,
              [
                gateInput.context.organizationId,
                gateInput.context.workspaceId,
                gateInput.context.websiteProjectId,
                gateInput.provider,
                gateInput.context.requestId,
              ],
            );
            return isLocalProductDataForSeoPaidCallAllowed(
              Number(result.rows[0]?.count ?? 0),
              configuration.maxPaidCalls,
            )
              ? "allow"
              : "deny";
          },
          reserveBudget: repository.reserveBudget,
        });
        let providerRuntime: ReturnType<
          typeof createCommercialOfficialDataForSeoRuntime
        > | null = null;
        const provider = Object.freeze({
          async execute(
            call: Parameters<
              ReturnType<
                typeof createCommercialOfficialDataForSeoRuntime
              >["execute"]
            >[0],
          ) {
            if (providerRuntime === null) {
              const credentials = dataForSeoCredentialSchema.parse(JSON.parse(
                await secretStore.resolve({
                  reference: credentialReference,
                  context: {
                    organizationId: "local-product",
                    subjectProvider: "dataforseo",
                  },
                }),
              ) as unknown);
              providerRuntime = createCommercialOfficialDataForSeoRuntime({
                credentials,
                endpointAllowlist: configuration.endpointAllowlist,
                timeoutMs: configuration.timeoutMs,
              });
            }
            return providerRuntime.execute(call);
          },
        });
        const commercial = await executeCommercialRecommendationDiscovery({
          client: providerClient,
          provider,
          gate,
          safeFetch,
          scope,
          contextVersionId: input.recommendationContextVersionId,
          context: recommendationContext,
          configuration,
          requestedCount: input.requestedCount,
          jobId: input.jobId,
          actorId: input.actorId,
          now,
        });
        const sourceReleaseId =
          `commercial-dataforseo:${commercial.provider.requestFingerprint}`;
        const projectTerms = Object.freeze([
          ...recommendationContext.keywords,
          ...recommendationContext.products,
        ]);
        const candidates = await mapConcurrent(
          commercial.candidates,
          websiteFetchConcurrency,
          async (candidate) =>
            buildLocalProductRecommendationEvidenceCandidate({
              context: scope,
              evidence: {
                domain: candidate.hostnameAscii,
                backlinkCount: candidate.provider.backlinkCount ?? 0,
                rank: candidate.provider.rank,
                spamScore: candidate.provider.spamScore,
                countryCode: null,
              },
              sourceReleaseId,
              acquiredAt: commercial.provider.acquiredAt,
              locationCode: recommendationContext.countryCode,
              languageCode: recommendationContext.locale,
              projectTerms,
              existingHostname: false,
              existingBacklink: false,
              previouslyExcluded: false,
              duplicateDomain: false,
              safeFetch,
            }),
        );
        return Object.freeze({
          candidates,
          provider: Object.freeze(
            commercial.provider satisfies RecommendationProviderExecutionSummary,
          ),
        });
      } finally {
        await clearSessionTenant(providerClient).catch(() => undefined);
        providerClient.release();
      }
    },

    async store(input) {
      const scope = scopeFrom(input);
      return withBacklinkTenantTransaction(
        options.pool,
        scope,
        async (client) => {
          const current = await client.query(
            `SELECT id
               FROM backlink_project_context_snapshots
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3
              ORDER BY snapshot_version DESC LIMIT 1`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
            ],
          );
          if (
            current.rows[0]?.id !== input.recommendationContextVersionId
          ) {
            await client.query(
              `UPDATE backlink_recommendations
                  SET status='stale_context',updated_at=now(),
                      updated_by=$5,version=version+1
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND recommendation_context_version_id=$4
                  AND status IN (
                    'candidate_raw','evaluating','ready','shown'
                  )`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                input.actorId,
              ],
            );
            await client.query(
              `UPDATE backlink_recommendation_inventory
                  SET status='stale_context',updated_at=now(),
                      updated_by=$5,version=version+1
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND recommendation_context_version_id=$4
                  AND status IN ('ready','claimed','shown')`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                input.actorId,
              ],
            );
            await client.query(
              `UPDATE backlink_commercial_discovery_blueprints
                  SET status='stale_context'
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND project_context_version_id=$4
                  AND status='active'`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
              ],
            );
            await client.query(
              `UPDATE backlink_commercial_discovery_batches
                  SET status='stale_context',
                      pause_reason='stale_context',
                      finished_at=COALESCE(finished_at,now())
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND project_context_version_id=$4
                  AND status IN (
                    'running','completed','paused','unavailable'
                  )`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
              ],
            );
            await client.query(
              `UPDATE backlink_commercial_candidates
                  SET state='stale_context',updated_at=now(),
                      updated_by=$5,version=version+1
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND project_context_version_id=$4
                  AND state NOT IN ('published','stale_context')`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                input.actorId,
              ],
            );
            await client.query(
              `UPDATE backlink_jobs
                  SET status='success',step='stale_context',
                      progress=100,result_summary=$5::jsonb,
                      finished_at=now(),updated_at=now(),version=version+1
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3 AND id=$4`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.jobId,
                JSON.stringify({
                  addedCount: 0,
                  staleContext: true,
                  provider: input.provider,
                  evaluation: input.evaluationSummary,
                }),
              ],
            );
            return { addedCount: 0 };
          }

          let addedCount = 0;
          for (const recommendation of input.recommendations) {
            const domain = createRecommendationDomainKey(
              recommendation.hostnameAscii,
            );
            const commercialCandidate = await client.query(
              `SELECT id,source_types AS "sourceTypes",
                      static_assessment AS "staticAssessment",
                      gate_decision AS "gateDecision",
                      commercial_score AS "commercialScore",
                      provider_collected_at AS "providerCollectedAt"
                 FROM backlink_commercial_candidates
                WHERE organization_id=$1 AND workspace_id=$2
                  AND website_project_id=$3
                  AND project_context_version_id=$4
                  AND canonical_domain=$5
                  AND state='candidate_ready'
                LIMIT 1`,
              [
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                domain.registrableDomain,
              ],
            );
            const commercialRow = commercialCandidate.rows[0];
            const parsedCommercialScore = storedCommercialScoreSchema.safeParse(
              commercialRow?.commercialScore,
            );
            const prospectId = randomUUID();
            const recommendationId = randomUUID();
            const scoreId = randomUUID();
            const inventoryId = randomUUID();
            const prospect = await client.query(
              `WITH inserted AS (
                 INSERT INTO backlink_prospects (
                   id,organization_id,workspace_id,website_project_id,
                   recommendation_context_version_id,hostname_ascii,
                   registrable_domain,normalization_version,
                   created_by,updated_by
                 ) VALUES (
                   $1,$2,$3,$4,$5,$6,$7,$8,$9,$9
                 )
                 ON CONFLICT (
                   organization_id,workspace_id,website_project_id,
                   recommendation_context_version_id,hostname_ascii
                 ) DO NOTHING
                 RETURNING id
               )
               SELECT id FROM inserted
               UNION ALL
               SELECT id FROM backlink_prospects
                WHERE organization_id=$2 AND workspace_id=$3
                  AND website_project_id=$4
                  AND recommendation_context_version_id=$5
                  AND hostname_ascii=$6
               LIMIT 1`,
              [
                prospectId,
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                input.recommendationContextVersionId,
                domain.hostnameAscii,
                domain.registrableDomain,
                domain.normalizationVersion,
                input.actorId,
              ],
            );
            const storedProspectId = prospect.rows[0]?.id;
            if (storedProspectId === undefined) continue;
            const recommendationRow = await client.query(
              `WITH inserted AS (
                 INSERT INTO backlink_recommendations (
                   id,organization_id,workspace_id,website_project_id,
                   prospect_id,recommendation_context_version_id,status,
                   created_by,updated_by
                 ) VALUES ($1,$2,$3,$4,$5,$6,'ready',$7,$7)
                 ON CONFLICT (
                   organization_id,workspace_id,website_project_id,
                   prospect_id,recommendation_context_version_id
                 ) DO NOTHING
                 RETURNING id,status
               )
               SELECT id,status FROM inserted
               UNION ALL
               SELECT id,status FROM backlink_recommendations
                WHERE organization_id=$2 AND workspace_id=$3
                  AND website_project_id=$4 AND prospect_id=$5
                  AND recommendation_context_version_id=$6
               LIMIT 1`,
              [
                recommendationId,
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                storedProspectId,
                input.recommendationContextVersionId,
                input.actorId,
              ],
            );
            const storedRecommendation = recommendationRow.rows[0];
            if (
              storedRecommendation === undefined
              || !["ready", "shown"].includes(
                String(storedRecommendation.status),
              )
            ) {
              continue;
            }
            const storedRecommendationId = String(storedRecommendation.id);
            const commercialScore = parsedCommercialScore.success
              ? parsedCommercialScore.data
              : null;
            const score = commercialScore ?? recommendation.score;
            const weights = commercialScore
              ? Object.fromEntries(commercialScore.components.map((component) => [
                  component.id,
                  component.weight,
                ]))
              : recommendation.score.weights;
            const scoreEvidence = {
              sourceReleaseId: recommendation.sourceReleaseId,
              evidencePolicyVersion: recommendation.evidencePolicyVersion,
              provider: {
                providerId: "dataforseo",
                source: input.provider.source,
                acquiredAt: input.provider.acquiredAt,
                costMicros: input.provider.costMicros,
                requestFingerprint: input.provider.requestFingerprint,
              },
              gateDecision: recommendation.gateDecision,
              missingEvidenceKeys: recommendation.missingEvidenceKeys,
              commercial: commercialScore
                ? {
                    sourceTypes: commercialRow?.sourceTypes,
                    staticAssessment: commercialRow?.staticAssessment,
                    gateDecision: commercialRow?.gateDecision,
                    hitGates: commercialScore.hitGates,
                    missingEvidence: commercialScore.missingEvidence,
                  }
                : null,
            };
            await client.query(
              `INSERT INTO backlink_recommendation_scores (
                 id,organization_id,workspace_id,website_project_id,
                 recommendation_id,prospect_id,
                 recommendation_context_version_id,score_model_version,
                 rule_version,total_score,components,weights,evidence,
                 generated_at,created_by
               )
               SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,
                      $12::jsonb,$13::jsonb,$14,$15
                WHERE NOT EXISTS (
                  SELECT 1 FROM backlink_recommendation_scores
                   WHERE organization_id=$2 AND workspace_id=$3
                     AND website_project_id=$4
                     AND recommendation_id=$5
                     AND evidence->>'sourceReleaseId'=$16
                )`,
              [
                scoreId,
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                storedRecommendationId,
                storedProspectId,
                input.recommendationContextVersionId,
                score.scoreModelVersion,
                score.ruleVersion,
                score.total,
                JSON.stringify(score.components),
                JSON.stringify(weights),
                JSON.stringify(scoreEvidence),
                commercialRow?.providerCollectedAt
                  ?? input.provider.acquiredAt,
                input.actorId,
                recommendation.sourceReleaseId,
              ],
            );
            const inventory = await client.query(
              `INSERT INTO backlink_recommendation_inventory (
                 id,organization_id,workspace_id,website_project_id,
                 recommendation_id,prospect_id,
                 recommendation_context_version_id,status,
                 created_by,updated_by
               ) VALUES ($1,$2,$3,$4,$5,$6,$7,'ready',$8,$8)
               ON CONFLICT (
                 organization_id,workspace_id,website_project_id,
                 recommendation_id,recommendation_context_version_id
               ) DO NOTHING
               RETURNING id`,
              [
                inventoryId,
                scope.organizationId,
                scope.workspaceId,
                scope.websiteProjectId,
                storedRecommendationId,
                storedProspectId,
                input.recommendationContextVersionId,
                input.actorId,
              ],
            );
            if (inventory.rows[0] !== undefined) addedCount += 1;
            if (commercialRow?.id !== undefined) {
              await client.query(
                `UPDATE backlink_commercial_candidates
                    SET recommendation_id=$5,prospect_id=$6,
                        state='contact_enrichment',updated_at=now(),
                        updated_by=$7,version=version+1
                  WHERE organization_id=$1 AND workspace_id=$2
                    AND website_project_id=$3 AND id=$4
                    AND state='candidate_ready'`,
                [
                  scope.organizationId,
                  scope.workspaceId,
                  scope.websiteProjectId,
                  commercialRow.id,
                  storedRecommendationId,
                  storedProspectId,
                  input.actorId,
                ],
              );
            }
          }
          await client.query(
            `UPDATE backlink_jobs
                SET status='success',step=$5,progress=100,
                    result_summary=$6::jsonb,error=NULL,
                    finished_at=now(),updated_at=now(),version=version+1
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3 AND id=$4`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
              input.jobId,
              addedCount > 0
                ? "ready_inventory_stored"
                : "no_evaluable_recommendations",
              JSON.stringify({
                addedCount,
                provider: input.provider,
                evaluation: input.evaluationSummary,
              }),
            ],
          );
          return { addedCount };
        },
      );
    },
  });
}
