import { proxyActivities } from "@temporalio/workflow";

import type {
  BacklinkProjectAnalysisContext,
  BacklinkProjectAnalysisInput,
} from "../../activities/backlink-project-analysis.activity.js";
import { runBacklinkProjectAnalysisWorkflow } from "./backlink-project-analysis.orchestration.js";

type WorkflowActivities = Readonly<{
  backlinksLoadProjectAnalysisContextV1(
    input: BacklinkProjectAnalysisInput,
  ): Promise<BacklinkProjectAnalysisContext>;
}>;
const { backlinksLoadProjectAnalysisContextV1 } =
  proxyActivities<WorkflowActivities>({
    startToCloseTimeout: "10 seconds",
    retry: { maximumAttempts: 3 },
  });

export async function backlinksProjectAnalysisV1Workflow(
  input: BacklinkProjectAnalysisInput,
): Promise<BacklinkProjectAnalysisContext> {
  return runBacklinkProjectAnalysisWorkflow(
    input,
    backlinksLoadProjectAnalysisContextV1,
  );
}
