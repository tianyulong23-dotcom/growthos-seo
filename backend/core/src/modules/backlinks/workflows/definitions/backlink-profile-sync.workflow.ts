import { proxyActivities } from "@temporalio/workflow";

type BacklinkProfileSyncInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  profileSyncJobId: string;
  canonicalDomain: string;
}>;

type BacklinkProfileActivities = Readonly<{
  backlinksRunProfileSyncV1(input: BacklinkProfileSyncInput): Promise<unknown>;
}>;

const activities = proxyActivities<BacklinkProfileActivities>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 1 },
});

export function backlinksProfileSyncV1Workflow(
  input: BacklinkProfileSyncInput,
) {
  return activities.backlinksRunProfileSyncV1(input);
}
