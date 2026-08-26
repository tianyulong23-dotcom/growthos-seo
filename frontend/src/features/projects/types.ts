export type Project = {
  id: string
  workspaceId?: string
  lifecycleStatus?: "ACTIVE" | "ARCHIVED"
  lifecycleVersion?: number
  archivedAt?: string | null
  archiveReason?: string | null
  contextVersion?: number
  name: string
  domain: string
  country: string
  language: string
  competitorDomain: string | null
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
  partnershipGoals?: string[]
  inputRequired?: string[] | null
  keyPages: {
    url: string
    title: string
    description: string
  }[]
  evidence: {
    field: string
    value: string
    sourceUrl: string
    quote: string
  }[]
  userOverriddenFields: string[]
  confidence: number
  aiContentRules: string
  confirmedAt: string | null
}

export type BusinessProfileInput = {
  businessName: string
  businessType: string
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

export type ProjectOutreachReadinessStatus =
  | "READY"
  | "INPUT_REQUIRED"
  | "REFRESHING"
  | "STALE"

export type ProjectOutreachRecoveryAction =
  | "RESTORE_PROJECT"
  | "WAIT_FOR_SITE_PROFILE"
  | "COMPLETE_SITE_PROFILE"
  | "CONFIRM_BUSINESS_PROFILE"
  | "SET_PROJECT_LANGUAGE_MARKET"
  | "PUBLISH_PROMOTION_TARGET"
  | "ADD_PROMOTION_TOPIC_OR_PUBLISHED_TARGET"
  | "REPUBLISH_PROMOTION_TARGET"
  | "REVIEW_PROJECT_INPUTS"
  | "OPEN_RECOMMENDATIONS"

export type ProjectOutreachReadinessState = {
  websiteProjectId: string
  status: ProjectOutreachReadinessStatus
  siteProfileVersionId: string | null
  outreachProfileVersionId: string | null
  promotionTargetVersionId: string | null
  fingerprint: string
  inputRequired: string[]
  primaryRecoveryAction: ProjectOutreachRecoveryAction
}

export type PublishPromotionTargetInput = {
  approvedKeywordIds: string[]
  publishedTargetIds: string[]
  expectedProjectContextVersion: number
  expectedSiteProfileVersionId: string | null
}

export type ConfirmPromotionTargetInput = {
  confirmedTopics: string[]
  confirmedTargetUrls: string[]
  expectedProjectContextVersion: number
  expectedSiteProfileVersionId: string | null
}

export type PromotionTargetVersion = {
  id: string
  projectId: string
  version: number
  keywords: string[]
  targetUrls: string[]
  targetAudiences: string[]
  partnershipGoals: string[]
  inputRequired: string[]
  sourceKeywordIds: string[]
  sourcePublishedTargetIds: string[]
  sourceSiteProfileVersionId: string | null
  createdAt: string
}
