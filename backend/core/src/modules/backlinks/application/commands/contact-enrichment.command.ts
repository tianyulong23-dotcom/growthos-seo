import { createHash, randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";

import { getDomain } from "tldts";

import { isCandidateEmail } from "../../adapters/html/contact-parser.adapter.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../ports/project-context.port.js";
import { buildBacklinksWorkflowId } from "../../workflows/namespaces.js";
import { createRecommendationsQuery } from "../queries/recommendations.query.js";
import { reassessStoredContactEvidence } from "../services/contact-evidence-reassessment.service.js";
import {
  reconcilePublishedOpportunityContacts,
  synchronizeRecommendationContactState,
} from "../services/recommendation-contact-synchronization.service.js";

export const contactEnrichmentRequestedEventType =
  "backlinks.contact-enrichment.requested.v1";

export type ContactEnrichmentStatus =
  | "pending"
  | "running"
  | "completed"
  | "partially_completed"
  | "no_contact_found"
  | "retry_scheduled"
  | "stale_context";

export type ContactEnrichmentJob = Readonly<{
  id: string;
  batchId: string;
  recommendationId: string;
  prospectId: string;
  recommendationContextVersionId: string;
  rootUrl: string;
  status: ContactEnrichmentStatus;
  attemptCount: number;
  maxAttempts: number;
  maxPages: number;
  maxDepth: number;
  browserAllowed: boolean;
  browserUsed: boolean;
  pagesVisited: number;
  candidateCount: number;
  evidenceCount: number;
  lastErrorCode: string | null;
  terminalReasonCode:
    | "PUBLIC_EMAIL_FOUND"
    | "CONTACT_FORM_ONLY"
    | "LOGIN_REQUIRED"
    | "CAPTCHA_OR_BOT_CHALLENGE"
    | "ROBOTS_DISALLOWED"
    | "ACCESS_DENIED"
    | "NO_PUBLIC_EMAIL"
    | "SITE_UNREACHABLE"
    | "UNSUPPORTED_CONTENT"
    | "MANUAL_REVIEW_REQUIRED"
    | "COMPLETED_PARTIAL"
    | null;
  method: "none" | "static" | "browser" | "static_and_browser";
  lastErrorCategory: string | null;
  retryAfter: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  completedAt: string | null;
  version: number;
}>;

export type ContactEnrichmentCommandClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;

type Scope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
}>;

export type ContactEnrichmentJobOptions = Readonly<{
  maxPages: number;
  maxDepth: number;
  maxAttempts: number;
  browserAllowed: boolean;
}>;

const contactRoles = [
  "press",
  "editorial",
  "partnerships",
  "advertising",
  "support",
  "general",
] as const;
type ContactRole = (typeof contactRoles)[number];
const roleValues = new Set<string>(contactRoles);

function authorize(context: ResolvedProjectContext): void {
  if (
    !context.actor.roles.some((role) =>
      ["owner", "admin", "member"].includes(role),
    )
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "Contact enrichment permission is required.",
    });
  }
}

function asIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return new Date(String(value)).toISOString();
}

function mapJob(row: Record<string, unknown>): ContactEnrichmentJob {
  return {
    id: String(row.id),
    batchId: String(row.batchId),
    recommendationId: String(row.recommendationId),
    prospectId: String(row.prospectId),
    recommendationContextVersionId: String(row.recommendationContextVersionId),
    rootUrl: String(row.rootUrl),
    status: row.status as ContactEnrichmentStatus,
    attemptCount: Number(row.attemptCount),
    maxAttempts: Number(row.maxAttempts),
    maxPages: Number(row.maxPages),
    maxDepth: Number(row.maxDepth),
    browserAllowed: row.browserAllowed === true,
    browserUsed: row.browserUsed === true,
    pagesVisited: Number(row.pagesVisited),
    candidateCount: Number(row.candidateCount),
    evidenceCount: Number(row.evidenceCount),
    lastErrorCode:
      row.lastErrorCode === null ? null : String(row.lastErrorCode),
    terminalReasonCode:
      row.terminalReasonCode === null
        ? null
        : (row.terminalReasonCode as ContactEnrichmentJob["terminalReasonCode"]),
    method: row.method as ContactEnrichmentJob["method"],
    lastErrorCategory:
      row.lastErrorCategory === null ? null : String(row.lastErrorCategory),
    retryAfter: asIso(row.retryAfter),
    startedAt: asIso(row.startedAt),
    finishedAt: asIso(row.finishedAt),
    completedAt: asIso(row.completedAt),
    version: Number(row.version),
  };
}

const jobSelect = `SELECT id,batch_id "batchId",
recommendation_id "recommendationId",
prospect_id "prospectId",
recommendation_context_version_id "recommendationContextVersionId",
root_url "rootUrl",status,attempt_count "attemptCount",
max_attempts "maxAttempts",max_pages "maxPages",max_depth "maxDepth",
browser_allowed "browserAllowed",browser_used "browserUsed",
pages_visited "pagesVisited",candidate_count "candidateCount",
evidence_count "evidenceCount",last_error_code "lastErrorCode",
terminal_reason_code "terminalReasonCode",method,
last_error_category "lastErrorCategory",
retry_after "retryAfter",started_at "startedAt",finished_at "finishedAt",
completed_at "completedAt",
version FROM backlink_contact_enrichment_jobs`;

async function insertRequestedOutbox(
  client: ContactEnrichmentCommandClient,
  input: Readonly<{
    scope: Scope;
    job: ContactEnrichmentJob;
    actorId: string;
  }>,
): Promise<boolean> {
  const workflowId = buildBacklinksWorkflowId({
    organizationId: input.scope.organizationId,
    workspaceId: input.scope.workspaceId,
    websiteProjectId: input.scope.websiteProjectId,
    workflow: "contact-enrichment",
    instanceId: input.job.id,
  });
  const inserted = await client.query(
    `INSERT INTO backlink_outbox_events (
       id,organization_id,workspace_id,website_project_id,event_type,
       aggregate_id,aggregate_version,idempotency_key,payload,
       payload_schema_version,created_by,updated_by
     ) VALUES (
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::uuid,
       $7::integer,$8::text,
       jsonb_build_object(
         'contractVersion',$5::text,
         'organizationId',$2::uuid::text,
         'workspaceId',$3::uuid::text,
         'websiteProjectId',$4::uuid::text,
         'jobId',$6::uuid::text,
         'requestVersion',$7::integer,
         'actorId',$9::text
       ),1,$9,$9
     )
     ON CONFLICT (event_type,aggregate_id,aggregate_version) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      contactEnrichmentRequestedEventType,
      input.job.id,
      input.job.version,
      `${workflowId}:${input.job.version}`,
      input.actorId,
    ],
  );
  return inserted.rows[0] !== undefined;
}

export async function ensureReadyContactEnrichmentJobs(
  client: ContactEnrichmentCommandClient,
  input: Readonly<{
    scope: Scope;
    actorId: string;
    limit: number;
    options: ContactEnrichmentJobOptions;
  }>,
): Promise<number> {
  const exhaustedRecovery = await client.query(
    `UPDATE backlink_contact_enrichment_jobs AS job
        SET status='partially_completed',retry_after=NULL,finished_at=now(),
            completed_at=now(),terminal_reason_code='COMPLETED_PARTIAL',
            method=CASE
              WHEN browser_used AND pages_visited>0 THEN 'static_and_browser'
              WHEN browser_used THEN 'browser'
              WHEN pages_visited>0 THEN 'static'
              ELSE 'none'
            END,
            last_error_category='MAX_ATTEMPTS_EXHAUSTED',
            last_error_code=COALESCE(
              last_error_code,'MAX_ATTEMPTS_EXHAUSTED'
            ),
            updated_at=now(),updated_by=$4,version=version+1
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND attempt_count>=max_attempts
        AND (
          (
            status='running'
            AND updated_at<now()-interval '10 minutes'
          )
          OR (
            status='retry_scheduled'
            AND (retry_after IS NULL OR retry_after<=now())
          )
          OR (
            status='pending'
            AND updated_at<now()-interval '10 minutes'
            AND EXISTS (
              SELECT 1
                FROM backlink_outbox_events AS event
               WHERE event.organization_id=job.organization_id
                 AND event.workspace_id=job.workspace_id
                 AND event.website_project_id=job.website_project_id
                 AND event.event_type=$5
                 AND event.aggregate_id=job.id
                 AND event.aggregate_version=job.version
                 AND event.status='published'
            )
          )
        )
      RETURNING prospect_id "prospectId",
                recommendation_context_version_id
                  "recommendationContextVersionId"`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.actorId,
      contactEnrichmentRequestedEventType,
    ],
  );
  for (const row of exhaustedRecovery.rows) {
    await synchronizeRecommendationContactState(client, {
      ...input.scope,
      prospectId: String(row.prospectId),
      recommendationContextVersionId: String(
        row.recommendationContextVersionId,
      ),
      actorId: input.actorId,
    });
  }
  await client.query(
    `UPDATE backlink_contact_enrichment_jobs
        SET status='retry_scheduled',retry_after=now(),finished_at=NULL,
            completed_at=NULL,terminal_reason_code=NULL,method='none',
            last_error_category='STALE_RUNNING_JOB',
            last_error_code=COALESCE(last_error_code,'STALE_RUNNING_JOB'),
            updated_at=now(),updated_by=$4,version=version+1
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND status='running'
        AND updated_at<now()-interval '10 minutes'
        AND attempt_count<max_attempts`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.actorId,
    ],
  );
  await client.query(
    `UPDATE backlink_contact_enrichment_jobs AS job
        SET status='retry_scheduled',retry_after=now(),finished_at=NULL,
            completed_at=NULL,terminal_reason_code=NULL,
            version=version+1,updated_at=now(),updated_by=$4
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND status IN ('pending','retry_scheduled')
        AND updated_at<now()-interval '10 minutes'
        AND EXISTS (
          SELECT 1
            FROM backlink_outbox_events AS event
           WHERE event.organization_id=job.organization_id
             AND event.workspace_id=job.workspace_id
             AND event.website_project_id=job.website_project_id
             AND event.event_type=$5
             AND event.aggregate_id=job.id
             AND event.aggregate_version=job.version
             AND event.status='published'
        )`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.actorId,
      contactEnrichmentRequestedEventType,
    ],
  );
  await client.query(
    `UPDATE backlink_contact_enrichment_jobs AS job
        SET status='stale_context',retry_after=NULL,finished_at=now(),
            completed_at=now(),terminal_reason_code='COMPLETED_PARTIAL',
            method=CASE
              WHEN browser_used AND pages_visited>0 THEN 'static_and_browser'
              WHEN browser_used THEN 'browser'
              WHEN pages_visited>0 THEN 'static'
              ELSE 'none'
            END,
            last_error_category='STALE_CONTEXT',
            updated_at=now(),updated_by=$4,version=version+1
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND status IN ('pending','running','retry_scheduled')
        AND recommendation_context_version_id IS DISTINCT FROM (
          SELECT snapshot.id
            FROM backlink_project_context_snapshots AS snapshot
           WHERE snapshot.organization_id=$1
             AND snapshot.workspace_id=$2
             AND snapshot.website_project_id=$3
           ORDER BY snapshot.snapshot_version DESC
           LIMIT 1
        )`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.actorId,
    ],
  );
  await client.query(
    `UPDATE backlink_contact_enrichment_batches AS batch
        SET status='stale_context',completed_at=COALESCE(completed_at,now()),
            updated_at=now(),updated_by=$4,version=version+1
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND status='running'
        AND recommendation_context_version_id IS DISTINCT FROM (
          SELECT snapshot.id
            FROM backlink_project_context_snapshots AS snapshot
           WHERE snapshot.organization_id=$1
             AND snapshot.workspace_id=$2
             AND snapshot.website_project_id=$3
           ORDER BY snapshot.snapshot_version DESC
           LIMIT 1
        )`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.actorId,
    ],
  );
  const retries = await client.query(
    `${jobSelect}
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND status='retry_scheduled'
        AND retry_after<=now()
        AND attempt_count<max_attempts
      ORDER BY retry_after,created_at
      LIMIT $4`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.limit,
    ],
  );
  let created = 0;
  for (const row of retries.rows) {
    await client.query(
      `UPDATE backlink_contact_enrichment_batches
          SET status='running',completed_at=NULL,updated_at=now(),
              updated_by=$5,version=version+1
        WHERE (organization_id,workspace_id,website_project_id,id)=
              ($1,$2,$3,$4)
          AND status<>'running'`,
      [
        input.scope.organizationId,
        input.scope.workspaceId,
        input.scope.websiteProjectId,
        row.batchId,
        input.actorId,
      ],
    );
    const inserted = await insertRequestedOutbox(client, {
      scope: input.scope,
      job: mapJob(row),
      actorId: input.actorId,
    });
    if (inserted) created += 1;
  }
  if (created >= input.limit) return created;

  const source = await client.query(
    `SELECT r.id "recommendationId",r.prospect_id "prospectId",
            r.recommendation_context_version_id "recommendationContextVersionId",
            p.hostname_ascii "hostname"
       FROM backlink_recommendation_inventory i
       JOIN backlink_recommendations r ON
         (r.organization_id,r.workspace_id,r.website_project_id,r.id,
          r.prospect_id,r.recommendation_context_version_id)=
         (i.organization_id,i.workspace_id,i.website_project_id,
          i.recommendation_id,i.prospect_id,
          i.recommendation_context_version_id)
       JOIN backlink_prospects p ON
         (p.organization_id,p.workspace_id,p.website_project_id,p.id,
          p.recommendation_context_version_id)=
         (r.organization_id,r.workspace_id,r.website_project_id,
          r.prospect_id,r.recommendation_context_version_id)
       LEFT JOIN backlink_contact_enrichment_jobs j ON
         (j.organization_id,j.workspace_id,j.website_project_id,
          j.recommendation_id,j.recommendation_context_version_id)=
         (r.organization_id,r.workspace_id,r.website_project_id,
          r.id,r.recommendation_context_version_id)
      WHERE (i.organization_id,i.workspace_id,i.website_project_id)=
            ($1,$2,$3)
        AND i.status IN ('ready','shown','accepted')
        AND r.recommendation_context_version_id = (
          SELECT snapshot.id
            FROM backlink_project_context_snapshots AS snapshot
           WHERE snapshot.organization_id=$1
             AND snapshot.workspace_id=$2
             AND snapshot.website_project_id=$3
           ORDER BY snapshot.snapshot_version DESC
           LIMIT 1
        )
        AND j.id IS NULL
      ORDER BY i.created_at,i.id
      LIMIT $4`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      input.limit - created,
    ],
  );
  for (const row of source.rows) {
    const jobId = randomUUID();
    const batchId = randomUUID();
    const inserted = await client.query(
      `WITH batch AS (
         INSERT INTO backlink_contact_enrichment_batches (
           id,organization_id,workspace_id,website_project_id,
           recommendation_context_version_id,status,created_by,updated_by
         ) VALUES ($14,$2,$3,$4,$7,'running',$13,$13)
         ON CONFLICT (
           organization_id,workspace_id,website_project_id,
           recommendation_context_version_id
         ) DO UPDATE SET
           status='running',completed_at=NULL,updated_at=now(),
           updated_by=EXCLUDED.updated_by,
           version=backlink_contact_enrichment_batches.version+1
         RETURNING id
       )
       INSERT INTO backlink_contact_enrichment_jobs (
         id,organization_id,workspace_id,website_project_id,
         recommendation_id,prospect_id,recommendation_context_version_id,
         batch_id,root_url,max_attempts,max_pages,max_depth,browser_allowed,
         created_by,updated_by
       )
       SELECT $1,$2,$3,$4,$5,$6,$7,batch.id,$8,$9,$10,$11,$12,$13,$13
         FROM batch
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         recommendation_id,recommendation_context_version_id
       ) DO NOTHING
       RETURNING id`,
      [
        jobId,
        input.scope.organizationId,
        input.scope.workspaceId,
        input.scope.websiteProjectId,
        row.recommendationId,
        row.prospectId,
        row.recommendationContextVersionId,
        `https://${String(row.hostname)}/`,
        input.options.maxAttempts,
        input.options.maxPages,
        input.options.maxDepth,
        input.options.browserAllowed,
        input.actorId,
        batchId,
      ],
    );
    if (inserted.rows[0] === undefined) continue;
    const job = mapJob(
      (await client.query(`${jobSelect} WHERE id=$1`, [jobId])).rows[0] ?? {},
    );
    const outboxInserted = await insertRequestedOutbox(client, {
      scope: input.scope,
      job,
      actorId: input.actorId,
    });
    if (outboxInserted) created += 1;
  }
  return created;
}

export type HistoricalContactEnrichmentQueueSummary = Readonly<{
  eligibleRecommendationCount: number;
  jobsCreated: number;
  jobsRetried: number;
  activeJobsPreserved: number;
  staleContextsSkipped: number;
  attemptLimitsSkipped: number;
  outboxEventsCreated: number;
}>;

export type CurrentPoolContactEnrichmentSummary =
  HistoricalContactEnrichmentQueueSummary &
    Readonly<{
      batchId: string | null;
      poolRecommendationCount: number;
    }>;

async function listCurrentPoolRecommendationIds(
  client: ContactEnrichmentCommandClient,
  context: ResolvedProjectContext,
): Promise<readonly string[]> {
  const query = createRecommendationsQuery(client);
  const recommendationIds: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const page = await query.listRecommendations(context, {
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.presentationState !== "current") return Object.freeze([]);
    recommendationIds.push(...page.items.map((item) => item.id));
    if (!page.hasMore) break;
    if (page.nextCursor === null || seenCursors.has(page.nextCursor)) {
      throw new BacklinkError({
        code: backlinkErrorCodes.internal,
        message: "Recommendation pool pagination did not advance.",
      });
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return Object.freeze([...new Set(recommendationIds)]);
}

export async function queueHistoricalContactEnrichmentJobs(
  client: ContactEnrichmentCommandClient,
  input: Readonly<{
    scope: Scope;
    actorId: string;
    recommendationIds: readonly string[];
    options: ContactEnrichmentJobOptions;
  }>,
): Promise<HistoricalContactEnrichmentQueueSummary> {
  const recommendationIds = [...new Set(input.recommendationIds)];
  const summary = {
    eligibleRecommendationCount: recommendationIds.length,
    jobsCreated: 0,
    jobsRetried: 0,
    activeJobsPreserved: 0,
    staleContextsSkipped: 0,
    attemptLimitsSkipped: 0,
    outboxEventsCreated: 0,
  };
  if (recommendationIds.length === 0) return Object.freeze(summary);

  const sources = await client.query(
    `SELECT recommendation.id "recommendationId",
            recommendation.prospect_id "prospectId",
            recommendation.recommendation_context_version_id
              "recommendationContextVersionId",
            prospect.hostname_ascii "hostname",
            recommendation.recommendation_context_version_id=(
              SELECT snapshot.id
                FROM backlink_project_context_snapshots AS snapshot
               WHERE (snapshot.organization_id,snapshot.workspace_id,
                      snapshot.website_project_id)=($1,$2,$3)
                 AND snapshot.project_status='ACTIVE'
               ORDER BY snapshot.snapshot_version DESC
               LIMIT 1
            ) "currentContext",
            job.id "jobId",job.status "jobStatus",
            job.attempt_count "attemptCount",
            job.max_attempts "maxAttempts",
            job.batch_id "batchId"
       FROM backlink_recommendations AS recommendation
       JOIN backlink_prospects AS prospect ON
         (prospect.organization_id,prospect.workspace_id,
          prospect.website_project_id,prospect.id,
          prospect.recommendation_context_version_id)=
         (recommendation.organization_id,recommendation.workspace_id,
          recommendation.website_project_id,recommendation.prospect_id,
          recommendation.recommendation_context_version_id)
       JOIN backlink_recommendation_inventory AS inventory ON
         (inventory.organization_id,inventory.workspace_id,
          inventory.website_project_id,inventory.recommendation_id,
          inventory.recommendation_context_version_id)=
         (recommendation.organization_id,recommendation.workspace_id,
          recommendation.website_project_id,recommendation.id,
          recommendation.recommendation_context_version_id)
       LEFT JOIN backlink_contact_enrichment_jobs AS job ON
         (job.organization_id,job.workspace_id,job.website_project_id,
          job.recommendation_id,job.recommendation_context_version_id)=
         (recommendation.organization_id,recommendation.workspace_id,
          recommendation.website_project_id,recommendation.id,
          recommendation.recommendation_context_version_id)
      WHERE (recommendation.organization_id,recommendation.workspace_id,
             recommendation.website_project_id)=($1,$2,$3)
        AND recommendation.id=ANY($4::uuid[])
        AND inventory.fit_decision='eligible'
        AND inventory.fit_score_model_version=
              'recommendation-commercial-fit.v4'
        AND (
          inventory.contact_decision IS DISTINCT FROM 'eligible'
          OR inventory.contact_reason_code IS DISTINCT FROM 'PUBLIC_EMAIL_FOUND'
          OR inventory.verified_public_email_count<1
        )
      ORDER BY recommendation.recommendation_context_version_id,
               recommendation.id`,
    [
      input.scope.organizationId,
      input.scope.workspaceId,
      input.scope.websiteProjectId,
      recommendationIds,
    ],
  );
  summary.eligibleRecommendationCount = sources.rows.length;

  for (const source of sources.rows) {
    if (source.currentContext !== true) {
      summary.staleContextsSkipped += 1;
      continue;
    }
    const jobId =
      source.jobId === null || source.jobId === undefined
        ? null
        : String(source.jobId);
    if (jobId === null) {
      const createdJobId = randomUUID();
      const batchId = randomUUID();
      const inserted = await client.query(
        `WITH batch AS (
           INSERT INTO backlink_contact_enrichment_batches (
             id,organization_id,workspace_id,website_project_id,
             recommendation_context_version_id,status,created_by,updated_by
           ) VALUES ($14,$2,$3,$4,$7,'running',$13,$13)
           ON CONFLICT (
             organization_id,workspace_id,website_project_id,
             recommendation_context_version_id
           ) DO UPDATE SET
             status='running',completed_at=NULL,updated_at=now(),
             updated_by=EXCLUDED.updated_by,
             version=backlink_contact_enrichment_batches.version+1
           RETURNING id
         )
         INSERT INTO backlink_contact_enrichment_jobs (
           id,organization_id,workspace_id,website_project_id,
           recommendation_id,prospect_id,recommendation_context_version_id,
           batch_id,root_url,max_attempts,max_pages,max_depth,browser_allowed,
           created_by,updated_by
         )
         SELECT $1,$2,$3,$4,$5,$6,$7,batch.id,$8,$9,$10,$11,$12,$13,$13
           FROM batch
         ON CONFLICT (
           organization_id,workspace_id,website_project_id,
           recommendation_id,recommendation_context_version_id
         ) DO NOTHING
         RETURNING id`,
        [
          createdJobId,
          input.scope.organizationId,
          input.scope.workspaceId,
          input.scope.websiteProjectId,
          source.recommendationId,
          source.prospectId,
          source.recommendationContextVersionId,
          `https://${String(source.hostname)}/`,
          input.options.maxAttempts,
          input.options.maxPages,
          input.options.maxDepth,
          input.options.browserAllowed,
          input.actorId,
          batchId,
        ],
      );
      if (inserted.rows[0] === undefined) {
        summary.activeJobsPreserved += 1;
        continue;
      }
      const job = mapJob(
        (await client.query(`${jobSelect} WHERE id=$1`, [createdJobId]))
          .rows[0] ?? {},
      );
      summary.jobsCreated += 1;
      if (
        await insertRequestedOutbox(client, {
          scope: input.scope,
          job,
          actorId: input.actorId,
        })
      ) {
        summary.outboxEventsCreated += 1;
      }
      continue;
    }

    const status = String(source.jobStatus);
    if (["pending", "running", "retry_scheduled"].includes(status)) {
      summary.activeJobsPreserved += 1;
      continue;
    }
    if (Number(source.attemptCount) >= 10) {
      summary.attemptLimitsSkipped += 1;
      continue;
    }
    const updated = await client.query(
      `UPDATE backlink_contact_enrichment_jobs
          SET status='retry_scheduled',retry_after=now(),
              finished_at=NULL,completed_at=NULL,terminal_reason_code=NULL,
              method='none',last_error_category=NULL,last_error_code=NULL,
              browser_allowed=$5,
              max_attempts=LEAST(10,GREATEST(
                max_attempts,attempt_count+1
              )),
              updated_at=now(),updated_by=$4,version=version+1
        WHERE (organization_id,workspace_id,website_project_id,id)=
              ($1,$2,$3,$6)
          AND status IN (
            'completed','partially_completed','no_contact_found'
          )
          AND attempt_count<10
        RETURNING batch_id "batchId"`,
      [
        input.scope.organizationId,
        input.scope.workspaceId,
        input.scope.websiteProjectId,
        input.actorId,
        input.options.browserAllowed,
        jobId,
      ],
    );
    if (updated.rows[0] === undefined) {
      summary.activeJobsPreserved += 1;
      continue;
    }
    await client.query(
      `UPDATE backlink_contact_enrichment_batches
          SET status='running',completed_at=NULL,updated_at=now(),
              updated_by=$5,version=version+1
        WHERE (organization_id,workspace_id,website_project_id,id)=
              ($1,$2,$3,$4)`,
      [
        input.scope.organizationId,
        input.scope.workspaceId,
        input.scope.websiteProjectId,
        updated.rows[0].batchId,
        input.actorId,
      ],
    );
    const job = mapJob(
      (await client.query(`${jobSelect} WHERE id=$1`, [jobId])).rows[0] ?? {},
    );
    summary.jobsRetried += 1;
    if (
      await insertRequestedOutbox(client, {
        scope: input.scope,
        job,
        actorId: input.actorId,
      })
    ) {
      summary.outboxEventsCreated += 1;
    }
  }
  return Object.freeze(summary);
}

export function createContactEnrichmentCommands(
  client: ContactEnrichmentCommandClient,
  options: ContactEnrichmentJobOptions,
  dependencies: Readonly<{
    listCurrentPoolRecommendationIds?: (
      context: ResolvedProjectContext,
    ) => Promise<readonly string[]>;
  }> = {},
) {
  const resolveCurrentPoolRecommendationIds =
    dependencies.listCurrentPoolRecommendationIds ??
    ((context: ResolvedProjectContext) =>
      listCurrentPoolRecommendationIds(client, context));
  const get = async (
    context: ResolvedProjectContext,
    jobId: string,
  ): Promise<ContactEnrichmentJob> => {
    const { tenant, project } = context;
    const result = await client.query(
      `${jobSelect}
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3 AND id=$4`,
      [
        tenant.organizationId,
        tenant.workspaceId,
        project.websiteProjectId,
        jobId,
      ],
    );
    if (result.rows[0] === undefined) {
      throw new BacklinkError({
        code: backlinkErrorCodes.notFound,
        message: "Contact enrichment job was not found.",
      });
    }
    return mapJob(result.rows[0]);
  };
  return {
    async runCurrentPool(
      context: ResolvedProjectContext,
    ): Promise<CurrentPoolContactEnrichmentSummary> {
      authorize(context);
      const { tenant, project, actor } = context;
      const scope = {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        websiteProjectId: project.websiteProjectId,
      };
      await reconcilePublishedOpportunityContacts(client, {
        ...scope,
        actorId: actor.userId,
      });
      const recommendationIds =
        await resolveCurrentPoolRecommendationIds(context);
      const summary = await queueHistoricalContactEnrichmentJobs(client, {
        scope,
        actorId: actor.userId,
        recommendationIds,
        options,
      });
      const hasActiveBatch =
        summary.jobsCreated +
          summary.jobsRetried +
          summary.activeJobsPreserved >
        0;
      const batch = hasActiveBatch
        ? await client.query(
            `SELECT batch.id
               FROM backlink_contact_enrichment_batches AS batch
              WHERE (
                batch.organization_id,batch.workspace_id,
                batch.website_project_id
              )=($1,$2,$3)
                AND batch.recommendation_context_version_id=(
                  SELECT snapshot.id
                    FROM backlink_project_context_snapshots AS snapshot
                   WHERE (
                     snapshot.organization_id,snapshot.workspace_id,
                     snapshot.website_project_id
                   )=($1,$2,$3)
                     AND snapshot.project_status='ACTIVE'
                   ORDER BY snapshot.snapshot_version DESC,
                            snapshot.created_at DESC,snapshot.id DESC
                   LIMIT 1
                )
                AND batch.status='running'
              ORDER BY batch.started_at DESC,batch.id DESC
              LIMIT 1`,
            [
              scope.organizationId,
              scope.workspaceId,
              scope.websiteProjectId,
            ],
          )
        : { rows: [] };
      return Object.freeze({
        batchId:
          batch.rows[0]?.id === undefined ? null : String(batch.rows[0].id),
        poolRecommendationCount: recommendationIds.length,
        ...summary,
      });
    },

    async start(
      input: Readonly<{
        context: ResolvedProjectContext;
        recommendationId: string;
      }>,
    ): Promise<ContactEnrichmentJob & { replayed: boolean }> {
      authorize(input.context);
      const { tenant, project, actor } = input.context;
      const scope = {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        websiteProjectId: project.websiteProjectId,
      };
      const source = (
        await client.query(
          `SELECT r.id "recommendationId",r.prospect_id "prospectId",
                r.recommendation_context_version_id
                  "recommendationContextVersionId",
                p.hostname_ascii "hostname",i.status "inventoryStatus"
           FROM backlink_recommendations r
           JOIN backlink_prospects p ON
             (p.organization_id,p.workspace_id,p.website_project_id,p.id,
              p.recommendation_context_version_id)=
             (r.organization_id,r.workspace_id,r.website_project_id,
              r.prospect_id,r.recommendation_context_version_id)
           LEFT JOIN backlink_recommendation_inventory i ON
             (i.organization_id,i.workspace_id,i.website_project_id,
              i.recommendation_id,i.recommendation_context_version_id)=
             (r.organization_id,r.workspace_id,r.website_project_id,
              r.id,r.recommendation_context_version_id)
          WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
                ($1,$2,$3,$4)`,
          [
            scope.organizationId,
            scope.workspaceId,
            scope.websiteProjectId,
            input.recommendationId,
          ],
        )
      ).rows[0];
      if (source === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Recommendation was not found in this project.",
        });
      }
      if (
        !["ready", "shown", "accepted"].includes(
          String(source.inventoryStatus),
        )
      ) {
        throw new BacklinkError({
          code: backlinkErrorCodes.conflict,
          message:
            "Only visible or accepted recommendations can start contact enrichment.",
        });
      }
      const jobId = randomUUID();
      const batchId = randomUUID();
      const inserted = await client.query(
        `WITH batch AS (
           INSERT INTO backlink_contact_enrichment_batches (
             id,organization_id,workspace_id,website_project_id,
             recommendation_context_version_id,status,created_by,updated_by
           ) VALUES ($14,$2,$3,$4,$7,'running',$13,$13)
           ON CONFLICT (
             organization_id,workspace_id,website_project_id,
             recommendation_context_version_id
           ) DO UPDATE SET
             status='running',completed_at=NULL,updated_at=now(),
             updated_by=EXCLUDED.updated_by,
             version=backlink_contact_enrichment_batches.version+1
           RETURNING id
         )
         INSERT INTO backlink_contact_enrichment_jobs (
           id,organization_id,workspace_id,website_project_id,
           recommendation_id,prospect_id,recommendation_context_version_id,
           batch_id,root_url,max_attempts,max_pages,max_depth,browser_allowed,
           created_by,updated_by
         )
         SELECT $1,$2,$3,$4,$5,$6,$7,batch.id,$8,$9,$10,$11,$12,$13,$13
           FROM batch
         ON CONFLICT (
           organization_id,workspace_id,website_project_id,
           recommendation_id,recommendation_context_version_id
         ) DO NOTHING
         RETURNING id`,
        [
          jobId,
          scope.organizationId,
          scope.workspaceId,
          scope.websiteProjectId,
          source.recommendationId,
          source.prospectId,
          source.recommendationContextVersionId,
          `https://${String(source.hostname)}/`,
          options.maxAttempts,
          options.maxPages,
          options.maxDepth,
          options.browserAllowed,
          actor.userId,
          batchId,
        ],
      );
      const replayed = inserted.rows[0] === undefined;
      const result = await client.query(
        `${jobSelect}
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND recommendation_id=$4
            AND recommendation_context_version_id=$5`,
        [
          scope.organizationId,
          scope.workspaceId,
          scope.websiteProjectId,
          source.recommendationId,
          source.recommendationContextVersionId,
        ],
      );
      const job = mapJob(result.rows[0] ?? {});
      if (!replayed) {
        await insertRequestedOutbox(client, {
          scope,
          job,
          actorId: actor.userId,
        });
      }
      return { ...job, replayed };
    },

    async get(
      context: ResolvedProjectContext,
      jobId: string,
    ): Promise<ContactEnrichmentJob> {
      return get(context, jobId);
    },

    async retry(
      input: Readonly<{
        context: ResolvedProjectContext;
        jobId: string;
      }>,
    ): Promise<ContactEnrichmentJob> {
      authorize(input.context);
      const { tenant, project, actor } = input.context;
      const updated = await client.query(
        `UPDATE backlink_contact_enrichment_jobs
            SET status='retry_scheduled',retry_after=now(),
                finished_at=NULL,completed_at=NULL,last_error_code=NULL,
                terminal_reason_code=NULL,method='none',
                last_error_category=NULL,browser_allowed=$6,
                max_attempts=LEAST(10,GREATEST(
                  max_attempts,attempt_count+1
                )),
                updated_at=now(),updated_by=$5,version=version+1
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND id=$4
            AND status IN (
              'completed','partially_completed','no_contact_found',
              'retry_scheduled'
            )
            AND attempt_count < 10
          RETURNING id,batch_id "batchId"`,
        [
          tenant.organizationId,
          tenant.workspaceId,
          project.websiteProjectId,
          input.jobId,
          actor.userId,
          options.browserAllowed,
        ],
      );
      if (updated.rows[0] === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.conflict,
          message: "Contact enrichment job cannot be retried.",
        });
      }
      await client.query(
        `UPDATE backlink_contact_enrichment_batches
            SET status='running',completed_at=NULL,updated_at=now(),
                updated_by=$5,version=version+1
          WHERE (organization_id,workspace_id,website_project_id,id)=
                ($1,$2,$3,$4)`,
        [
          tenant.organizationId,
          tenant.workspaceId,
          project.websiteProjectId,
          updated.rows[0].batchId,
          actor.userId,
        ],
      );
      const job = await get(input.context, input.jobId);
      await insertRequestedOutbox(client, {
        scope: {
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          websiteProjectId: project.websiteProjectId,
        },
        job,
        actorId: actor.userId,
      });
      return job;
    },

    async retryUnpublished(
      context: ResolvedProjectContext,
    ): Promise<{ batchId: string | null; retriedJobCount: number }> {
      authorize(context);
      const { tenant, project, actor } = context;
      const scope = {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        websiteProjectId: project.websiteProjectId,
      };
      const unpublished = await client.query(
        `WITH current_context AS (
           SELECT id
             FROM backlink_project_context_snapshots
            WHERE (organization_id,workspace_id,website_project_id)=
                  ($1,$2,$3)
              AND project_status='ACTIVE'
            ORDER BY snapshot_version DESC,created_at DESC,id DESC
            LIMIT 1
         ),
         current_policy AS MATERIALIZED (
           SELECT policy.*
             FROM backlink_commercial_inventory_policies AS policy
            WHERE (policy.organization_id,policy.workspace_id,
                   policy.website_project_id)=($1,$2,$3)
              AND policy.project_context_version_id=(
                SELECT id FROM current_context
             )
            FOR UPDATE
         ),
         generation_contract AS (
           SELECT contract.id
             FROM backlink_recommendation_generation_contracts AS contract
             JOIN current_policy AS policy ON
               contract.visible_pool_generation=
                 policy.visible_pool_generation
            WHERE (
              contract.organization_id,contract.workspace_id,
              contract.website_project_id,
              contract.recommendation_context_version_id
            )=(
              $1,$2,$3,(SELECT id FROM current_context)
            )
              AND contract.qualification_contract_version=
                'recommendation-qualification.v1'
              AND contract.visibility_contract_version=
                'recommendation-visibility.v1'
            LIMIT 1
         ),
         published_capacity AS (
           SELECT count(*)::integer published_count
             FROM backlink_recommendation_inventory AS inventory
             JOIN backlink_recommendations AS recommendation ON
               (recommendation.organization_id,recommendation.workspace_id,
                recommendation.website_project_id,recommendation.id)=
               (inventory.organization_id,inventory.workspace_id,
                inventory.website_project_id,inventory.recommendation_id)
             JOIN current_policy AS policy ON
               inventory.visible_pool_generation=
                 policy.visible_pool_generation
            WHERE (inventory.organization_id,inventory.workspace_id,
                   inventory.website_project_id)=($1,$2,$3)
              AND inventory.recommendation_context_version_id=
                  policy.project_context_version_id
               AND inventory.publication_status='PUBLISHED'
               AND inventory.fit_decision='eligible'
               AND inventory.fit_score_model_version=
                     'recommendation-commercial-fit.v4'
               AND inventory.status IN ('ready','shown','accepted')
                AND recommendation.status IN ('ready','shown','accepted')
         ),
         corrected_visibility_capacity AS (
           SELECT count(*)::integer visible_count
             FROM (
               SELECT DISTINCT ON (qualification.canonical_domain)
                      qualification.id,qualification.canonical_domain,
                      qualification.decision
                 FROM backlink_recommendation_qualification_facts
                   AS qualification
                WHERE qualification.generation_contract_id=(
                        SELECT id FROM generation_contract
                      )
                  AND (
                    qualification.organization_id,
                    qualification.workspace_id,
                    qualification.website_project_id,
                    qualification.recommendation_context_version_id
                  )=(
                    $1,$2,$3,(SELECT id FROM current_context)
                  )
                  AND qualification.recommendation_id IS NOT NULL
                ORDER BY qualification.canonical_domain,
                         qualification.attempt DESC,
                         qualification.observed_at DESC,
                         qualification.id DESC
             ) AS qualification
             JOIN LATERAL (
               SELECT visibility.decision
                 FROM backlink_recommendation_visibility_facts AS visibility
                WHERE visibility.generation_contract_id=(
                        SELECT id FROM generation_contract
                      )
                  AND (
                    visibility.organization_id,visibility.workspace_id,
                    visibility.website_project_id,
                    visibility.recommendation_context_version_id,
                    visibility.qualification_fact_id
                  )=(
                    $1,$2,$3,(SELECT id FROM current_context),
                    qualification.id
                  )
                ORDER BY visibility.attempt DESC,
                         visibility.observed_at DESC,
                         visibility.id DESC
                LIMIT 1
             ) AS visibility ON true
            WHERE qualification.decision='eligible'
              AND visibility.decision='visible'
         ),
         effective_capacity AS (
           SELECT CASE WHEN generation_contract.id IS NULL
                    THEN published_capacity.published_count
                    ELSE corrected_visibility_capacity.visible_count
                  END published_count,
                  generation_contract.id IS NOT NULL corrected_contract
             FROM published_capacity
             CROSS JOIN corrected_visibility_capacity
             LEFT JOIN generation_contract ON true
         ),
         effective_policy AS (
           SELECT policy.organization_id,policy.workspace_id,
                  policy.website_project_id,
                  policy.project_context_version_id,
                  policy.visible_pool_generation,
                  capacity.corrected_contract,
                  CASE
                    WHEN capacity.published_count>=
                         policy.visible_pool_target_count THEN 'active'
                    ELSE policy.visible_pool_state
                  END visible_pool_state
             FROM current_policy AS policy
             CROSS JOIN effective_capacity AS capacity
         ),
         reconciled_policy AS (
           UPDATE backlink_commercial_inventory_policies AS policy
              SET last_publishable_count=capacity.published_count,
                  visible_pool_state=CASE
                    WHEN capacity.published_count>=
                         current_policy.visible_pool_target_count
                      THEN 'active'
                    ELSE policy.visible_pool_state
                  END,
                  refill_state=CASE
                    WHEN capacity.published_count>=
                         current_policy.visible_pool_target_count
                      THEN 'completed'
                    ELSE policy.refill_state
                  END,
                  termination_reason=CASE
                    WHEN capacity.published_count>=
                         current_policy.visible_pool_target_count
                      THEN 'HIGH_WATERMARK'
                    ELSE policy.termination_reason
                  END,
                  pause_reason=CASE
                    WHEN capacity.published_count>=
                         current_policy.visible_pool_target_count
                      THEN NULL
                    ELSE policy.pause_reason
                  END,
                  next_refill_at=CASE
                    WHEN capacity.published_count>=
                         current_policy.visible_pool_target_count
                      THEN NULL
                    ELSE policy.next_refill_at
                  END,
                  updated_at=now(),updated_by=$4,
                  version=policy.version+1
             FROM current_policy,effective_capacity AS capacity
            WHERE (policy.organization_id,policy.workspace_id,
                   policy.website_project_id,
                   policy.project_context_version_id,
                   policy.visible_pool_generation)=
                  (current_policy.organization_id,
                   current_policy.workspace_id,
                   current_policy.website_project_id,
                   current_policy.project_context_version_id,
                   current_policy.visible_pool_generation)
              AND (
                policy.last_publishable_count IS DISTINCT FROM
                  capacity.published_count
                OR (
                  capacity.published_count>=
                    current_policy.visible_pool_target_count
                  AND (
                    policy.visible_pool_state<>'active'
                    OR policy.refill_state<>'completed'
                    OR policy.termination_reason IS DISTINCT FROM
                      'HIGH_WATERMARK'
                    OR policy.pause_reason IS NOT NULL
                    OR policy.next_refill_at IS NOT NULL
                  )
                )
              )
          RETURNING policy.visible_pool_generation
         ),
         sync_marker AS (
           SELECT count(*) FROM reconciled_policy
         )
         SELECT DISTINCT inventory.prospect_id "prospectId",
                         inventory.recommendation_context_version_id
                           "recommendationContextVersionId"
           FROM backlink_recommendation_inventory AS inventory
           JOIN effective_policy AS policy ON
             (policy.organization_id,policy.workspace_id,
              policy.website_project_id,policy.project_context_version_id,
              policy.visible_pool_generation)=
             (inventory.organization_id,inventory.workspace_id,
              inventory.website_project_id,
               inventory.recommendation_context_version_id,
               inventory.visible_pool_generation)
           CROSS JOIN sync_marker
          WHERE (inventory.organization_id,inventory.workspace_id,
                 inventory.website_project_id)=($1,$2,$3)
            AND inventory.fit_decision='eligible'
             AND inventory.fit_score_model_version=
                   'recommendation-commercial-fit.v4'
             AND (
               inventory.contact_decision IS DISTINCT FROM 'eligible'
               OR inventory.contact_reason_code IS DISTINCT FROM
                    'PUBLIC_EMAIL_FOUND'
               OR inventory.verified_public_email_count<1
             )
             AND (
               policy.visible_pool_state='building'
               OR (
                 policy.corrected_contract
                 AND policy.visible_pool_state='active'
               )
             )
           ORDER BY inventory.prospect_id`,
        [
          scope.organizationId,
          scope.workspaceId,
          scope.websiteProjectId,
          actor.userId,
        ],
      );
      for (const row of unpublished.rows) {
        const prospectId = String(row.prospectId);
        const recommendationContextVersionId = String(
          row.recommendationContextVersionId,
        );
        await reassessStoredContactEvidence(client, {
          ...scope,
          prospectId,
          recommendationContextVersionId,
          actorId: actor.userId,
        });
        await synchronizeRecommendationContactState(client, {
          ...scope,
          prospectId,
          recommendationContextVersionId,
          actorId: actor.userId,
        });
      }
      const updated = await client.query(
        `UPDATE backlink_contact_enrichment_jobs AS job
            SET status='retry_scheduled',retry_after=now(),
                finished_at=NULL,completed_at=NULL,
                terminal_reason_code=NULL,method='none',
                last_error_category=NULL,last_error_code=NULL,
                browser_allowed=$5,
                max_attempts=LEAST(10,GREATEST(
                  job.max_attempts,job.attempt_count+1
                )),
                updated_at=now(),updated_by=$4,version=job.version+1
           FROM backlink_recommendation_inventory AS inventory
          WHERE (job.organization_id,job.workspace_id,
                 job.website_project_id)=($1,$2,$3)
            AND (inventory.organization_id,inventory.workspace_id,
                 inventory.website_project_id,
                 inventory.recommendation_id,
                 inventory.recommendation_context_version_id)=
                (job.organization_id,job.workspace_id,
                 job.website_project_id,job.recommendation_id,
                 job.recommendation_context_version_id)
            AND (
              inventory.contact_decision IS DISTINCT FROM 'eligible'
              OR inventory.contact_reason_code IS DISTINCT FROM
                   'PUBLIC_EMAIL_FOUND'
              OR inventory.verified_public_email_count<1
            )
            AND job.status IN (
              'completed','partially_completed','no_contact_found',
              'retry_scheduled'
            )
            AND job.attempt_count<10
             AND job.recommendation_context_version_id=(
               SELECT snapshot.id
                FROM backlink_project_context_snapshots AS snapshot
               WHERE (snapshot.organization_id,snapshot.workspace_id,
                      snapshot.website_project_id)=($1,$2,$3)
                 AND snapshot.project_status='ACTIVE'
                ORDER BY snapshot.snapshot_version DESC
                LIMIT 1
             )
             AND EXISTS (
               SELECT 1
                 FROM backlink_commercial_inventory_policies AS policy
                WHERE (policy.organization_id,policy.workspace_id,
                       policy.website_project_id,
                       policy.project_context_version_id,
                       policy.visible_pool_generation)=
                      (job.organization_id,job.workspace_id,
                       job.website_project_id,
                       job.recommendation_context_version_id,
                       inventory.visible_pool_generation)
                  AND policy.visible_pool_state='building'
             )
           RETURNING job.id,job.batch_id "batchId"`,
        [
          scope.organizationId,
          scope.workspaceId,
          scope.websiteProjectId,
          actor.userId,
          options.browserAllowed,
        ],
      );
      const batchId =
        updated.rows[0] === undefined ? null : String(updated.rows[0].batchId);
      if (batchId !== null) {
        await client.query(
          `UPDATE backlink_contact_enrichment_batches
              SET status='running',completed_at=NULL,updated_at=now(),
                  updated_by=$5,version=version+1
            WHERE (organization_id,workspace_id,website_project_id,id)=
                  ($1,$2,$3,$4)`,
          [
            scope.organizationId,
            scope.workspaceId,
            scope.websiteProjectId,
            batchId,
            actor.userId,
          ],
        );
      }
      for (const row of updated.rows) {
        const retried = await get(context, String(row.id));
        await insertRequestedOutbox(client, {
          scope,
          job: retried,
          actorId: actor.userId,
        });
      }
      return {
        batchId,
        retriedJobCount: updated.rows.length,
      };
    },

    async addManualCandidate(
      input: Readonly<{
        context: ResolvedProjectContext;
        recommendationId: string;
        normalizedEmail: string;
        contactRole: ContactRole;
        sourceUrl: string;
        reason: string;
      }>,
    ) {
      authorize(input.context);
      const normalizedEmail = input.normalizedEmail.trim().toLowerCase();
      if (
        !isCandidateEmail(normalizedEmail) ||
        !roleValues.has(input.contactRole)
      ) {
        throw new BacklinkError({
          code: backlinkErrorCodes.invalidRequest,
          message: "A valid public contact email and role are required.",
        });
      }
      let sourceUrl: string;
      try {
        const parsed = new URL(input.sourceUrl);
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error();
        parsed.hash = "";
        sourceUrl = parsed.toString();
      } catch {
        throw new BacklinkError({
          code: backlinkErrorCodes.invalidRequest,
          message: "A public HTTP evidence URL is required.",
        });
      }
      const { tenant, project, actor } = input.context;
      const rawDomain = normalizedEmail.split("@").at(-1) ?? "";
      const emailDomain = domainToASCII(rawDomain).toLowerCase();
      const source = (
        await client.query(
          `SELECT r.prospect_id "prospectId",
                r.recommendation_context_version_id
                  "recommendationContextVersionId",
                p.registrable_domain "registrableDomain"
           FROM backlink_recommendations r
           JOIN backlink_prospects p ON
             (p.organization_id,p.workspace_id,p.website_project_id,p.id,
              p.recommendation_context_version_id)=
             (r.organization_id,r.workspace_id,r.website_project_id,
              r.prospect_id,r.recommendation_context_version_id)
          WHERE (r.organization_id,r.workspace_id,r.website_project_id,r.id)=
                ($1,$2,$3,$4)`,
          [
            tenant.organizationId,
            tenant.workspaceId,
            project.websiteProjectId,
            input.recommendationId,
          ],
        )
      ).rows[0];
      if (source === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Recommendation was not found in this project.",
        });
      }
      const relation =
        getDomain(emailDomain, { allowPrivateDomains: true }) ===
        getDomain(String(source.registrableDomain), {
          allowPrivateDomains: true,
        })
          ? "same_registrable_domain"
          : "external_domain";
      const candidateId = randomUUID();
      const candidate = await client.query(
        `INSERT INTO backlink_contact_candidates AS c (
           id,organization_id,workspace_id,website_project_id,prospect_id,
           recommendation_context_version_id,normalized_email,
           email_domain_ascii,domain_relation,syntax_validator_version,
           confidence,observed_role,inferred_purpose,purpose_confidence,
           purpose_rule_version,purpose_evidence,created_by,updated_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,'manual-email.v1',100,$10,$10,100,
           'manual-contact-purpose.v1',
           jsonb_build_array(jsonb_build_object(
             'tier','manual','field','manual_entry','value',$10,
             'matchedToken',$10,'ruleId','manual.contact-purpose'
           )),$11,$11
         )
         ON CONFLICT (
           organization_id,workspace_id,website_project_id,prospect_id,
           recommendation_context_version_id,normalized_email
         ) DO UPDATE SET
           observed_role=EXCLUDED.observed_role,
           inferred_purpose=EXCLUDED.inferred_purpose,
           purpose_confidence=100,
           purpose_rule_version=EXCLUDED.purpose_rule_version,
           purpose_evidence=EXCLUDED.purpose_evidence,
           updated_at=now(),updated_by=EXCLUDED.updated_by,
           version=c.version+1
         RETURNING id,version`,
        [
          candidateId,
          tenant.organizationId,
          tenant.workspaceId,
          project.websiteProjectId,
          source.prospectId,
          source.recommendationContextVersionId,
          normalizedEmail,
          emailDomain,
          relation,
          input.contactRole,
          actor.userId,
        ],
      );
      const persistedId = String(candidate.rows[0]?.id);
      const contentHash = createHash("sha256")
        .update(`${sourceUrl}\n${normalizedEmail}\n${input.reason}`)
        .digest("hex");
      await client.query(
        `INSERT INTO backlink_contact_evidence (
           id,organization_id,workspace_id,website_project_id,candidate_id,
           source_url,observed_at,extraction_method,evidence_snippet,
           parser_version,content_sha256,confidence,expires_at,created_by,
           rule_version,domain_relation
         ) VALUES (
           $1,$2,$3,$4,$5,$6,now(),'manual',$7,'manual-public-evidence.v1',
           $8,100,now()+interval '365 days',$9,
           'manual-contact-purpose.v1',$10
         )
         ON CONFLICT DO NOTHING`,
        [
          randomUUID(),
          tenant.organizationId,
          tenant.workspaceId,
          project.websiteProjectId,
          persistedId,
          sourceUrl,
          input.reason,
          contentHash,
          actor.userId,
          relation,
        ],
      );
      await synchronizeRecommendationContactState(client, {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        websiteProjectId: project.websiteProjectId,
        prospectId: String(source.prospectId),
        recommendationContextVersionId: String(
          source.recommendationContextVersionId,
        ),
        actorId: actor.userId,
      });
      return {
        candidateId: persistedId,
        normalizedEmail,
        sourceUrl,
        version: Number(candidate.rows[0]?.version),
      };
    },

    async correctCandidate(
      input: Readonly<{
        context: ResolvedProjectContext;
        candidateId: string;
        expectedVersion: number;
        contactRole: ContactRole;
        reason: string;
      }>,
    ) {
      authorize(input.context);
      if (!roleValues.has(input.contactRole)) {
        throw new BacklinkError({
          code: backlinkErrorCodes.invalidRequest,
          message: "A supported contact role is required.",
        });
      }
      const { tenant, project, actor } = input.context;
      const result = await client.query(
        `UPDATE backlink_contact_candidates
            SET observed_role=$6,inferred_purpose=$6,purpose_confidence=100,
                purpose_rule_version='manual-contact-correction.v1',
                purpose_evidence=jsonb_build_array(jsonb_build_object(
                  'tier','manual','field','manual_correction','value',$6,
                  'matchedToken',$6,'ruleId','manual.contact-correction',
                  'reason',$7
                )),
                updated_at=now(),updated_by=$8,version=version+1
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND id=$4 AND version=$5
            AND status='candidate' AND invalidated_at IS NULL
          RETURNING id,version`,
        [
          tenant.organizationId,
          tenant.workspaceId,
          project.websiteProjectId,
          input.candidateId,
          input.expectedVersion,
          input.contactRole,
          input.reason,
          actor.userId,
        ],
      );
      if (result.rows[0] === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.conflict,
          message: "Contact candidate version changed or is not editable.",
        });
      }
      return {
        candidateId: String(result.rows[0].id),
        contactRole: input.contactRole,
        version: Number(result.rows[0].version),
      };
    },
  };
}
