export type Project = {
  id: string
  name: string
  domain: string
  country: string
  language: string
  understandingRunId: string | null
  understandingStatus:
    "queued" | "running" | "partial" | "completed" | "failed" | null
  understandingStage: string | null
  understandingMessage: string
  understandingProgress: number
  understandingAttempt: number
  understandingStartedAt: string | null
  understandingFinishedAt: string | null
  understandingElapsedSeconds: number
  auditRunId: string | null
  auditStatus:
    | "never_started"
    | "queued"
    | "running"
    | "paused"
    | "stopping"
    | "stopped"
    | "completed"
    | "failed"
  auditHealth: number | null
  siteProfile: SiteProfile | null
  createdAt: string
}

export type SiteProfile = {
  profileVersion: number
  extractionMethod: string
  sourcePageCount: number
  faviconUrl: string
  businessName: string
  businessType: string
  businessSummary: string
  productsServices: string[]
  targetAudiences: string[]
  valuePropositions: string[]
  useCases: string[]
  targetMarkets: string[]
  languages: string[]
  contentTopics: string[]
  conversionActions: string[]
  keyPages: {
    url: string
    title: string
    description: string
  }[]
  evidence: {
    field: string
    value: string
    sourceUrl: string
  }[]
  confidence: number
  aiContentRules: string
  confirmedAt: string | null
}

export type BusinessProfileInput = {
  businessName: string
  businessSummary: string
  targetAudiences: string[]
  productsServices: string[]
  valuePropositions: string[]
  aiContentRules: string
}

export type BusinessProfileRun = {
  runId: string
  attempt: number
  status: "queued" | "running" | "partial" | "completed" | "failed"
  stage: string | null
  message: string
  progress: number
  startedAt: string | null
  finishedAt: string | null
  elapsedSeconds: number
  createdAt: string
}
