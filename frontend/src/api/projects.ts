import { apiRequest, resolveApiUrl } from "@/api/client"
import type {
  BusinessProfileInput,
  BusinessProfileRun,
  ConfirmPromotionTargetInput,
  ProjectOutreachReadinessState,
  PromotionTargetVersion,
  PublishPromotionTargetInput,
  Project,
  SiteProfile,
} from "@/features/projects/types"

type SiteProfileResponse = {
  profile_version: number
  extraction_method: string
  source_page_count: number
  favicon_url: string
  business_name: string
  business_type: string
  business_summary: string
  products_services: string[]
  target_audiences: string[]
  value_propositions: string[]
  use_cases: string[]
  target_markets: string[]
  languages: string[]
  content_topics: string[]
  conversion_actions: string[]
  partnership_goals?: string[]
  input_required?: string[] | null
  key_pages: {
    url: string
    title: string
    description: string
  }[]
  evidence: {
    field: string
    value: string
    source_url: string
    quote?: string
  }[]
  user_overridden_fields?: string[]
  confidence: number
  ai_content_rules: string
  confirmed_at: string | null
}

type ProjectResponse = {
  id: string
  workspace_id: string
  lifecycle_status: "ACTIVE" | "ARCHIVED"
  lifecycle_version: number
  archived_at: string | null
  archive_reason: string | null
  context_version: number
  name: string
  domain: string
  country: string
  language: string
  competitor_domain: string | null
  understanding_run_id: string | null
  understanding_status: Project["understandingStatus"]
  understanding_stage: string | null
  understanding_message: string
  understanding_progress: number
  understanding_attempt: number
  understanding_started_at: string | null
  understanding_finished_at: string | null
  understanding_elapsed_seconds: number
  audit_run_id: string | null
  audit_status: Project["auditStatus"]
  audit_health: number | null
  site_profile: SiteProfileResponse | null
  created_at: string
}

type BusinessProfileRunResponse = {
  run_id: string
  attempt: number
  status: BusinessProfileRun["status"]
  stage: string | null
  message: string
  progress: number
  started_at: string | null
  finished_at: string | null
  elapsed_seconds: number
  created_at: string
}

type CreateProjectInput = {
  domain: string
  country: string
  language: string
  competitorDomain?: string
}

type ProjectOutreachReadinessResponse = {
  website_project_id: string
  status: ProjectOutreachReadinessState["status"]
  site_profile_version_id: string | null
  outreach_profile_version_id: string | null
  promotion_target_version_id: string | null
  fingerprint: string
  input_required: string[]
  primary_recovery_action: ProjectOutreachReadinessState["primaryRecoveryAction"]
}

type PromotionTargetVersionResponse = {
  id: string
  project_id: string
  version: number
  keywords: string[]
  target_urls: string[]
  target_audiences: string[]
  partnership_goals: string[]
  input_required: string[]
  source_keyword_ids: string[]
  source_published_target_ids: string[]
  source_site_profile_version_id: string | null
  created_at: string
}

function mapSiteProfile(profile: SiteProfileResponse): SiteProfile {
  return {
    profileVersion: profile.profile_version,
    extractionMethod: profile.extraction_method,
    sourcePageCount: profile.source_page_count,
    faviconUrl: resolveApiUrl(profile.favicon_url),
    businessName: profile.business_name,
    businessType: profile.business_type,
    businessSummary: profile.business_summary,
    productsServices: profile.products_services,
    targetAudiences: profile.target_audiences,
    valuePropositions: profile.value_propositions,
    useCases: profile.use_cases,
    targetMarkets: profile.target_markets,
    languages: profile.languages,
    contentTopics: profile.content_topics,
    conversionActions: profile.conversion_actions,
    partnershipGoals: profile.partnership_goals ?? [],
    inputRequired: profile.input_required ?? null,
    keyPages: profile.key_pages,
    evidence: profile.evidence.map((item) => ({
      field: item.field,
      value: item.value,
      sourceUrl: item.source_url,
      quote: item.quote ?? "",
    })),
    userOverriddenFields: profile.user_overridden_fields ?? [],
    confidence: profile.confidence,
    aiContentRules: profile.ai_content_rules,
    confirmedAt: profile.confirmed_at,
  }
}

function mapProject(project: ProjectResponse): Project {
  return {
    id: project.id,
    workspaceId: project.workspace_id,
    lifecycleStatus: project.lifecycle_status,
    lifecycleVersion: project.lifecycle_version,
    archivedAt: project.archived_at,
    archiveReason: project.archive_reason,
    contextVersion: project.context_version,
    name: project.name,
    domain: project.domain,
    country: project.country,
    language: project.language,
    competitorDomain: project.competitor_domain,
    understandingRunId: project.understanding_run_id,
    understandingStatus: project.understanding_status,
    understandingStage: project.understanding_stage,
    understandingMessage: project.understanding_message,
    understandingProgress: project.understanding_progress,
    understandingAttempt: project.understanding_attempt,
    understandingStartedAt: project.understanding_started_at,
    understandingFinishedAt: project.understanding_finished_at,
    understandingElapsedSeconds: project.understanding_elapsed_seconds,
    auditRunId: project.audit_run_id,
    auditStatus: project.audit_status,
    auditHealth: project.audit_health,
    siteProfile: project.site_profile
      ? mapSiteProfile(project.site_profile)
      : null,
    createdAt: project.created_at.slice(0, 10),
  }
}

export async function listProjects(
  lifecycleStatus: "ACTIVE" | "ARCHIVED" = "ACTIVE"
): Promise<Project[]> {
  const query = new URLSearchParams({ lifecycle_status: lifecycleStatus })
  return (
    await apiRequest<ProjectResponse[]>(`/api/v1/projects?${query.toString()}`)
  ).map(mapProject)
}

export async function getProject(projectId: string): Promise<Project> {
  return mapProject(
    await apiRequest<ProjectResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}`
    )
  )
}

export async function getProjectOutreachReadiness(
  projectId: string,
  signal?: AbortSignal
): Promise<ProjectOutreachReadinessState> {
  const response = await apiRequest<ProjectOutreachReadinessResponse>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/outreach-readiness`,
    { signal }
  )
  return {
    websiteProjectId: response.website_project_id,
    status: response.status,
    siteProfileVersionId: response.site_profile_version_id,
    outreachProfileVersionId: response.outreach_profile_version_id,
    promotionTargetVersionId: response.promotion_target_version_id,
    fingerprint: response.fingerprint,
    inputRequired: response.input_required,
    primaryRecoveryAction: response.primary_recovery_action,
  }
}

export async function publishPromotionTarget(
  projectId: string,
  input: PublishPromotionTargetInput
): Promise<PromotionTargetVersion> {
  const response = await apiRequest<PromotionTargetVersionResponse>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/promotion-target`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approved_keyword_ids: input.approvedKeywordIds,
        published_target_ids: input.publishedTargetIds,
        expected_project_context_version: input.expectedProjectContextVersion,
        expected_site_profile_version_id: input.expectedSiteProfileVersionId,
      }),
    }
  )
  return {
    id: response.id,
    projectId: response.project_id,
    version: response.version,
    keywords: response.keywords,
    targetUrls: response.target_urls,
    targetAudiences: response.target_audiences,
    partnershipGoals: response.partnership_goals,
    inputRequired: response.input_required,
    sourceKeywordIds: response.source_keyword_ids,
    sourcePublishedTargetIds: response.source_published_target_ids,
    sourceSiteProfileVersionId: response.source_site_profile_version_id,
    createdAt: response.created_at,
  }
}

export async function confirmPromotionTarget(
  projectId: string,
  input: ConfirmPromotionTargetInput
): Promise<PromotionTargetVersion> {
  const response = await apiRequest<PromotionTargetVersionResponse>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/promotion-target/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmed_topics: input.confirmedTopics,
        confirmed_target_urls: input.confirmedTargetUrls,
        expected_project_context_version: input.expectedProjectContextVersion,
        expected_site_profile_version_id: input.expectedSiteProfileVersionId,
      }),
    }
  )
  return {
    id: response.id,
    projectId: response.project_id,
    version: response.version,
    keywords: response.keywords,
    targetUrls: response.target_urls,
    targetAudiences: response.target_audiences,
    partnershipGoals: response.partnership_goals,
    inputRequired: response.input_required,
    sourceKeywordIds: response.source_keyword_ids,
    sourcePublishedTargetIds: response.source_published_target_ids,
    sourceSiteProfileVersionId: response.source_site_profile_version_id,
    createdAt: response.created_at,
  }
}

export async function createProject(
  input: CreateProjectInput
): Promise<Project> {
  const project = await apiRequest<ProjectResponse>("/api/v1/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      domain: input.domain,
      country: input.country,
      language: input.language,
      competitor_domain: input.competitorDomain || null,
    }),
  })
  return mapProject(project)
}

export async function deleteProject(projectId: string): Promise<void> {
  await apiRequest<void>(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  })
}

export async function archiveProject(projectId: string): Promise<Project> {
  return mapProject(
    await apiRequest<ProjectResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/archive`,
      { method: "POST" }
    )
  )
}

export async function restoreProject(projectId: string): Promise<Project> {
  return mapProject(
    await apiRequest<ProjectResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/restore`,
      { method: "POST" }
    )
  )
}

export async function updateBusinessProfile(
  projectId: string,
  input: BusinessProfileInput
): Promise<Project> {
  return mapProject(
    await apiRequest<ProjectResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/business-profile`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_name: input.businessName,
          business_type: input.businessType,
          business_summary: input.businessSummary,
          target_audiences: input.targetAudiences,
          products_services: input.productsServices,
          value_propositions: input.valuePropositions,
          ai_content_rules: input.aiContentRules,
        }),
      }
    )
  )
}

export async function refreshBusinessProfile(
  projectId: string
): Promise<Project> {
  return mapProject(
    await apiRequest<ProjectResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/business-profile/refresh`,
      { method: "POST" }
    )
  )
}

export async function listBusinessProfileRuns(
  projectId: string
): Promise<BusinessProfileRun[]> {
  const runs = await apiRequest<BusinessProfileRunResponse[]>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/business-profile/runs`
  )
  return runs.map((run) => ({
    runId: run.run_id,
    attempt: run.attempt,
    status: run.status,
    stage: run.stage,
    message: run.message,
    progress: run.progress,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    elapsedSeconds: run.elapsed_seconds,
    createdAt: run.created_at,
  }))
}
