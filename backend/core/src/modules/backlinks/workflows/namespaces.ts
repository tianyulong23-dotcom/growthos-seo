const workflowKinds = [
  "project-analysis",
  "recommendation-pool-v2",
  "contact-enrichment",
  "placement-initial-validation",
  "placement-monitoring",
  "placement-monitoring-initialization",
  "draft-generation",
  "backlink-profile-sync",
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
    recommendationPoolV2: {
      workflowType: "backlinksRecommendationPoolV2Workflow",
      workflow: "recommendation-pool-v2",
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
    backlinkProfileSync: {
      workflowType: "backlinksProfileSyncV1Workflow",
      workflow: "backlink-profile-sync",
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
    executeRecommendationPoolV2DiscoveryRound:
      "backlinksExecuteRecommendationPoolV2DiscoveryRound",
    prepareRecommendationPoolV2CanonicalBatches:
      "backlinksPrepareRecommendationPoolV2CanonicalBatches",
    inspectRecommendationPoolV2CanonicalBatchPreparation:
      "backlinksInspectRecommendationPoolV2CanonicalBatchPreparation",
    convergeRecommendationPoolV2CanonicalBatchPreparation:
      "backlinksConvergeRecommendationPoolV2CanonicalBatchPreparation",
    completeRecommendationPoolV2GenerationSupersession:
      "backlinksCompleteRecommendationPoolV2GenerationSupersession",
    recoverRecommendationPoolV2CanonicalBatchPreparation:
      "backlinksRecoverRecommendationPoolV2CanonicalBatchPreparation",
    runContactEnrichment: "backlinksRunContactEnrichmentV1",
    runPlacementInitialValidation:
      "backlinksRunPlacementInitialValidationV1",
    runPlacementMonitoring: "backlinksRunPlacementMonitoringV1",
    initializePlacementMonitoring:
      "backlinksInitializePlacementMonitoringV1",
    runDraftGeneration: "backlinksRunDraftGenerationV1",
    runBacklinkProfileSync: "backlinksRunProfileSyncV1",
    claimGmailSendAttempt: "backlinksClaimGmailSendAttemptV1",
    dispatchGmailSendAttempt: "backlinksDispatchGmailSendAttemptV1",
    settleGmailSendAttempt: "backlinksSettleGmailSendAttemptV1",
    loadGmailSendReconciliation:
      "backlinksLoadGmailSendReconciliationV1",
    queryGmailSentMessage: "backlinksQueryGmailSentMessageV1",
    recoverGmailDispatch: "backlinksRecoverGmailDispatchV1",
    reconcileGmailSendResult: "backlinksReconcileGmailSendResultV1",
    runGmailPollingSync: "backlinksRunGmailPollingSyncV1",
  },
  signals: {
    recommendationPoolV2Superseded: "backlinksRecommendationPoolV2Superseded",
  },
  queries: {
    recommendationPoolV2SupersessionStatus:
      "backlinksRecommendationPoolV2SupersessionStatus",
  },
  providers: {
    dataForSeo: {
      providerId: "dataforseo",
      killSwitch: "backlinks.dataforseo.v1",
    },
  },
} as const);

type WorkflowIdInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  // Historical IDs remain reconstructible, but are not registered workflows.
  workflow: BacklinksWorkflowKind | "recommendation-refill";
  instanceId: string;
}>;

function validSegment(value: string): boolean {
  return value.trim().length > 0 && !value.includes(":");
}

export function buildBacklinksWorkflowId(input: WorkflowIdInput): string {
  const segments = [
    input.organizationId,
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
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
    input.workflow,
    "v1",
    input.instanceId,
  ].join(":");
}

export function isBacklinksWorkflowId(value: string): boolean {
  const segments = value.split(":");
  return segments.length === 7 &&
    segments[0] === backlinksRuntimeContract.moduleId &&
    validSegment(segments[1] ?? "") &&
    validSegment(segments[2] ?? "") &&
    validSegment(segments[3] ?? "") &&
    workflowKinds.includes(segments[4] as BacklinksWorkflowKind) &&
    segments[5] === "v1" &&
    validSegment(segments[6] ?? "");
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
