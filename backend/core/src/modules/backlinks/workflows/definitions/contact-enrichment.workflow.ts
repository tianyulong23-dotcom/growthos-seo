import { proxyActivities } from "@temporalio/workflow";

import type {
  ContactEnrichmentActivityInput,
  ContactEnrichmentActivityResult,
} from "../../activities/contact-enrichment.activity.js";

type ContactEnrichmentActivities = Readonly<{
  backlinksRunContactEnrichmentV1(
    input: ContactEnrichmentActivityInput,
  ): Promise<ContactEnrichmentActivityResult>;
}>;

const activities = proxyActivities<ContactEnrichmentActivities>({
  startToCloseTimeout: "8 minutes",
  retry: { maximumAttempts: 1 },
});

export function backlinksContactEnrichmentV1Workflow(
  input: ContactEnrichmentActivityInput,
): Promise<ContactEnrichmentActivityResult> {
  return activities.backlinksRunContactEnrichmentV1(input);
}
