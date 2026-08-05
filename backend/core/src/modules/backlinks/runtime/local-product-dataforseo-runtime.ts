import { randomUUID } from "node:crypto";

import { load } from "cheerio";
import { z } from "zod";

import { DataForSeoAdapter } from "../adapters/dataforseo/adapter.js";
import { DataForSeoClient } from "../adapters/dataforseo/client.js";
import { createOfficialDataForSeoRuntimeFactory } from "../adapters/dataforseo/official-runtime.js";
import { SafeFetchAdapter } from "../adapters/http/safe-fetch.adapter.js";
import {
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import { DataForSeoCallPolicy } from "../application/policies/dataforseo-call.policy.js";
import { DataForSeoRequestService } from "../application/services/dataforseo-request.service.js";
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
const configurationSchema = z.object({
  credentialSecretRef: localProductDataForSeoCredentialReferenceSchema,
  endpointAllowlist: localProductDataForSeoEndpointAllowlistSchema,
  timeoutMs: z.number().int().positive().max(120_000),
  estimatedCostMicros: z.number().int().positive().max(100_000_000),
  absoluteBudgetMicros: z.number().int().positive().max(100_000_000),
  maxPaidCalls: z.number().int().min(1).max(1_000),
  candidateLimit: z.number().int().min(10).max(100),
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

function hostnameFromUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    return createRecommendationDomainKey(new URL(value).hostname).hostnameAscii;
  } catch {
    return null;
  }
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
  const provider = new DataForSeoAdapter(new DataForSeoClient(
    {
      DATAFORSEO_ENABLED: true,
      DATAFORSEO_CREDENTIAL_SECRET_REF: configuration.credentialSecretRef,
      DATAFORSEO_REQUEST_TIMEOUT_MS: configuration.timeoutMs,
    },
    async () => JSON.parse(await secretStore.resolve({
      reference: credentialReference,
      context: {
        organizationId: "local-product",
        subjectProvider: "dataforseo",
      },
    })) as unknown,
    createOfficialDataForSeoRuntimeFactory(),
  ), now);

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
      let providerResult:
        Awaited<ReturnType<DataForSeoRequestService["execute"]>>;
      let recommendationContext: LocalProductRecommendationContext;
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
        recommendationContext = parseLocalProductRecommendationContext(
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
        const service = new DataForSeoRequestService({
          coordinator: repository,
          provider,
          gate,
          now,
        });
        providerResult = await service.execute({
          context: {
            ...scope,
            requestId: input.jobId,
            idempotencyKey: `dataforseo-refill:${input.jobId}`,
            budgetReservationId: input.jobId,
          },
          request: {
            target: recommendationContext.canonicalDomain,
            targetType: "domain",
            limit: configuration.candidateLimit,
          },
          intent: "DISCOVERY",
          refreshMode: "CACHE_PREFERRED",
          execution: "BACKGROUND",
          locationCode: recommendationContext.countryCode,
          languageCode: recommendationContext.locale,
          responseSchemaVersion:
            "dataforseo.backlinks-referring-domains.v1",
          usagePurpose: "recommendation_refill",
          projectContextVersion: recommendationContext.snapshotVersion,
          cacheSchemaVersion: 1,
          estimatedCostMicros: configuration.estimatedCostMicros,
        });
      } finally {
        await clearSessionTenant(providerClient).catch(() => undefined);
        providerClient.release();
      }

      if (providerResult.source === "refresh-pending") {
        throw new Error("DATAFORSEO_REFRESH_PENDING");
      }
      const sourceReleaseId =
        `dataforseo:${providerResult.snapshot.payloadHash}`;
      const providerSummary: RecommendationProviderExecutionSummary = {
        source: providerResult.source,
        acquiredAt: providerResult.snapshot.completedAt,
        costMicros: providerResult.snapshot.costMicros,
        requestFingerprint: providerResult.requestFingerprint,
      };
      const history = await withBacklinkTenantTransaction(
        options.pool,
        scope,
        async (client) => {
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
                     inventory.website_project_id,
                     inventory.recommendation_id)=
                    (r.organization_id,r.workspace_id,
                     r.website_project_id,r.id)
              WHERE p.organization_id=$1 AND p.workspace_id=$2
                AND p.website_project_id=$3
              GROUP BY p.hostname_ascii`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
            ],
          );
          const placements = await client.query(
            `SELECT normalized_source_url AS "sourceUrl"
               FROM backlink_placements
              WHERE organization_id=$1 AND workspace_id=$2
                AND website_project_id=$3`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
            ],
          );
          return {
            prospects: new Map(prospects.rows.map((row) => [
              String(row.hostname),
              row.previouslyExcluded === true,
            ])),
            placementHostnames: new Set(placements.rows.flatMap((row) => {
              const hostname = hostnameFromUrl(row.sourceUrl);
              return hostname === null ? [] : [hostname];
            })),
          };
        },
      );
      for (const targetUrl of recommendationContext.targetUrls) {
        const hostname = hostnameFromUrl(targetUrl);
        if (hostname !== null) history.placementHostnames.add(hostname);
      }

      const byRegistrableDomain = new Map<
        string,
        Readonly<{
          hostname: string;
          evidence: ReferringDomainEvidence;
        }>
      >();
      for (const item of providerResult.snapshot.referringDomains) {
        let key;
        try {
          key = createRecommendationDomainKey(item.domain);
        } catch {
          continue;
        }
        const prior = byRegistrableDomain.get(key.registrableDomain);
        if (
          prior === undefined
          || (item.rank ?? 0) > (prior.evidence.rank ?? 0)
          || (
            (item.rank ?? 0) === (prior.evidence.rank ?? 0)
            && item.backlinkCount > prior.evidence.backlinkCount
          )
        ) {
          byRegistrableDomain.set(key.registrableDomain, {
            hostname: key.hostnameAscii,
            evidence: item,
          });
        }
      }
      const selected = [...byRegistrableDomain.values()]
        .sort((left, right) =>
          (right.evidence.rank ?? 0) - (left.evidence.rank ?? 0)
          || right.evidence.backlinkCount - left.evidence.backlinkCount
          || left.hostname.localeCompare(right.hostname)
        )
        .slice(0, Math.min(
          configuration.candidateLimit,
          Math.max(10, input.requestedCount * 4),
        ));
      const projectTerms = Object.freeze([
        ...recommendationContext.keywords,
        ...recommendationContext.products,
      ]);
      const candidates = await mapConcurrent(
        selected,
        websiteFetchConcurrency,
        async (selectedCandidate) =>
          buildLocalProductRecommendationEvidenceCandidate({
            context: scope,
            evidence: selectedCandidate.evidence,
            sourceReleaseId,
            acquiredAt: providerResult.snapshot.completedAt,
            locationCode: recommendationContext.countryCode,
            languageCode: recommendationContext.locale,
            projectTerms,
            existingHostname:
              history.prospects.has(selectedCandidate.hostname),
            existingBacklink:
              history.placementHostnames.has(selectedCandidate.hostname),
            previouslyExcluded:
              history.prospects.get(selectedCandidate.hostname) === true,
            duplicateDomain: false,
            safeFetch,
          }),
      );
      return Object.freeze({
        candidates,
        provider: Object.freeze(providerSummary),
      });
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
                recommendation.score.scoreModelVersion,
                recommendation.score.ruleVersion,
                recommendation.score.total,
                JSON.stringify(recommendation.score.components),
                JSON.stringify(recommendation.score.weights),
                JSON.stringify(scoreEvidence),
                input.provider.acquiredAt,
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
