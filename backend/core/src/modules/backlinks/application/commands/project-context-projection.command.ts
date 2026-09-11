import { randomUUID } from "node:crypto";

import type { ProjectContextSnapshotStatus } from "../../db/repositories/project-context-snapshot.repository.js";
import { createProjectContextSnapshotRepository } from "../../db/repositories/project-context-snapshot.repository.js";
import { createProjectInputPersistenceTransactionRepository } from "../../db/repositories/project-input-persistence.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTransactionClient,
  type BacklinkTenantPool,
} from "../../db/tenant-transaction.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import type {
  GenerationInputPins,
  ProjectOutreachProfile,
  SharedSeoEvidenceSnapshot,
} from "../../ports/shared-seo-evidence.port.js";

export type ProjectContextProjectionInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
  actorSessionId: string;
  actorRoles: readonly string[];
  correlationId: string;
  snapshotId: string;
  snapshotVersion: number;
  projectStatus: ProjectContextSnapshotStatus;
  canonicalDomain: string;
  locale: string;
  countryCode: string;
  targetMarket: string;
  profileVersionId: string;
  promotionTargetVersionId: string;
  products: readonly string[];
  keywords: readonly string[];
  targetUrls: readonly string[];
  targetAudiences: readonly string[];
  partnershipGoals: readonly string[];
  inputComplete: boolean;
  jobId: string;
  outboxEventId: string;
  outreachProfile: Readonly<{
    recordId: string;
    immutableFingerprint: string;
    profile: ProjectOutreachProfile;
  }>;
  sharedSeoEvidence: readonly Readonly<{
    recordId: string;
    snapshot: SharedSeoEvidenceSnapshot;
  }>[];
  generationInputPins: Readonly<{
    recordId: string;
    outreachProfileRecordId: string;
    immutableFingerprint: string;
    pins: GenerationInputPins;
  }>;
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

const generationInputPinContractByPoolContract = Object.freeze({
  "recommendation-pool.v2": "recommendation-pool-admission.v2",
});
const allowedGenerationInputPinContracts = new Set<string>(
  Object.values(generationInputPinContractByPoolContract),
);

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
    `WITH latest AS (
       SELECT version, settings_values
         FROM backlink_project_settings_versions
        WHERE organization_id = $2
          AND workspace_id = $3
          AND website_project_id = $4
        ORDER BY version DESC
        LIMIT 1
     ),
     desired AS (
       SELECT
         COALESCE(latest.version, 0) + 1 AS version,
         COALESCE(
           latest.settings_values,
           jsonb_build_object(
             'reportingTimezone', 'Asia/Shanghai',
             'reportLookbackDays', 30,
             'exportExpiryHours', 24,
             'discoveryExplicitCompetitorDomains', jsonb_build_array()
           )
         ) || jsonb_build_object(
           'discoveryTargetAudiences', $6::jsonb,
           'discoveryPartnershipGoals', $7::jsonb
         ) AS settings_values,
         latest.settings_values AS previous_settings_values
       FROM (SELECT 1) seed
       LEFT JOIN latest ON true
     )
     INSERT INTO backlink_project_settings_versions (
       id, organization_id, workspace_id, website_project_id,
       version, settings_values, created_by
     )
     SELECT $1, $2, $3, $4, version, settings_values, $5
       FROM desired
      WHERE previous_settings_values IS DISTINCT FROM settings_values
     ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      ...scopeValues,
      input.actorId,
      JSON.stringify(input.targetAudiences),
      JSON.stringify(input.partnershipGoals),
    ],
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
  latest: NonNullable<
    Awaited<
      ReturnType<
        ReturnType<typeof createProjectContextSnapshotRepository>["findLatest"]
      >
    >
  >,
  input: ProjectContextProjectionInput,
): boolean {
  const sameStrings = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
  return (
    latest.snapshotId !== input.snapshotId ||
    latest.projectStatus !== input.projectStatus ||
    latest.canonicalDomain !== input.canonicalDomain ||
    latest.locale !== input.locale ||
    latest.countryCode !== input.countryCode ||
    latest.targetMarket !== input.targetMarket ||
    latest.profileVersionId !== input.profileVersionId ||
    latest.promotionTargetVersionId !== input.promotionTargetVersionId ||
    !sameStrings(latest.products, input.products) ||
    !sameStrings(latest.keywords, input.keywords) ||
    !sameStrings(latest.targetUrls, input.targetUrls) ||
    !sameStrings(latest.targetAudiences, input.targetAudiences) ||
    !sameStrings(latest.partnershipGoals, input.partnershipGoals)
  );
}

function conflict(message: string): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message,
  });
}

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertProjectionInputBinding(
  input: ProjectContextProjectionInput,
): void {
  const profileEnvelope = input.outreachProfile;
  const profile = profileEnvelope.profile;
  const pinEnvelope = input.generationInputPins;
  const pins = pinEnvelope.pins;
  const sharedEvidenceIds = input.sharedSeoEvidence.map(
    (item) => item.recordId,
  );
  const keywordEvidenceIds = input.sharedSeoEvidence
    .filter((item) => item.snapshot.sourceModule === "keywords")
    .map((item) => item.recordId);
  const evidenceIdsAreUnique =
    new Set(sharedEvidenceIds).size === sharedEvidenceIds.length;
  if (
    profileEnvelope.immutableFingerprint !== profile.immutableFingerprint ||
    profile.organizationId !== input.organizationId ||
    profile.websiteProjectId !== input.websiteProjectId ||
    profile.profileVersionId !== input.profileVersionId ||
    profile.promotionTargetVersionId !== input.promotionTargetVersionId ||
    profile.market !== input.targetMarket ||
    profile.location !== input.countryCode ||
    profile.language !== input.locale ||
    !sameStringList(profile.productsAndServices, input.products) ||
    !sameStringList(profile.keywordsAndTopics, input.keywords) ||
    !sameStringList(profile.targetUrls, input.targetUrls) ||
    !sameStringList(profile.targetAudiences, input.targetAudiences) ||
    !sameStringList(profile.partnershipGoals, input.partnershipGoals)
  ) {
    throw conflict(
      "The projected outreach profile is bound to different project facts.",
    );
  }
  if (
    pinEnvelope.outreachProfileRecordId !== profileEnvelope.recordId ||
    pins.organizationId !== input.organizationId ||
    pins.websiteProjectId !== input.websiteProjectId ||
    pins.projectContextVersion !== input.snapshotVersion ||
    pins.siteProfileVersionId !== input.profileVersionId ||
    pins.outreachProfileVersionId !== input.profileVersionId ||
    pins.promotionTargetVersionId !== input.promotionTargetVersionId ||
    pins.market !== input.targetMarket ||
    !allowedGenerationInputPinContracts.has(
      pins.qualificationContractVersion,
    ) ||
    !evidenceIdsAreUnique ||
    !sameStringList(pins.sharedEvidenceSnapshotIds, sharedEvidenceIds) ||
    !sameStringList(pins.keywordEvidenceSnapshotIds, keywordEvidenceIds)
  ) {
    throw conflict(
      "The generation input pin is bound to different project facts.",
    );
  }
  for (const evidence of input.sharedSeoEvidence) {
    const snapshot = evidence.snapshot;
    if (
      snapshot.organizationId !== input.organizationId ||
      snapshot.websiteProjectId !== input.websiteProjectId ||
      snapshot.market !== input.targetMarket ||
      snapshot.location !== input.countryCode ||
      snapshot.language !== input.locale
    ) {
      throw conflict(
        "Shared SEO evidence is bound to a different project or market.",
      );
    }
  }
  if (!input.inputComplete) {
    return;
  }
  const requiredProfileEvidence = input.sharedSeoEvidence.find(
    (item) => item.snapshot.sourceModule === "site-profile",
  );
  const requiredPromotionEvidence =
    input.keywords.length > 0
      ? undefined
      : input.sharedSeoEvidence.find(
          (item) => item.snapshot.sourceModule === "content",
        );
  const isReady = (
    evidence: ProjectContextProjectionInput["sharedSeoEvidence"][number],
  ) => evidence.snapshot.status === "ready";
  if (
    input.products.length === 0 ||
    requiredProfileEvidence === undefined ||
    (input.keywords.length === 0 && input.targetUrls.length === 0) ||
    (input.keywords.length === 0 &&
      (requiredPromotionEvidence === undefined ||
        !isReady(requiredPromotionEvidence)))
  ) {
    throw conflict(
      "The Website Project does not contain the minimum sufficient discovery evidence.",
    );
  }
  if (!isReady(requiredProfileEvidence)) {
    throw conflict("The Website Project site profile evidence is unavailable.");
  }
}

async function persistProjectionInput(
  client: BacklinkTransactionClient,
  input: ProjectContextProjectionInput,
): Promise<void> {
  if (!input.inputComplete) {
    return;
  }
  const repository = createProjectInputPersistenceTransactionRepository(client);
  const outreachProfileRecordId = await repository.saveOutreachProfile({
    recordId: input.outreachProfile.recordId,
    workspaceId: input.workspaceId,
    createdBy: input.actorId,
    profile: input.outreachProfile.profile,
  });
  const persistedEvidenceIds = new Map<string, string>();
  for (const evidence of input.sharedSeoEvidence) {
    const persistedId = await repository.saveSharedSeoEvidenceReference({
      recordId: evidence.recordId,
      workspaceId: input.workspaceId,
      createdBy: input.actorId,
      snapshot: evidence.snapshot,
    });
    persistedEvidenceIds.set(evidence.recordId, persistedId);
  }
  const mapEvidenceId = (recordId: string): string => {
    const persistedId = persistedEvidenceIds.get(recordId);
    if (persistedId === undefined) {
      throw conflict(
        `Pinned shared SEO evidence ${recordId} was not persisted.`,
      );
    }
    return persistedId;
  };
  await repository.saveGenerationInputPins({
    recordId: input.generationInputPins.recordId,
    workspaceId: input.workspaceId,
    outreachProfileRecordId,
    createdBy: input.actorId,
    immutableFingerprint: input.generationInputPins.immutableFingerprint,
    pins: {
      ...input.generationInputPins.pins,
      keywordEvidenceSnapshotIds:
        input.generationInputPins.pins.keywordEvidenceSnapshotIds.map(
          mapEvidenceId,
        ),
      sharedEvidenceSnapshotIds:
        input.generationInputPins.pins.sharedEvidenceSnapshotIds.map(
          mapEvidenceId,
        ),
    },
  });
}

async function initializeRecommendationPoolV2(
  client: BacklinkTransactionClient,
  input: ProjectContextProjectionInput,
): Promise<void> {
  if (!input.inputComplete || input.projectStatus !== "ACTIVE") return;
  // Existing migration state and immutable historical lineage are never replaced.
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_pool_project_contracts (
       id,organization_id,workspace_id,website_project_id,
       pool_contract_version,migration_state,created_by,updated_by
     ) SELECT $1,$2,$3,$4,'recommendation-pool.v2','V2_READY',$5,$5
       WHERE NOT EXISTS (
         SELECT 1 FROM backlinks.backlink_recommendation_generation_contracts
          WHERE organization_id=$2 AND workspace_id=$3 AND website_project_id=$4
       )
     ON CONFLICT (organization_id,workspace_id,website_project_id)
     DO NOTHING`,
    [
      randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.actorId,
    ],
  );
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
        assertProjectionInputBinding(input);
        const snapshots = createProjectContextSnapshotRepository(client);
        const latest = await snapshots.findLatest(scope);
        if (latest !== null && latest.snapshotVersion > input.snapshotVersion) {
          throw conflict("The Website Project context projection is stale.");
        }
        if (
          latest !== null &&
          latest.snapshotVersion === input.snapshotVersion
        ) {
          if (conflicts(latest, input)) {
            throw conflict(
              "The Website Project context version is bound to different facts.",
            );
          }
          await initializeProjectRuntimeGovernance(client, input, capabilities);
          await persistProjectionInput(client, input);
          await initializeRecommendationPoolV2(client, input);
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
          targetMarket: input.targetMarket,
          profileVersionId: input.profileVersionId,
          promotionTargetVersionId: input.promotionTargetVersionId,
          products: input.products,
          keywords: input.keywords,
          targetUrls: input.targetUrls,
          targetAudiences: input.targetAudiences,
          partnershipGoals: input.partnershipGoals,
          actorId: input.actorId,
        });
        await persistProjectionInput(client, input);
        await initializeProjectRuntimeGovernance(client, input, capabilities);
        await initializeRecommendationPoolV2(client, input);
        await staleContactEnrichmentJobs(client, input);

        // V2 inputs are ready atomically; generation starts only on an explicit command.
        return {
          state: "projected",
          snapshotVersion: input.snapshotVersion,
          inputRequired: !input.inputComplete,
          jobScheduled: false,
          jobId: null,
        };
      });
    },
  });
}
