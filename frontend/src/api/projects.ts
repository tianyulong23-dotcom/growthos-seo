import { apiRequest, resolveApiUrl } from "@/api/client"
import type {
  BusinessProfileInput,
  BusinessProfileRun,
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
  key_pages: {
    url: string
    title: string
    description: string
  }[]
  evidence: {
    field: string
    value: string
    source_url: string
  }[]
  confidence: number
  ai_content_rules: string
  confirmed_at: string | null
}

type ProjectResponse = {
  id: string
  name: string
  domain: string
  country: string
  language: string
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
    keyPages: profile.key_pages,
    evidence: profile.evidence.map((item) => ({
      field: item.field,
      value: item.value,
      sourceUrl: item.source_url,
    })),
    confidence: profile.confidence,
    aiContentRules: profile.ai_content_rules,
    confirmedAt: profile.confirmed_at,
  }
}

function mapProject(project: ProjectResponse): Project {
  return {
    id: project.id,
    name: project.name,
    domain: project.domain,
    country: project.country,
    language: project.language,
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

export async function listProjects(): Promise<Project[]> {
  return (await apiRequest<ProjectResponse[]>("/api/v1/projects")).map(
    mapProject
  )
}

export async function getProject(projectId: string): Promise<Project> {
  return mapProject(
    await apiRequest<ProjectResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}`
    )
  )
}

export async function createProject(
  input: CreateProjectInput
): Promise<Project> {
  const project = await apiRequest<ProjectResponse>("/api/v1/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  return mapProject(project)
}

export async function deleteProject(projectId: string): Promise<void> {
  await apiRequest<void>(`/api/v1/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  })
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
