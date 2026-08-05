import { proxyActivities } from "@temporalio/workflow";

import type {
  DraftGenerationWorkflowInput,
} from "../../application/workflows/draft-generation-workflow.js";

type DraftGenerationActivities = Readonly<{
  backlinksRunDraftGenerationV1(
    input: DraftGenerationWorkflowInput,
  ): Promise<unknown>;
}>;

const activities = proxyActivities<DraftGenerationActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 1 },
});

export async function backlinksDraftGenerationV1Workflow(
  input: DraftGenerationWorkflowInput,
) {
  return activities.backlinksRunDraftGenerationV1(input);
}
