const workflowKinds = [
  "project-analysis",
  "recommendation-refill",
  "contact-enrichment",
  "placement-initial-validation",
  "placement-monitoring",
  "placement-monitoring-initialization",
  "draft-generation",
  "gmail-send",
  "gmail-polling-sync",
] as const;
export type BacklinksWorkflowKind = (typeof workflowKinds)[number];

export const backlinksRuntimeContract = Object.freeze({
  moduleId: "backlinks",
  taskQueue: "growthos.backlinks.v1",
  databaseRole: "growthos_backlinks_writer",
  allowedSchemas: ["backlinks"],
  workflows: {
    projectAnalysis: {
      workflowType: "backlinksProjectAnalysisV1Workflow",
      workflow: "project-analysis",
    },
    recommendationRefill: {
      workflowType: "backlinksRecommendationRefillV1Workflow",
      workflow: "recommendation-refill",
    },
    contactEnrichment: {
      workflowType: "backlinksContactEnrichmentV1Workflow",
      workflow: "contact-enrichment",
    },
    placementInitialValidation: {
      workflowType: "backlinksPlacementInitialValidationV1Workflow",
      workflow: "placement-initial-validation",
    },
    placementMonitoring: {
      workflowType: "backlinksPlacementMonitoringV1Workflow",
      workflow: "placement-monitoring",
    },
    placementMonitoringInitialization: {
      workflowType:
        "backlinksPlacementMonitoringInitializationV1Workflow",
      workflow: "placement-monitoring-initialization",
    },
    draftGeneration: {
      workflowType: "backlinksDraftGenerationV1Workflow",
      workflow: "draft-generation",
    },
    gmailSend: {
      workflowType: "backlinksGmailSendV1Workflow",
      workflow: "gmail-send",
    },
    gmailPollingSync: {
      workflowType: "backlinksGmailPollingSyncV1Workflow",
      workflow: "gmail-polling-sync",
    },
  },
  activities: {
    loadProjectAnalysisContext: "backlinksLoadProjectAnalysisContextV1",
    reserveRecommendationRefill: "backlinksReserveRecommendationRefillV1",
    executeRecommendationRefill: "backlinksExecuteRecommendationRefillV1",
    storeReadyRecommendations: "backlinksStoreReadyRecommendationsV1",
    recordRecommendationRefillFailure:
      "backlinksRecordRecommendationRefillFailureV1",
    runContactEnrichment: "backlinksRunContactEnrichmentV1",
    runPlacementInitialValidation:
      "backlinksRunPlacementInitialValidationV1",
    runPlacementMonitoring: "backlinksRunPlacementMonitoringV1",
    initializePlacementMonitoring:
      "backlinksInitializePlacementMonitoringV1",
    runDraftGeneration: "backlinksRunDraftGenerationV1",
    claimGmailSendAttempt: "backlinksClaimGmailSendAttemptV1",
    dispatchGmailSendAttempt: "backlinksDispatchGmailSendAttemptV1",
    settleGmailSendAttempt: "backlinksSettleGmailSendAttemptV1",
    runGmailPollingSync: "backlinksRunGmailPollingSyncV1",
  },
  providers: {
    dataForSeo: {
      providerId: "dataforseo",
      killSwitch: "backlinks.dataforseo.v1",
    },
  },
} as const);

type WorkflowIdInput = Readonly<{
  workspaceId: string;
  websiteProjectId: string;
  workflow: BacklinksWorkflowKind;
  instanceId: string;
}>;

function validSegment(value: string): boolean {
  return value.trim().length > 0 && !value.includes(":");
}

export function buildBacklinksWorkflowId(input: WorkflowIdInput): string {
  const segments = [
    input.workspaceId,
    input.websiteProjectId,
    input.workflow,
    input.instanceId,
  ];
  if (segments.some((segment) => !validSegment(segment))) {
    throw new Error("BACKLINKS_WORKFLOW_ID_INVALID");
  }
  return [
    backlinksRuntimeContract.moduleId,
    input.workspaceId,
    input.websiteProjectId,
    input.workflow,
    "v1",
    input.instanceId,
  ].join(":");
}

export function isBacklinksWorkflowId(value: string): boolean {
  const segments = value.split(":");
  return segments.length === 6 &&
    segments[0] === backlinksRuntimeContract.moduleId &&
    validSegment(segments[1] ?? "") &&
    validSegment(segments[2] ?? "") &&
    workflowKinds.includes(segments[3] as BacklinksWorkflowKind) &&
    segments[4] === "v1" &&
    validSegment(segments[5] ?? "");
}

export function assertBacklinksWorkflowId(value: string): void {
  if (!isBacklinksWorkflowId(value)) {
    throw new Error("BACKLINKS_WORKFLOW_ID_INVALID");
  }
}

export function assertBacklinksTaskQueue(value: string): void {
  if (value !== backlinksRuntimeContract.taskQueue) {
    throw new Error("BACKLINKS_TASK_QUEUE_INVALID");
  }
}
