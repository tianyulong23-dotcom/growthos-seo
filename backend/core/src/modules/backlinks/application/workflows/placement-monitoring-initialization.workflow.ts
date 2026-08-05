export type PlacementMonitoringInitializationWorkflowInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  placementId: string;
  candidateId: string;
  opportunityId: string | null;
  initialValidationId: string;
  sourceOutboxEventId: string;
  projectionId: string;
  workflowId: string;
  requestedAt: string;
  workerId: string;
}>;

export type PlacementMonitoringInitializationResult = Readonly<{
  placementId: string;
  sourceOutboxEventId: string;
  projectionId: string;
  workflowId: string;
  policyVersion: string;
  nextCheckAt: string;
  state: "created" | "existing";
}>;
