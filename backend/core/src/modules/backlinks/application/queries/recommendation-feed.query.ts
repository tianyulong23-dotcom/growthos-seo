import {
  createHash,
  createHmac,
  timingSafeEqual,
  type BinaryLike,
} from "node:crypto";

import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";

export const recommendationFeedSorts = [
  "released_desc",
  "released_asc",
  "domain_asc",
  "traffic_desc",
  "rank_desc",
  "spam_asc",
] as const;

export type RecommendationFeedSort = (typeof recommendationFeedSorts)[number];

export type RecommendationFeedFilters = Readonly<{
  batchId?: string | undefined;
  recommendedOnly?: boolean | undefined;
  category?: string | undefined;
  trafficMin?: number | undefined;
  trafficMax?: number | undefined;
  rankMin?: number | undefined;
  rankMax?: number | undefined;
  spamMin?: number | undefined;
  spamMax?: number | undefined;
  sort?: RecommendationFeedSort | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  domainSearch?: string | undefined;
}>;

export type NormalizedRecommendationFeedFilters = Readonly<{
  batchId: string | null;
  recommendedOnly: boolean;
  category: string | null;
  trafficMin: number | null;
  trafficMax: number | null;
  rankMin: number | null;
  rankMax: number | null;
  spamMin: number | null;
  spamMax: number | null;
  sort: RecommendationFeedSort;
  cursor: string | null;
  limit: number;
  domainSearch: string | null;
}>;

export type RecommendationFeedScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
}>;

export type RecommendationFeedBinding = Readonly<{
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  generationContractId: string;
  inputPinId: string;
}>;

export type RecommendationFeedCursorPosition = Readonly<{
  itemId: string;
  contactPriority?: number;
  releasedAt: string;
  canonicalDomain: string;
  trafficOrganicEtv: number | null;
  authorityRank: number | null;
  spamScore: number | null;
}>;

export type RecommendationFeedItem = Readonly<{
  itemId: string;
  domain: string;
  displayUrl: string;
  recommended: boolean;
  recommendationReasons: readonly string[];
  category: string | null;
  metrics: Readonly<{
    targetMarketOrganicTraffic: number | null;
    dataForSeoRank: number | null;
    spamScore: number | null;
    ahrefsDr?: number | null;
    libraryMonthlyTraffic?: number | null;
  }>;
  contact: Readonly<{
    email: string | null;
    contactPage: string | null;
    outcome: string;
  }>;
  opportunity: Readonly<{
    opportunityId: string | null;
    businessStage: string | null;
    managementStatus: string | null;
    outcomeStatus: string | null;
    createdByCurrentUser: boolean;
  }>;
  archived: false;
  releasedAt: string;
}>;

export type RecommendationFeedLatestGeneration = Readonly<{
  generationContractId: string;
  visiblePoolGeneration: number;
  jobState: string;
  progress: number;
  discoveryResult: string;
  contactPreparation: string;
  releaseResult: string;
  effectiveUniqueCandidateCount: number;
  admittedCount: number;
  releasedCount: number;
  terminalReason: string | null;
  retrySafe: boolean;
}>;

export type RecommendationFeedReleasedPool = Readonly<{
  generationCount: number;
  oldestVisiblePoolGeneration: number | null;
  newestVisiblePoolGeneration: number | null;
  filterOptions?: Readonly<{
    batches: readonly Readonly<{
      batchId: string;
      batchOrdinal: number;
      visiblePoolGeneration: number;
      releasedAt: string;
      count: number;
    }>[];
    categories: readonly string[];
    hasUncategorized: boolean;
  }> | undefined;
}>;

export type RecommendationFeedDecodedCursor = Readonly<{
  binding: RecommendationFeedBinding;
  position: RecommendationFeedCursorPosition;
}>;

type RecommendationFeedRepositoryListInput = RecommendationFeedScope &
  Readonly<{
    filters: NormalizedRecommendationFeedFilters;
    cursor: RecommendationFeedDecodedCursor | null;
  }>;

type RecommendationFeedRepositoryExportInput = RecommendationFeedScope &
  Readonly<{
    filters: NormalizedRecommendationFeedFilters;
    selectedItemIds: readonly string[];
  }>;

export type RecommendationFeedRepository = Readonly<{
  list(input: RecommendationFeedRepositoryListInput): Promise<
    Readonly<{
      items: readonly RecommendationFeedItem[];
      binding: RecommendationFeedBinding | null;
      releasedPool: RecommendationFeedReleasedPool;
      latestGeneration: RecommendationFeedLatestGeneration | null;
      totalCount: number;
      nextPosition: RecommendationFeedCursorPosition | null;
    }>
  >;
  exportItems(
    input: RecommendationFeedRepositoryExportInput,
  ): Promise<readonly RecommendationFeedItem[]>;
}>;

function invalidRequest(message: string): never {
  throw new BacklinkError({
    code: backlinkErrorCodes.invalidRequest,
    message,
  });
}

function normalizeOptionalText(
  value: string | undefined,
  field: string,
  options: Readonly<{ lowerCase?: boolean }> = {},
): string | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalidRequest(`${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  return options.lowerCase ? normalized.toLowerCase() : normalized;
}

function normalizeMetric(
  value: number | undefined,
  field: string,
  maximum?: number,
): number | null {
  if (value === undefined) {
    return null;
  }
  if (
    !Number.isFinite(value) ||
    value < 0 ||
    (maximum !== undefined && value > maximum)
  ) {
    return invalidRequest(`${field} is outside the supported range.`);
  }
  return value;
}

function assertRange(
  minimum: number | null,
  maximum: number | null,
  field: string,
): void {
  if (minimum !== null && maximum !== null && minimum > maximum) {
    invalidRequest(`${field} minimum cannot exceed its maximum.`);
  }
}

export function normalizeRecommendationFeedFilters(
  input: RecommendationFeedFilters,
): NormalizedRecommendationFeedFilters {
  const batchId = normalizeOptionalText(input.batchId, "batchId");
  if (batchId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(batchId)) {
    invalidRequest("batchId must be a UUID.");
  }
  const limit = input.limit ?? 35;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    invalidRequest("limit must be an integer between 1 and 100.");
  }
  if (
    input.sort !== undefined &&
    !recommendationFeedSorts.includes(input.sort)
  ) {
    invalidRequest("sort is not supported.");
  }

  const trafficMin = normalizeMetric(input.trafficMin, "trafficMin");
  const trafficMax = normalizeMetric(input.trafficMax, "trafficMax");
  const rankMin = normalizeMetric(input.rankMin, "rankMin");
  const rankMax = normalizeMetric(input.rankMax, "rankMax");
  const spamMin = normalizeMetric(input.spamMin, "spamMin", 100);
  const spamMax = normalizeMetric(input.spamMax, "spamMax", 100);
  assertRange(trafficMin, trafficMax, "traffic");
  assertRange(rankMin, rankMax, "rank");
  assertRange(spamMin, spamMax, "spam");

  return Object.freeze({
    batchId,
    recommendedOnly: input.recommendedOnly ?? false,
    category: normalizeOptionalText(input.category, "category"),
    trafficMin,
    trafficMax,
    rankMin,
    rankMax,
    spamMin,
    spamMax,
    sort: input.sort ?? "released_desc",
    cursor: normalizeOptionalText(input.cursor, "cursor"),
    limit,
    domainSearch: normalizeOptionalText(input.domainSearch, "domainSearch", {
      lowerCase: true,
    }),
  });
}

function canonicalFilterValue(
  filters: NormalizedRecommendationFeedFilters,
): object {
  return {
    batchId: filters.batchId,
    recommendedOnly: filters.recommendedOnly,
    category: filters.category,
    trafficMin: filters.trafficMin,
    trafficMax: filters.trafficMax,
    rankMin: filters.rankMin,
    rankMax: filters.rankMax,
    spamMin: filters.spamMin,
    spamMax: filters.spamMax,
    sort: filters.sort,
    limit: filters.limit,
    domainSearch: filters.domainSearch,
  };
}

export function recommendationFeedFilterFingerprint(
  filters: NormalizedRecommendationFeedFilters,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalFilterValue(filters)))
    .digest("hex");
}

type RecommendationFeedCursorPayload = Readonly<{
  version: 1;
  scope: RecommendationFeedScope;
  binding: RecommendationFeedBinding;
  filterFingerprint: string;
  position: RecommendationFeedCursorPosition;
}>;

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

function parseCursorPayload(
  encodedPayload: string,
): RecommendationFeedCursorPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
  } catch {
    return invalidRequest("Recommendation feed cursor is malformed.");
  }

  if (typeof payload !== "object" || payload === null) {
    return invalidRequest("Recommendation feed cursor is malformed.");
  }
  const candidate = payload as Partial<RecommendationFeedCursorPayload>;
  const cursorScope = candidate.scope;
  const cursorBinding = candidate.binding;
  const position = candidate.position;
  if (
    candidate.version !== 1 ||
    !isNonBlank(candidate.filterFingerprint) ||
    !isNonBlank(cursorScope?.organizationId) ||
    !isNonBlank(cursorScope.workspaceId) ||
    !isNonBlank(cursorScope.websiteProjectId) ||
    !isNonBlank(cursorScope.actorId) ||
    !isNonBlank(cursorBinding?.recommendationContextVersionId) ||
    !Number.isInteger(cursorBinding.visiblePoolGeneration) ||
    !isNonBlank(cursorBinding.generationContractId) ||
    !isNonBlank(cursorBinding.inputPinId) ||
    !isNonBlank(position?.itemId) ||
    !isNonBlank(position.releasedAt) ||
    Number.isNaN(Date.parse(position.releasedAt)) ||
    !isNonBlank(position.canonicalDomain) ||
    !isNullableFiniteNumber(position.trafficOrganicEtv) ||
    !isNullableFiniteNumber(position.authorityRank) ||
    !isNullableFiniteNumber(position.spamScore) ||
    (position.contactPriority !== undefined &&
      ![0, 1, 2].includes(position.contactPriority))
  ) {
    return invalidRequest("Recommendation feed cursor is malformed.");
  }
  return candidate as RecommendationFeedCursorPayload;
}

function signaturesMatch(actual: Buffer, expected: Buffer): boolean {
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createRecommendationFeedCursorCodec(signingKey: BinaryLike) {
  const sign = (value: string): Buffer =>
    createHmac("sha256", signingKey).update(value).digest();

  return Object.freeze({
    encode(
      input: Readonly<{
        scope: RecommendationFeedScope;
        binding: RecommendationFeedBinding;
        filterFingerprint: string;
        position: RecommendationFeedCursorPosition;
      }>,
    ): string {
      const encodedPayload = Buffer.from(
        JSON.stringify({
          version: 1,
          ...input,
        } satisfies RecommendationFeedCursorPayload),
      ).toString("base64url");
      return `${encodedPayload}.${sign(encodedPayload).toString("base64url")}`;
    },

    decode(
      cursor: string,
      expected: Readonly<{
        scope: RecommendationFeedScope;
        filterFingerprint: string;
      }>,
    ): RecommendationFeedDecodedCursor {
      const parts = cursor.split(".");
      if (
        parts.length !== 2 ||
        !isNonBlank(parts[0]) ||
        !isNonBlank(parts[1])
      ) {
        return invalidRequest("Recommendation feed cursor is malformed.");
      }

      let suppliedSignature: Buffer;
      try {
        suppliedSignature = Buffer.from(parts[1], "base64url");
      } catch {
        return invalidRequest("Recommendation feed cursor is malformed.");
      }
      if (!signaturesMatch(suppliedSignature, sign(parts[0]))) {
        return invalidRequest(
          "Recommendation feed cursor signature is invalid.",
        );
      }

      const payload = parseCursorPayload(parts[0]);
      if (
        payload.scope.organizationId !== expected.scope.organizationId ||
        payload.scope.workspaceId !== expected.scope.workspaceId ||
        payload.scope.websiteProjectId !== expected.scope.websiteProjectId ||
        payload.scope.actorId !== expected.scope.actorId ||
        payload.filterFingerprint !== expected.filterFingerprint
      ) {
        return invalidRequest("Recommendation feed cursor scope is invalid.");
      }
      return Object.freeze({
        binding: payload.binding,
        position: payload.position,
      });
    },
  });
}

function scopeFrom(context: ResolvedProjectContext): RecommendationFeedScope {
  return Object.freeze({
    organizationId: context.tenant.organizationId,
    workspaceId: context.tenant.workspaceId,
    websiteProjectId: context.project.websiteProjectId,
    actorId: context.actor.userId,
  });
}

function csvCell(value: string | number | boolean | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@]/u.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function recommendationFeedCsv(
  items: readonly RecommendationFeedItem[],
): string {
  const rows = [
    [
      "domain",
      "displayUrl",
      "recommended",
      "reasons",
      "category",
      "organicTraffic",
      "dataForSeoRank",
      "spamScore",
      "contactEmail",
      "contactPage",
      "contactOutcome",
      "opportunityId",
      "opportunityStage",
      "releasedAt",
    ],
    ...items.map((item) => [
      item.domain,
      item.displayUrl,
      item.recommended,
      item.recommendationReasons.join("; "),
      item.category,
      item.metrics.targetMarketOrganicTraffic,
      item.metrics.dataForSeoRank,
      item.metrics.spamScore,
      item.contact.email,
      item.contact.contactPage,
      item.contact.outcome,
      item.opportunity.opportunityId,
      item.opportunity.businessStage,
      item.releasedAt,
    ]),
  ];
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

export function createRecommendationFeedQuery(
  repository: RecommendationFeedRepository,
  options: Readonly<{ cursorSigningKey: BinaryLike }>,
) {
  const cursorCodec = createRecommendationFeedCursorCodec(
    options.cursorSigningKey,
  );

  return Object.freeze({
    async list(
      context: ResolvedProjectContext,
      input: RecommendationFeedFilters,
    ) {
      const filters = normalizeRecommendationFeedFilters(input);
      const scope = scopeFrom(context);
      const filterFingerprint = recommendationFeedFilterFingerprint(filters);
      const cursor =
        filters.cursor === null
          ? null
          : cursorCodec.decode(filters.cursor, {
              scope,
              filterFingerprint,
            });
      const result = await repository.list({
        ...scope,
        filters,
        cursor,
      });
      if (result.nextPosition !== null && result.binding === null) {
        throw new BacklinkError({
          code: backlinkErrorCodes.internal,
          message: "Recommendation feed cursor requires a generation binding.",
        });
      }
      return Object.freeze({
        items: result.items,
        releasedPool: result.releasedPool,
        latestGeneration: result.latestGeneration,
        totalCount: result.totalCount,
        nextCursor:
          result.nextPosition === null || result.binding === null
            ? null
            : cursorCodec.encode({
                scope,
                binding: result.binding,
                filterFingerprint,
                position: result.nextPosition,
              }),
      });
    },

    async export(
      context: ResolvedProjectContext,
      input: RecommendationFeedFilters &
        Readonly<{ selectedItemIds?: readonly string[] | undefined }>,
    ) {
      if (input.cursor !== undefined) {
        invalidRequest("cursor is not supported for recommendation export.");
      }
      const filters = normalizeRecommendationFeedFilters({
        recommendedOnly: input.recommendedOnly,
        category: input.category,
        trafficMin: input.trafficMin,
        trafficMax: input.trafficMax,
        rankMin: input.rankMin,
        rankMax: input.rankMax,
        spamMin: input.spamMin,
        spamMax: input.spamMax,
        sort: input.sort,
        limit: 100,
        domainSearch: input.domainSearch,
      });
      const selectedItemIds = [...new Set(input.selectedItemIds ?? [])];
      if (selectedItemIds.length > 1_000) {
        invalidRequest(
          "Recommendation export supports at most 1000 selected items.",
        );
      }
      const items = await repository.exportItems({
        ...scopeFrom(context),
        filters,
        selectedItemIds,
      });
      return Object.freeze({
        contentType: "text/csv" as const,
        fileName: "backlink-recommendations.csv",
        content: recommendationFeedCsv(items),
      });
    },
  });
}

export type RecommendationFeedQuery = ReturnType<
  typeof createRecommendationFeedQuery
>;
