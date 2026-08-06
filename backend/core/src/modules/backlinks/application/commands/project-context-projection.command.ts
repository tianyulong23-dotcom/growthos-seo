import { randomUUID } from "node:crypto";

import type {
  ProjectContextSnapshotStatus,
} from "../../db/repositories/project-context-snapshot.repository.js";
import {
  createProjectContextSnapshotRepository,
} from "../../db/repositories/project-context-snapshot.repository.js";
import {
  createJobRepository,
} from "../../db/repositories/job.repository.js";
import {
  createOutboxRepository,
} from "../../db/repositories/outbox.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTransactionClient,
  type BacklinkTenantPool,
} from "../../db/tenant-transaction.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import {
  BACKLINK_PROJECT_ANALYSIS_REQUESTED,
} from "../../workflows/outbox-relay.js";
import {
  buildBacklinksWorkflowId,
} from "../../workflows/namespaces.js";

export type ProjectContextProjectionInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
  correlationId: string;
  snapshotId: string;
  snapshotVersion: number;
  projectStatus: ProjectContextSnapshotStatus;
  canonicalDomain: string;
  locale: string;
  countryCode: string;
  profileVersionId: string;
  promotionTargetVersionId: string;
  products: readonly string[];
  keywords: readonly string[];
  targetUrls: readonly string[];
  inputComplete: boolean;
  jobId: string;
  outboxEventId: string;
}>;

export type ProjectContextProjectionResult = Readonly<{
  state: "projected" | "replayed";
  snapshotVersion: number;
  inputRequired: boolean;
  jobScheduled: boolean;
  jobId: string | null;
}>;

export type ProjectContextProjectionCommand = Readonly<{
  project(
    input: ProjectContextProjectionInput,
  ): Promise<ProjectContextProjectionResult>;
}>;

export type ProjectRuntimeGovernanceCapabilities = Readonly<{
  aiProviderEnabled: boolean;
  gmailSendEnabled: boolean;
  gmailSyncEnabled: boolean;
  dataForSeoEnabled: boolean;
  browserProviderEnabled: boolean;
}>;

const disabledCapabilities: ProjectRuntimeGovernanceCapabilities = {
  aiProviderEnabled: false,
  gmailSendEnabled: false,
  gmailSyncEnabled: false,
  dataForSeoEnabled: false,
  browserProviderEnabled: false,
};

type GovernanceSwitch = Readonly<{
  layer: "project" | "provider";
  capability: string;
  provider: string | null;
}>;

function enabledGovernanceSwitches(
  capabilities: ProjectRuntimeGovernanceCapabilities,
): readonly GovernanceSwitch[] {
  const switches: GovernanceSwitch[] = [];
  if (capabilities.aiProviderEnabled) {
    switches.push({
      layer: "project",
      capability: "AI_PROVIDER",
      provider: null,
    });
  }
  if (capabilities.gmailSendEnabled) {
    switches.push({
      layer: "project",
      capability: "GMAIL_SEND",
      provider: null,
    });
  }
  if (capabilities.gmailSyncEnabled) {
    switches.push({
      layer: "project",
      capability: "GMAIL_SYNC",
      provider: null,
    });
  }
  if (capabilities.dataForSeoEnabled) {
    switches.push(
      {
        layer: "project",
        capability: "backlinks.dataforseo.v1",
        provider: null,
      },
      {
        layer: "provider",
        capability: "backlinks.dataforseo.v1",
        provider: "dataforseo",
      },
    );
  }
  if (capabilities.browserProviderEnabled) {
    switches.push({
      layer: "project",
      capability: "backlinks.browser.v1",
      provider: null,
    });
  }
  return switches;
}

async function initializeProjectRuntimeGovernance(
  client: BacklinkTransactionClient,
  input: ProjectContextProjectionInput,
  capabilities: ProjectRuntimeGovernanceCapabilities,
): Promise<void> {
  const scopeValues = [
    input.organizationId,
    input.workspaceId,
    input.websiteProjectId,
  ] as const;
  await client.query(
    `INSERT INTO backlink_project_settings_versions (
       id, organization_id, workspace_id, website_project_id,
       version, settings_values, created_by
     )
     SELECT $1, $2, $3, $4, 1,
            jsonb_build_object(
              'reportingTimezone', 'Asia/Shanghai',
              'reportLookbackDays', 30,
              'exportExpiryHours', 24
            ),
            $5
      WHERE NOT EXISTS (
        SELECT 1
          FROM backlink_project_settings_versions
         WHERE organization_id = $2
           AND workspace_id = $3
           AND website_project_id = $4
      )
     ON CONFLICT DO NOTHING`,
    [randomUUID(), ...scopeValues, input.actorId],
  );
  await client.query(
    `INSERT INTO backlink_retention_policy_versions (
       id, organization_id, workspace_id, website_project_id,
       version, rules, exceptions, created_by
     )
     SELECT $1, $2, $3, $4, 1,
            jsonb_build_array(
              jsonb_build_object(
                'category', 'operational',
                'retainForDays', 30
              )
            ),
            jsonb_build_array(
              'audit_record',
              'lifecycle_record',
              'active_suppression'
            ),
            $5
      WHERE NOT EXISTS (
        SELECT 1
          FROM backlink_retention_policy_versions
         WHERE organization_id = $2
           AND workspace_id = $3
           AND website_project_id = $4
      )
     ON CONFLICT DO NOTHING`,
    [randomUUID(), ...scopeValues, input.actorId],
  );

  if (input.projectStatus !== "ACTIVE") {
    return;
  }
  for (const item of enabledGovernanceSwitches(capabilities)) {
    await client.query(
      `INSERT INTO backlink_kill_switch_versions (
         id, organization_id, workspace_id, website_project_id,
         layer, capability, provider, version, blocked, reason, created_by
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, 1, false,
              'LOCAL_PRODUCT enabled capability project initialization',
              $8
        WHERE NOT EXISTS (
          SELECT 1
            FROM backlink_kill_switch_versions
           WHERE organization_id = $2
             AND workspace_id = $3
             AND website_project_id = $4
             AND layer = $5
             AND capability = $6
             AND provider IS NOT DISTINCT FROM $7
        )
       ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        ...scopeValues,
        item.layer,
        item.capability,
        item.provider,
        input.actorId,
      ],
    );
  }
}

async function staleContactEnrichmentJobs(
  client: BacklinkTransactionClient,
  input: ProjectContextProjectionInput,
): Promise<void> {
  await client.query(
    `UPDATE backlink_contact_enrichment_jobs
        SET status='stale_context',retry_after=NULL,finished_at=now(),
            updated_at=now(),updated_by=$5,version=version+1
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND status IN ('pending','retry_scheduled')
        AND (
          $6::text <> 'ACTIVE'
          OR recommendation_context_version_id <> $4
        )`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.snapshotId,
      input.actorId,
      input.projectStatus,
    ],
  );
}

function conflicts(
  latest: NonNullable<Awaited<ReturnType<
    ReturnType<typeof createProjectContextSnapshotRepository>["findLatest"]
  >>>,
  input: ProjectContextProjectionInput,
): boolean {
  const sameStrings = (
    left: readonly string[],
    right: readonly string[],
  ) => (
    left.length === right.length
    && left.every((value, index) => value === right[index])
  );
  return (
    latest.snapshotId !== input.snapshotId
    || latest.projectStatus !== input.projectStatus
    || latest.canonicalDomain !== input.canonicalDomain
    || latest.locale !== input.locale
    || latest.countryCode !== input.countryCode
    || latest.profileVersionId !== input.profileVersionId
    || latest.promotionTargetVersionId !== input.promotionTargetVersionId
    || !sameStrings(latest.products, input.products)
    || !sameStrings(latest.keywords, input.keywords)
    || !sameStrings(latest.targetUrls, input.targetUrls)
  );
}

function conflict(message: string): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message,
  });
}

export function createProjectContextProjectionCommand(
  pool: BacklinkTenantPool,
  capabilities: ProjectRuntimeGovernanceCapabilities = disabledCapabilities,
): ProjectContextProjectionCommand {
  return Object.freeze({
    async project(input) {
      const scope = {
        organizationId: input.organizationId,
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
      };
      return withBacklinkTenantTransaction(pool, scope, async (client) => {
        const snapshots = createProjectContextSnapshotRepository(client);
        const latest = await snapshots.findLatest(scope);
        if (latest !== null && latest.snapshotVersion > input.snapshotVersion) {
          throw conflict("The Website Project context projection is stale.");
        }
        if (latest !== null && latest.snapshotVersion === input.snapshotVersion) {
          if (conflicts(latest, input)) {
            throw conflict(
              "The Website Project context version is bound to different facts.",
            );
          }
          await initializeProjectRuntimeGovernance(
            client,
            input,
            capabilities,
          );
          return {
            state: "replayed",
            snapshotVersion: input.snapshotVersion,
            inputRequired: !input.inputComplete,
            jobScheduled: false,
            jobId: null,
          };
        }

        await snapshots.append({
          ...scope,
          snapshotId: input.snapshotId,
          snapshotVersion: input.snapshotVersion,
          projectStatus: input.projectStatus,
          canonicalDomain: input.canonicalDomain,
          locale: input.locale,
          countryCode: input.countryCode,
          profileVersionId: input.profileVersionId,
          promotionTargetVersionId: input.promotionTargetVersionId,
          products: input.products,
          keywords: input.keywords,
          targetUrls: input.targetUrls,
          actorId: input.actorId,
        });
        await initializeProjectRuntimeGovernance(
          client,
          input,
          capabilities,
        );
        await staleContactEnrichmentJobs(client, input);

        if (!input.inputComplete || input.projectStatus !== "ACTIVE") {
          return {
            state: "projected",
            snapshotVersion: input.snapshotVersion,
            inputRequired: !input.inputComplete,
            jobScheduled: false,
            jobId: null,
          };
        }

        const workflowId = buildBacklinksWorkflowId({
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          workflow: "project-analysis",
          instanceId: input.jobId,
        });
        const jobCreated = await createJobRepository(client).create({
          ...scope,
          actorId: input.actorId,
          jobId: input.jobId,
          jobType: "project-analysis",
          sourceObjectType: "project-context-snapshot",
          sourceObjectId: input.snapshotId,
          workflowId,
          correlationId: input.correlationId,
        });
        await createOutboxRepository(client).append({
          ...scope,
          actorId: input.actorId,
          eventId: input.outboxEventId,
          eventType: BACKLINK_PROJECT_ANALYSIS_REQUESTED,
          aggregateId: input.snapshotId,
          aggregateVersion: input.snapshotVersion,
          idempotencyKey: `project-analysis:${input.snapshotVersion}`,
          payload: {
            ...scope,
            jobId: input.jobId,
            workflowId,
            snapshotVersion: input.snapshotVersion,
          },
          payloadSchemaVersion: 1,
        });
        return {
          state: "projected",
          snapshotVersion: input.snapshotVersion,
          inputRequired: false,
          jobScheduled: jobCreated,
          jobId: input.jobId,
        };
      });
    },
  });
}
