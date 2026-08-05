import type {
  DataForSeoRefreshMode,
  DataForSeoRequestIntent,
} from "../../ports/dataforseo.port.js";

export type DataForSeoExecutionMode = "BACKGROUND" | "INTERACTIVE";

export type DataForSeoRequestIntentInput = Readonly<{
  intent: DataForSeoRequestIntent;
  refreshMode: DataForSeoRefreshMode;
  execution: DataForSeoExecutionMode;
  opportunityId?: string | undefined;
  explicitDetailRequested?: boolean | undefined;
  explicitAssessmentTaskId?: string | undefined;
  linkValidatorPrimary?: boolean | undefined;
  forceLiveAuthorized?: boolean | undefined;
}>;

export class DataForSeoRequestIntentError extends Error {
  readonly code = "DATAFORSEO_REQUEST_INTENT_BLOCKED";

  constructor(readonly reason: string) {
    super(reason);
    this.name = "DataForSeoRequestIntentError";
  }
}

const blocked = (reason: string): never => {
  throw new DataForSeoRequestIntentError(reason);
};

export function assertDataForSeoRequestIntent(
  input: DataForSeoRequestIntentInput,
): void {
  if (
    input.refreshMode === "FORCE_LIVE" &&
    input.forceLiveAuthorized !== true
  ) {
    blocked("FORCE_LIVE_REQUIRES_EXPLICIT_BUDGET_AND_FREQUENCY_AUTHORIZATION");
  }

  switch (input.intent) {
    case "DISCOVERY":
    case "CARD_ENRICHMENT":
      if (input.execution !== "BACKGROUND") {
        blocked(`${input.intent}_MUST_RUN_AS_BACKGROUND_ENRICHMENT`);
      }
      return;
    case "DEEP_ASSESSMENT":
      if (
        input.opportunityId === undefined ||
        (
          input.explicitDetailRequested !== true &&
          input.explicitAssessmentTaskId === undefined
        )
      ) {
        blocked(
          "DEEP_ASSESSMENT_REQUIRES_OPPORTUNITY_AND_EXPLICIT_DETAIL_OR_TASK",
        );
      }
      return;
    case "MONITORING":
      if (
        input.execution !== "BACKGROUND" ||
        input.linkValidatorPrimary !== true
      ) {
        blocked(
          "MONITORING_REQUIRES_BACKGROUND_EXECUTION_AND_LINK_VALIDATOR_PRIMARY",
        );
      }
      return;
  }
}
