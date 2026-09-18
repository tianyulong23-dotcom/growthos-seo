import { allowedOutreachTargetSql } from "./outreach-target-predicate.js";
import { verifiedPublicContactSql } from "./verified-public-contact.sql.js";
import { observedContactPageSql } from "./observed-contact-page.sql.js";
import type {
  NormalizedRecommendationFeedFilters,
  RecommendationFeedBinding,
  RecommendationFeedCursorPosition,
  RecommendationFeedItem,
  RecommendationFeedLatestGeneration,
  RecommendationFeedReleasedPool,
  RecommendationFeedRepository,
  RecommendationFeedSort,
} from "../../application/queries/recommendation-feed.query.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../tenant-transaction.js";

type Scope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
}>;

type Row = Readonly<Record<string, unknown>>;

const sortSql: Readonly<Record<RecommendationFeedSort, string>> = {
  released_desc: "contact_priority DESC, released_at DESC, item_id DESC",
  released_asc: "released_at ASC, item_id ASC",
  domain_asc: "canonical_domain ASC, item_id ASC",
  traffic_desc:
    "traffic_organic_etv DESC NULLS LAST, canonical_domain ASC, item_id ASC",
  rank_desc:
    "authority_rank DESC NULLS LAST, canonical_domain ASC, item_id ASC",
  spam_asc: "spam_score ASC NULLS LAST, canonical_domain ASC, item_id ASC",
};

function invalidRequest(message: string): never {
  throw new BacklinkError({
    code: backlinkErrorCodes.invalidRequest,
    message,
  });
}

function conflict(message: string): never {
  throw new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message,
  });
}

function asNonBlank(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return conflict(`Recommendation feed ${field} is invalid.`);
  }
  return value;
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asCount(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    return conflict("Recommendation feed count is invalid.");
  }
  return number;
}

function asNullableGeneration(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    return conflict("Recommendation feed released generation is invalid.");
  }
  return number;
}

function asIsoDate(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return conflict(`Recommendation feed ${field} is invalid.`);
  }
  return date.toISOString();
}

function asStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }
  return Object.freeze(
    value.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    ),
  );
}

function bindingFrom(row: Row): RecommendationFeedBinding {
  const visiblePoolGeneration = Number(row.visiblePoolGeneration);
  if (
    !Number.isSafeInteger(visiblePoolGeneration) ||
    visiblePoolGeneration <= 0
  ) {
    return conflict("Recommendation feed generation binding is invalid.");
  }
  return Object.freeze({
    recommendationContextVersionId: asNonBlank(
      row.recommendationContextVersionId,
      "context binding",
    ),
    visiblePoolGeneration,
    generationContractId: asNonBlank(
      row.generationContractId,
      "generation binding",
    ),
    inputPinId: asNonBlank(row.inputPinId, "input binding"),
  });
}

function sameBinding(
  left: RecommendationFeedBinding,
  right: RecommendationFeedBinding,
): boolean {
  return (
    left.recommendationContextVersionId ===
      right.recommendationContextVersionId &&
    left.visiblePoolGeneration === right.visiblePoolGeneration &&
    left.generationContractId === right.generationContractId &&
    left.inputPinId === right.inputPinId
  );
}

async function readBinding(
  client: BacklinkTransactionClient,
  scope: Scope,
): Promise<RecommendationFeedBinding | null> {
  const result = await client.query(
    `SELECT recommendation_context_version_id
              "recommendationContextVersionId",
            visible_pool_generation "visiblePoolGeneration",
            generation_contract_id "generationContractId",
            input_pin_id "inputPinId", migration_state "migrationState"
       FROM backlink_recommendation_pool_project_contracts
      WHERE organization_id=$1
        AND workspace_id=$2
        AND website_project_id=$3
        AND pool_contract_version='recommendation-pool.v2'
        AND migration_state IN ('V2_READY','V2_ACTIVE','V2_MAINTENANCE_READ_ONLY')
      LIMIT 1`,
    [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return conflict("Recommendation Pool V2 is not active for this project.");
  }
  if (row.migrationState === "V2_READY" && row.generationContractId === null) {
    return null;
  }
  return bindingFrom(row);
}

function escapedLikeValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function addFilterPredicates(
  filters: NormalizedRecommendationFeedFilters,
  values: unknown[],
): string[] {
  const predicates: string[] = [];
  const add = (sql: string, value: unknown): void => {
    values.push(value);
    predicates.push(sql.replace("?", `$${values.length}`));
  };
  if (filters.recommendedOnly) {
    predicates.push("recommended=true");
  }
  if (filters.batchId !== null) {
    add("batch_id=?", filters.batchId);
  }
  if (filters.category === "__uncategorized__") {
    predicates.push("primary_category IS NULL");
  } else if (filters.category !== null) {
    add("primary_category=?", filters.category);
  }
  if (filters.trafficMin !== null) {
    add("traffic_organic_etv>=?", filters.trafficMin);
  }
  if (filters.trafficMax !== null) {
    add("traffic_organic_etv<=?", filters.trafficMax);
  }
  if (filters.rankMin !== null) {
    add("authority_rank>=?", filters.rankMin);
  }
  if (filters.rankMax !== null) {
    add("authority_rank<=?", filters.rankMax);
  }
  if (filters.spamMin !== null) {
    add("spam_score>=?", filters.spamMin);
  }
  if (filters.spamMax !== null) {
    add("spam_score<=?", filters.spamMax);
  }
  if (filters.domainSearch !== null) {
    add(
      "canonical_domain ILIKE '%' || ? || '%' ESCAPE '\\'",
      escapedLikeValue(filters.domainSearch),
    );
  }
  return predicates;
}

function domainTieClause(
  position: RecommendationFeedCursorPosition,
  values: unknown[],
): string {
  values.push(position.canonicalDomain, position.itemId);
  return (
    `(canonical_domain>$${values.length - 1} OR ` +
    `(canonical_domain=$${values.length - 1} ` +
    `AND item_id>$${values.length}::uuid))`
  );
}

function cursorPredicate(
  sort: RecommendationFeedSort,
  position: RecommendationFeedCursorPosition,
  values: unknown[],
): string {
  if (sort === "released_desc" || sort === "released_asc") {
    values.push(position.releasedAt, position.itemId);
    const comparison = sort === "released_desc" ? "<" : ">";
    const released = (
      `(released_at${comparison}$${values.length - 1}::timestamptz OR ` +
      `(released_at=$${values.length - 1}::timestamptz ` +
      `AND item_id${comparison}$${values.length}::uuid))`
    );
    if (sort === "released_asc") return released;
    if (position.contactPriority === undefined) {
      return invalidRequest("Recommendation feed cursor is stale. Refresh the feed.");
    }
    values.push(position.contactPriority);
    return `(contact_priority<$${values.length} OR ` +
      `(contact_priority=$${values.length} AND ${released}))`;
  }
  if (sort === "domain_asc") {
    return domainTieClause(position, values);
  }

  const metric =
    sort === "traffic_desc"
      ? "traffic_organic_etv"
      : sort === "rank_desc"
        ? "authority_rank"
        : "spam_score";
  const metricValue =
    sort === "traffic_desc"
      ? position.trafficOrganicEtv
      : sort === "rank_desc"
        ? position.authorityRank
        : position.spamScore;
  const tie = domainTieClause(position, values);
  if (metricValue === null) {
    return `(${metric} IS NULL AND ${tie})`;
  }
  values.push(metricValue);
  const metricParameter = `$${values.length}`;
  const comparison = sort === "spam_asc" ? ">" : "<";
  return (
    `(${metric}${comparison}${metricParameter} OR ${metric} IS NULL OR ` +
    `(${metric}=${metricParameter} AND ${tie}))`
  );
}

function visibleCte(): string {
  return `visible AS (
    SELECT item.id item_id,
           batch.id batch_id,
           batch.batch_ordinal,
           publication.visible_pool_generation,
           item.canonical_domain,
           item.recommended,
           item.recommendation_reason_codes,
           item.primary_category,
           item.traffic_organic_etv,
           item.authority_rank,
           item.spam_score,
           item.resource_library_snapshot,
           COALESCE(item.contact_email_at_release,contact.normalized_email)
             contact_email_at_release,
           CASE
             WHEN NULLIF(trim(COALESCE(item.contact_email_at_release,
               contact.normalized_email)), '') IS NOT NULL THEN 2
             WHEN NULLIF(trim(COALESCE(contact.source_url,
               item.contact_page_url_at_release,contact_page.observed_page_url)), '') IS NOT NULL THEN 1
             ELSE 0
           END contact_priority,
           COALESCE(contact.source_url,item.contact_page_url_at_release,
             contact_page.observed_page_url)
             contact_page_url_at_release,
           CASE WHEN contact.normalized_email IS NOT NULL
                THEN 'PUBLIC_EMAIL_FOUND'
                ELSE item.contact_terminal_reason_at_release
           END contact_terminal_reason_at_release,
           publication.first_visible_at released_at,
           opportunity.id opportunity_id,
           opportunity.business_stage,
           opportunity.management_status,
           opportunity.outcome_status,
           opportunity.created_by opportunity_created_by
      FROM backlink_recommendation_user_publications publication
      JOIN backlink_recommendation_release_batches batch
        ON (batch.organization_id,batch.workspace_id,
            batch.website_project_id,batch.id,
            batch.recommendation_context_version_id,
            batch.visible_pool_generation)=
           (publication.organization_id,publication.workspace_id,
            publication.website_project_id,publication.batch_id,
            publication.recommendation_context_version_id,
            publication.visible_pool_generation)
      JOIN backlink_recommendation_release_batch_items item
        ON (item.organization_id,item.workspace_id,
            item.website_project_id,item.batch_id,
            item.recommendation_context_version_id,
            item.visible_pool_generation)=
           (batch.organization_id,batch.workspace_id,
            batch.website_project_id,batch.id,
            batch.recommendation_context_version_id,
            batch.visible_pool_generation)
      LEFT JOIN LATERAL (
        -- Later contact retries may enrich the feed without rewriting release facts.
        ${verifiedPublicContactSql("item")}
      ) contact ON item.contact_email_at_release IS NULL
      LEFT JOIN LATERAL (
        ${observedContactPageSql("item", "item.contact_terminal_reason_at_release")}
      ) contact_page ON item.contact_page_url_at_release IS NULL
      LEFT JOIN LATERAL (
        SELECT action.action_type
          FROM backlink_recommendation_user_item_actions action
         WHERE action.organization_id=item.organization_id
           AND action.workspace_id=item.workspace_id
           AND action.website_project_id=item.website_project_id
           AND action.recommendation_context_version_id=
               item.recommendation_context_version_id
           AND action.visible_pool_generation=item.visible_pool_generation
           AND action.user_id=$4
           AND action.batch_id=item.batch_id
           AND action.batch_item_id=item.id
           AND action.action_type IN ('ARCHIVED','UNARCHIVED')
         ORDER BY action.created_at DESC,action.id DESC
         LIMIT 1
      ) archive ON true
      LEFT JOIN LATERAL (
        SELECT candidate.id,
               candidate.business_stage,
               candidate.management_status,
               candidate.outcome_status,
               candidate.created_by
          FROM backlink_opportunities candidate
         WHERE candidate.organization_id=item.organization_id
           AND candidate.workspace_id=item.workspace_id
           AND candidate.website_project_id=item.website_project_id
           AND candidate.recommendation_id=item.recommendation_id
           AND candidate.prospect_id=item.prospect_id
           AND candidate.recommendation_context_version_id=
               item.recommendation_context_version_id
         ORDER BY candidate.created_at,candidate.id
         LIMIT 1
      ) opportunity ON true
     WHERE publication.organization_id=$1
       AND publication.workspace_id=$2
       AND publication.website_project_id=$3
       AND publication.user_id=$4
       AND publication.publication_state='ACTIVE'
       AND batch.state='AVAILABLE'
       AND item.pool_contract_version='recommendation-pool.v2'
       AND ${allowedOutreachTargetSql("item.canonical_domain")}
       AND COALESCE(archive.action_type,'UNARCHIVED')<>'ARCHIVED'
  )`;
}

function baseValues(scope: Scope): unknown[] {
  return [
    scope.organizationId,
    scope.workspaceId,
    scope.websiteProjectId,
    scope.actorId,
  ];
}

function generationFrom(row: Row): RecommendationFeedLatestGeneration {
  const progress = asCount(row.progress);
  if (progress > 100) {
    return conflict("Recommendation generation progress is invalid.");
  }
  return Object.freeze({
    generationContractId: asNonBlank(
      row.generationContractId,
      "latest generation id",
    ),
    visiblePoolGeneration: asCount(row.visiblePoolGeneration),
    jobState: asNonBlank(row.jobState, "latest generation job state"),
    progress,
    discoveryResult: asNonBlank(
      row.discoveryResult,
      "latest generation discovery result",
    ),
    contactPreparation: asNonBlank(
      row.contactPreparation,
      "latest generation contact preparation",
    ),
    releaseResult: asNonBlank(
      row.releaseResult,
      "latest generation release result",
    ),
    effectiveUniqueCandidateCount: asCount(row.effectiveUniqueCandidateCount),
    admittedCount: asCount(row.admittedCount),
    releasedCount: asCount(row.releasedCount),
    terminalReason:
      typeof row.terminalReason === "string" ? row.terminalReason : null,
    retrySafe: row.retrySafe === true,
  });
}

function releasedPoolFrom(row: Row): RecommendationFeedReleasedPool {
  const generationCount = asCount(row.releasedGenerationCount);
  const oldestVisiblePoolGeneration = asNullableGeneration(
    row.oldestReleasedGeneration,
  );
  const newestVisiblePoolGeneration = asNullableGeneration(
    row.newestReleasedGeneration,
  );
  if (
    (generationCount === 0 &&
      (oldestVisiblePoolGeneration !== null ||
        newestVisiblePoolGeneration !== null)) ||
    (generationCount > 0 &&
      (oldestVisiblePoolGeneration === null ||
        newestVisiblePoolGeneration === null ||
        oldestVisiblePoolGeneration > newestVisiblePoolGeneration))
  ) {
    return conflict("Recommendation feed released pool projection is invalid.");
  }
  return Object.freeze({
    generationCount,
    oldestVisiblePoolGeneration,
    newestVisiblePoolGeneration,
  });
}

async function readLatestGeneration(
  client: BacklinkTransactionClient,
  scope: Scope,
  allowMissing = false,
): Promise<RecommendationFeedLatestGeneration | null> {
  const result = await client.query(
    `SELECT generation.id "generationContractId",
            generation.visible_pool_generation "visiblePoolGeneration",
            CASE
              WHEN job.step='generation_staged'
                AND job.result_summary->>'workflowLaunchIdempotencyHash' IS NULL
              THEN 'PENDING_LAUNCH'
              ELSE upper(COALESCE(job.status,'queued'))
            END "jobState",
            COALESCE(job.progress,0) "progress",
            COALESCE(
              job.result_summary->>'discoveryTerminalReason',
              generation.discovery_terminal_reason,
              CASE
                WHEN job.step='generation_staged'
                  AND job.result_summary->>'workflowLaunchIdempotencyHash'
                        IS NULL
                  THEN 'PENDING'
                WHEN job.status IN ('failed','cancelled') THEN 'FAILED'
                WHEN job.status IN ('success','partial_success') THEN 'COMPLETED'
                ELSE 'IN_PROGRESS'
              END
            ) "discoveryResult",
            COALESCE(
              job.result_summary->>'contactPreparation',
              CASE
                WHEN job.status='running'
                  AND job.step='canonical_batch_preparation' THEN 'IN_PROGRESS'
                WHEN job.status IN ('success','partial_success') THEN 'COMPLETED'
                WHEN job.status IN ('failed','cancelled') THEN 'NOT_COMPLETED'
                ELSE 'PENDING'
              END
            ) "contactPreparation",
            COALESCE(job.result_summary->>'releaseResult','PENDING')
              "releaseResult",
            COALESCE(
              (job.result_summary->>'effectiveUniqueCandidateCount')::integer,
              generation.effective_unique_candidate_count,
              0
            ) "effectiveUniqueCandidateCount",
            COALESCE((job.result_summary->>'admittedCount')::integer,0)
              "admittedCount",
            COALESCE((job.result_summary->>'releasedCount')::integer,0)
              "releasedCount",
            CASE WHEN job.status IN ('success','partial_success','failed','cancelled')
              THEN COALESCE(
                job.result_summary->>'terminalReason',
                job.error->>'code'
              )
              ELSE NULL
            END "terminalReason",
            (
              job.status='failed'
              AND COALESCE(
                (job.result_summary->>'failureRetryable')::boolean,
                false
              )
            ) "retrySafe"
       FROM backlink_recommendation_generation_contracts generation
       LEFT JOIN LATERAL (
         SELECT candidate.status,candidate.step,candidate.progress,
                candidate.result_summary,candidate.error
           FROM backlink_jobs candidate
          WHERE candidate.organization_id=generation.organization_id
            AND candidate.workspace_id=generation.workspace_id
            AND candidate.website_project_id=generation.website_project_id
            AND candidate.job_type='recommendation_pool_v2_generation'
            AND candidate.result_summary->>'generationContractId'=
                generation.id::text
          ORDER BY candidate.created_at DESC,candidate.id DESC
          LIMIT 1
       ) job ON true
      WHERE generation.organization_id=$1
        AND generation.workspace_id=$2
        AND generation.website_project_id=$3
        AND generation.pool_contract_version='recommendation-pool.v2'
      ORDER BY generation.visible_pool_generation DESC
      LIMIT 1`,
    [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    if (allowMissing) return null;
    return conflict("Recommendation Pool V2 has no generation.");
  }
  return generationFrom(row);
}

function mapItem(row: Row, actorId: string): RecommendationFeedItem {
  const domain = asNonBlank(row.canonicalDomain, "domain");
  return Object.freeze({
    itemId: asNonBlank(row.itemId, "item id"),
    domain,
    displayUrl: `https://${domain}/`,
    recommended: row.recommended === true,
    recommendationReasons: asStrings(row.recommendationReasons),
    category:
      typeof row.primaryCategory === "string" ? row.primaryCategory : null,
    metrics: Object.freeze({
      targetMarketOrganicTraffic: asNumber(row.trafficOrganicEtv),
      ahrefsDr: asNumber(row.ahrefsDr),
      libraryMonthlyTraffic: asNumber(row.libraryMonthlyTraffic),
      dataForSeoRank: asNumber(row.authorityRank),
      spamScore: asNumber(row.spamScore),
    }),
    contact: Object.freeze({
      email: typeof row.contactEmail === "string" ? row.contactEmail : null,
      contactPage: typeof row.contactPage === "string" ? row.contactPage : null,
      outcome: asNonBlank(row.contactOutcome, "contact outcome"),
    }),
    opportunity: Object.freeze({
      opportunityId:
        typeof row.opportunityId === "string" ? row.opportunityId : null,
      businessStage:
        typeof row.businessStage === "string" ? row.businessStage : null,
      managementStatus:
        typeof row.managementStatus === "string" ? row.managementStatus : null,
      outcomeStatus:
        typeof row.outcomeStatus === "string" ? row.outcomeStatus : null,
      createdByCurrentUser: row.opportunityCreatedBy === actorId,
    }),
    archived: false as const,
    releasedAt: asIsoDate(row.releasedAt, "release time"),
  });
}

function positionFrom(row: Row): RecommendationFeedCursorPosition {
  return Object.freeze({
    contactPriority: Number(row.contactPriority ?? 0),
    itemId: asNonBlank(row.itemId, "item id"),
    // PostgreSQL timestamps retain microseconds; JS Date would lose the cursor tie.
    releasedAt: typeof row.cursorReleasedAt === "string"
      ? row.cursorReleasedAt : asIsoDate(row.releasedAt, "release time"),
    canonicalDomain: asNonBlank(row.canonicalDomain, "domain"),
    trafficOrganicEtv: asNumber(row.trafficOrganicEtv),
    authorityRank: asNumber(row.authorityRank),
    spamScore: asNumber(row.spamScore),
  });
}

async function listItems(
  client: BacklinkTransactionClient,
  input: Parameters<RecommendationFeedRepository["list"]>[0],
  binding: RecommendationFeedBinding,
) {
  if (input.cursor !== null && !sameBinding(input.cursor.binding, binding)) {
    invalidRequest("Recommendation feed cursor is stale.");
  }
  const values = baseValues(input);
  const filters = addFilterPredicates(input.filters, values);
  const filteredWhere =
    filters.length === 0 ? "" : `WHERE ${filters.join(" AND ")}`;
  const cursorWhere =
    input.cursor === null
      ? ""
      : `WHERE ${cursorPredicate(
          input.filters.sort,
          input.cursor.position,
          values,
        )}`;
  values.push(input.filters.limit + 1);
  const result = await client.query(
    `WITH ${visibleCte()},
     filtered AS (
       SELECT * FROM visible
       ${filteredWhere}
     )
     SELECT page.item_id "itemId",
            page.contact_priority "contactPriority",
            page.canonical_domain "canonicalDomain",
            page.recommended,
            page.recommendation_reason_codes "recommendationReasons",
            page.primary_category "primaryCategory",
            page.traffic_organic_etv "trafficOrganicEtv",
            page.authority_rank "authorityRank",
            page.spam_score "spamScore",
            page.resource_library_snapshot->>'ahrefsDr' "ahrefsDr",
            page.resource_library_snapshot->>'monthlyTraffic' "libraryMonthlyTraffic",
            page.contact_email_at_release "contactEmail",
            page.contact_page_url_at_release "contactPage",
            page.contact_terminal_reason_at_release "contactOutcome",
            page.opportunity_id "opportunityId",
            page.business_stage "businessStage",
            page.management_status "managementStatus",
            page.outcome_status "outcomeStatus",
            page.opportunity_created_by "opportunityCreatedBy",
            page.released_at "releasedAt",
            to_char(page.released_at AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "cursorReleasedAt",
            (SELECT count(DISTINCT visible_pool_generation) FROM visible)::bigint
              "releasedGenerationCount",
            (SELECT min(visible_pool_generation) FROM visible)::integer
              "oldestReleasedGeneration",
            (SELECT max(visible_pool_generation) FROM visible)::integer
              "newestReleasedGeneration",
            jsonb_build_object(
              'batches', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'batchId', options.batch_id,
                  'batchOrdinal', options.batch_ordinal,
                  'visiblePoolGeneration', options.visible_pool_generation,
                  'releasedAt', options.released_at,
                  'count', options.item_count
                ) ORDER BY options.visible_pool_generation DESC,
                           options.released_at DESC, options.batch_id)
                FROM (
                  SELECT batch_id, batch_ordinal, visible_pool_generation,
                         min(released_at) released_at, count(*) item_count
                    FROM visible
                   GROUP BY batch_id, batch_ordinal, visible_pool_generation
                ) options
              ), '[]'::jsonb),
              'categories', COALESCE((
                SELECT jsonb_agg(category ORDER BY category)
                  FROM (SELECT DISTINCT primary_category category FROM visible
                         WHERE primary_category IS NOT NULL) categories
              ), '[]'::jsonb),
              'hasUncategorized', EXISTS(
                SELECT 1 FROM visible WHERE primary_category IS NULL)
            ) "filterOptions",
            (SELECT count(*) FROM filtered)::bigint "totalCount"
       FROM (SELECT 1) anchor
       LEFT JOIN LATERAL (
         SELECT *
           FROM filtered
           ${cursorWhere}
          ORDER BY ${sortSql[input.filters.sort]}
          LIMIT $${values.length}
       ) page ON true
      ORDER BY ${sortSql[input.filters.sort]}`,
    values,
  );
  const totalCount =
    result.rows.length === 0 ? 0 : asCount(result.rows[0]?.totalCount);
  const rows = result.rows.filter((row) => row.itemId !== null);
  const visibleRows = rows.slice(0, input.filters.limit);
  return Object.freeze({
    items: Object.freeze(visibleRows.map((row) => mapItem(row, input.actorId))),
    binding,
    releasedPool: {
      ...releasedPoolFrom(result.rows[0] ?? {}),
      filterOptions: result.rows[0]?.filterOptions as RecommendationFeedReleasedPool["filterOptions"],
    },
    latestGeneration: await readLatestGeneration(client, input),
    totalCount,
    nextPosition:
      rows.length > input.filters.limit
        ? positionFrom(visibleRows[visibleRows.length - 1] as Row)
        : null,
  });
}

async function exportItems(
  client: BacklinkTransactionClient,
  input: Parameters<RecommendationFeedRepository["exportItems"]>[0],
): Promise<readonly RecommendationFeedItem[]> {
  const values = baseValues(input);
  const selected = input.selectedItemIds.length > 0;
  const predicates = selected ? [] : addFilterPredicates(input.filters, values);
  if (selected) {
    values.push(input.selectedItemIds);
    predicates.push(`item_id=ANY($${values.length}::uuid[])`);
  }
  const where =
    predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
  const result = await client.query(
    `WITH ${visibleCte()}
     SELECT item_id "itemId",
            canonical_domain "canonicalDomain",
            recommended,
            recommendation_reason_codes "recommendationReasons",
            primary_category "primaryCategory",
            traffic_organic_etv "trafficOrganicEtv",
            authority_rank "authorityRank",
            spam_score "spamScore",
            resource_library_snapshot->>'ahrefsDr' "ahrefsDr",
            resource_library_snapshot->>'monthlyTraffic' "libraryMonthlyTraffic",
            contact_email_at_release "contactEmail",
            contact_page_url_at_release "contactPage",
            contact_terminal_reason_at_release "contactOutcome",
            opportunity_id "opportunityId",
            business_stage "businessStage",
            management_status "managementStatus",
            outcome_status "outcomeStatus",
            opportunity_created_by "opportunityCreatedBy",
            released_at "releasedAt"
       FROM visible
       ${where}
      ORDER BY ${sortSql[input.filters.sort]}`,
    values,
  );
  if (selected && result.rows.length !== input.selectedItemIds.length) {
    invalidRequest(
      "Selected recommendation export items are outside the actor entitlement.",
    );
  }
  return Object.freeze(result.rows.map((row) => mapItem(row, input.actorId)));
}

export function createRecommendationFeedRepository(
  pool: BacklinkTenantPool,
): RecommendationFeedRepository {
  return Object.freeze({
    list(input) {
      return withBacklinkTenantTransaction(pool, input, async (client) => {
        const binding = await readBinding(client, input);
        if (binding === null) {
          if (input.cursor !== null) invalidRequest("Recommendation feed cursor is stale.");
          return {
            items: [], binding: null,
            latestGeneration: await readLatestGeneration(client, input, true),
            totalCount: 0,
            nextPosition: null,
            releasedPool: {
              generationCount: 0, oldestVisiblePoolGeneration: null,
              newestVisiblePoolGeneration: null,
              filterOptions: { batches: [], categories: [], hasUncategorized: false },
            },
          };
        }
        return listItems(client, input, binding);
      });
    },
    exportItems(input) {
      return withBacklinkTenantTransaction(pool, input, async (client) => {
        const binding = await readBinding(client, input);
        if (binding === null) {
          if (input.selectedItemIds.length > 0) {
            invalidRequest("Selected recommendation export items are outside the actor entitlement.");
          }
          return [];
        }
        return exportItems(client, input);
      });
    },
  });
}
