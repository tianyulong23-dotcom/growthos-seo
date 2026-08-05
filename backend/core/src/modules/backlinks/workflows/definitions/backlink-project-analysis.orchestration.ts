import type {
  BacklinkProjectAnalysisActivities,
  BacklinkProjectAnalysisContext,
  BacklinkProjectAnalysisInput,
} from "../../activities/backlink-project-analysis.activity.js";

type LoadContextActivity =
  BacklinkProjectAnalysisActivities["loadBacklinkProjectAnalysisContext"];

export async function runBacklinkProjectAnalysisWorkflow(
  input: BacklinkProjectAnalysisInput,
  loadContext: LoadContextActivity,
): Promise<BacklinkProjectAnalysisContext> {
  return loadContext(input);
}
