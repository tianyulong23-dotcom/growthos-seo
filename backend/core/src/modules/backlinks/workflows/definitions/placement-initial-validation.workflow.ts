import { proxyActivities } from "@temporalio/workflow";

import type {
  PlacementInitialValidationWorkflowInput,
} from "../../application/workflows/placement-initial-validation.workflow.js";

type PlacementValidationActivities = Readonly<{
  backlinksRunPlacementInitialValidationV1(
    input: PlacementInitialValidationWorkflowInput,
  ): Promise<unknown>;
}>;
const activities = proxyActivities<PlacementValidationActivities>({
  startToCloseTimeout: "30 seconds",
  retry: { maximumAttempts: 3 },
});

export async function backlinksPlacementInitialValidationV1Workflow(
  input: PlacementInitialValidationWorkflowInput,
): Promise<unknown> {
  return activities.backlinksRunPlacementInitialValidationV1(input);
}
