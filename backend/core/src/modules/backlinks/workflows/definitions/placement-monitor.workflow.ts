import type {
  PlacementMonitorWorkflowInput,
} from "../../application/workflows/placement-monitor.workflow.js";

type ProxyActivities = <T>(options: Readonly<{
  startToCloseTimeout: string;
  retry: Readonly<{ maximumAttempts: number }>;
}>) => T;
declare const require: (
  id: "@temporalio/workflow",
) => Readonly<{ proxyActivities: ProxyActivities }>;

const { proxyActivities } = require("@temporalio/workflow");
type PlacementMonitoringActivities = Readonly<{
  backlinksRunPlacementMonitoringV1(
    input: PlacementMonitorWorkflowInput,
  ): Promise<unknown>;
}>;
const activities = proxyActivities<PlacementMonitoringActivities>({
  startToCloseTimeout: "60 seconds",
  retry: { maximumAttempts: 3 },
});

export async function backlinksPlacementMonitoringV1Workflow(
  input: PlacementMonitorWorkflowInput,
): Promise<unknown> {
  return activities.backlinksRunPlacementMonitoringV1(input);
}
