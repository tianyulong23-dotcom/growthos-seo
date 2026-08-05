import { proxyActivities } from "@temporalio/workflow";

import type {
  PlacementMonitoringInitializationResult,
  PlacementMonitoringInitializationWorkflowInput,
} from "../../application/workflows/placement-monitoring-initialization.workflow.js";

type PlacementMonitoringInitializationActivities = Readonly<{
  backlinksInitializePlacementMonitoringV1(
    input: PlacementMonitoringInitializationWorkflowInput,
  ): Promise<PlacementMonitoringInitializationResult>;
}>;
const activities =
  proxyActivities<PlacementMonitoringInitializationActivities>({
    startToCloseTimeout: "30 seconds",
    retry: { maximumAttempts: 3 },
  });

export async function backlinksPlacementMonitoringInitializationV1Workflow(
  input: PlacementMonitoringInitializationWorkflowInput,
): Promise<PlacementMonitoringInitializationResult> {
  return activities.backlinksInitializePlacementMonitoringV1(input);
}
