import type {
  PlacementStaticMonitorActivity,
} from "../application/activities/placement-static-monitor.activity.js";
import type {
  PlacementMonitorRepository,
} from "../application/repositories/placement-monitor.repository.js";
import type {
  PlacementInitialValidationRepository,
} from "../application/repositories/placement-validation.repository.js";
import {
  runPlacementInitialValidationWorkflow,
  type PlacementInitialValidationWorkflowInput,
} from "../application/workflows/placement-initial-validation.workflow.js";
import {
  runPlacementMonitorWorkflow,
  type PlacementMonitorWorkflowInput,
} from "../application/workflows/placement-monitor.workflow.js";
import type { SafeFetchPort } from "../ports/safe-fetch.port.js";

export type PlacementTemporalActivities = Readonly<{
  backlinksRunPlacementInitialValidationV1(
    input: PlacementInitialValidationWorkflowInput,
  ): ReturnType<typeof runPlacementInitialValidationWorkflow>;
  backlinksRunPlacementMonitoringV1(
    input: PlacementMonitorWorkflowInput,
  ): ReturnType<typeof runPlacementMonitorWorkflow>;
}>;

export function createPlacementTemporalActivities(
  options: Readonly<{
    validationRepository: PlacementInitialValidationRepository;
    safeFetch: SafeFetchPort;
    monitorRepository: PlacementMonitorRepository;
    staticMonitorActivity: PlacementStaticMonitorActivity;
  }>,
): PlacementTemporalActivities {
  return Object.freeze({
    backlinksRunPlacementInitialValidationV1: (input) =>
      runPlacementInitialValidationWorkflow(
        input,
        options.validationRepository,
        options.safeFetch,
      ),
    backlinksRunPlacementMonitoringV1: (input) =>
      runPlacementMonitorWorkflow(
        input,
        options.monitorRepository,
        options.staticMonitorActivity,
      ),
  });
}
