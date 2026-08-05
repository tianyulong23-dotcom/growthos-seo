import { createHash, randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";

import { getDomain } from "tldts";

import { isCandidateEmail } from "../../adapters/html/contact-parser.adapter.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type {
  ResolvedProjectContext,
} from "../../ports/project-context.port.js";
import {
  buildBacklinksWorkflowId,
} from "../../workflows/namespaces.js";

export const contactEnrichmentRequestedEventType =
  "backlinks.contact-enrichment.requested.v1";

export type ContactEnrichmentStatus =
  | "pending"
  | "running"
  | "completed"
  | "partially_completed"
  | "no_contact_found"
  | "retry_scheduled";

export type ContactEnrichmentJob = Readonly<{
  id: string;
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
  retryAfter: string | null;
  startedAt: string | null;
  finishedAt: string | null;
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

type JobOptions = Readonly<{
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
      ["owner", "admin", "member"].includes(role)
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
    recommendationId: String(row.recommendationId),
    prospectId: String(row.prospectId),
    recommendationContextVersionId: String(
      row.recommendationContextVersionId,
    ),
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
    retryAfter: asIso(row.retryAfter),
    startedAt: asIso(row.startedAt),
    finishedAt: asIso(row.finishedAt),
    version: Number(row.version),
  };
}

const jobSelect = `SELECT id,recommendation_id "recommendationId",
prospect_id "prospectId",
recommendation_context_version_id "recommendationContextVersionId",
root_url "rootUrl",status,attempt_count "attemptCount",
max_attempts "maxAttempts",max_pages "maxPages",max_depth "maxDepth",
browser_allowed "browserAllowed",browser_used "browserUsed",
pages_visited "pagesVisited",candidate_count "candidateCount",
evidence_count "evidenceCount",last_error_code "lastErrorCode",
retry_after "retryAfter",started_at "startedAt",finished_at "finishedAt",
version FROM backlink_contact_enrichment_jobs`;

async function insertRequestedOutbox(
  client: ContactEnrichmentCommandClient,
  input: Readonly<{
    scope: Scope;
    job: ContactEnrichmentJob;
    actorId: string;
  }>,
): Promise<void> {
  const workflowId = buildBacklinksWorkflowId({
    workspaceId: input.scope.workspaceId,
    websiteProjectId: input.scope.websiteProjectId,
    workflow: "contact-enrichment",
    instanceId: input.job.id,
  });
  await client.query(
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
     ON CONFLICT (event_type,aggregate_id,aggregate_version) DO NOTHING`,
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
}

export async function ensureReadyContactEnrichmentJobs(
  client: ContactEnrichmentCommandClient,
  input: Readonly<{
    scope: Scope;
    actorId: string;
    limit: number;
    options: JobOptions;
  }>,
): Promise<number> {
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
    await insertRequestedOutbox(client, {
      scope: input.scope,
      job: mapJob(row),
      actorId: input.actorId,
    });
    created += 1;
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
        AND i.status IN ('ready','shown')
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
    const inserted = await client.query(
      `INSERT INTO backlink_contact_enrichment_jobs (
         id,organization_id,workspace_id,website_project_id,
         recommendation_id,prospect_id,recommendation_context_version_id,
         root_url,max_attempts,max_pages,max_depth,browser_allowed,
         created_by,updated_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13
       )
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
      ],
    );
    if (inserted.rows[0] === undefined) continue;
    const job = mapJob((await client.query(
      `${jobSelect} WHERE id=$1`,
      [jobId],
    )).rows[0] ?? {});
    await insertRequestedOutbox(client, {
      scope: input.scope,
      job,
      actorId: input.actorId,
    });
    created += 1;
  }
  return created;
}

export function createContactEnrichmentCommands(
  client: ContactEnrichmentCommandClient,
  options: JobOptions,
) {
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
    async start(input: Readonly<{
      context: ResolvedProjectContext;
      recommendationId: string;
    }>): Promise<ContactEnrichmentJob & { replayed: boolean }> {
      authorize(input.context);
      const { tenant, project, actor } = input.context;
      const scope = {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
        websiteProjectId: project.websiteProjectId,
      };
      const source = (await client.query(
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
      )).rows[0];
      if (source === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Recommendation was not found in this project.",
        });
      }
      if (!["ready", "shown"].includes(String(source.inventoryStatus))) {
        throw new BacklinkError({
          code: backlinkErrorCodes.conflict,
          message: "Only Ready recommendations can start contact enrichment.",
        });
      }
      const jobId = randomUUID();
      const inserted = await client.query(
        `INSERT INTO backlink_contact_enrichment_jobs (
           id,organization_id,workspace_id,website_project_id,
           recommendation_id,prospect_id,recommendation_context_version_id,
           root_url,max_attempts,max_pages,max_depth,browser_allowed,
           created_by,updated_by
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13
         )
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

    async retry(input: Readonly<{
      context: ResolvedProjectContext;
      jobId: string;
    }>): Promise<ContactEnrichmentJob> {
      authorize(input.context);
      const { tenant, project, actor } = input.context;
      const updated = await client.query(
        `UPDATE backlink_contact_enrichment_jobs
            SET status='retry_scheduled',retry_after=now(),
                finished_at=NULL,last_error_code=NULL,
                updated_at=now(),updated_by=$5,version=version+1
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND id=$4
            AND status IN (
              'completed','partially_completed','no_contact_found',
              'retry_scheduled'
            )
            AND attempt_count < max_attempts
          RETURNING id`,
        [
          tenant.organizationId,
          tenant.workspaceId,
          project.websiteProjectId,
          input.jobId,
          actor.userId,
        ],
      );
      if (updated.rows[0] === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.conflict,
          message: "Contact enrichment job cannot be retried.",
        });
      }
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

    async addManualCandidate(input: Readonly<{
      context: ResolvedProjectContext;
      recommendationId: string;
      normalizedEmail: string;
      contactRole: ContactRole;
      sourceUrl: string;
      reason: string;
    }>) {
      authorize(input.context);
      const normalizedEmail = input.normalizedEmail.trim().toLowerCase();
      if (!isCandidateEmail(normalizedEmail) || !roleValues.has(input.contactRole)) {
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
      const source = (await client.query(
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
      )).rows[0];
      if (source === undefined) {
        throw new BacklinkError({
          code: backlinkErrorCodes.notFound,
          message: "Recommendation was not found in this project.",
        });
      }
      const relation = getDomain(emailDomain, { allowPrivateDomains: true })
        === getDomain(
          String(source.registrableDomain),
          { allowPrivateDomains: true },
        )
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
      return {
        candidateId: persistedId,
        normalizedEmail,
        sourceUrl,
        version: Number(candidate.rows[0]?.version),
      };
    },

    async correctCandidate(input: Readonly<{
      context: ResolvedProjectContext;
      candidateId: string;
      expectedVersion: number;
      contactRole: ContactRole;
      reason: string;
    }>) {
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
