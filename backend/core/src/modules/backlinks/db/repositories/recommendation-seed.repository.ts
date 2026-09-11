import { createHash, randomUUID } from "node:crypto";

import type {
  RecommendationSeedCommandRepository,
  RecommendationSeedPersisted,
} from "../../application/commands/recommendation-seeds.command.js";
import {
  prepareRecommendationSeeds,
  type PreparedRecommendationSeed,
  type RecommendationSeedEvidenceRef,
  type RecommendationSeedPreparationV2Result,
  type RecommendationSeedSnapshot,
} from "../../application/services/recommendation-seed-preparation.service.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import { isRecommendationPoolV2ProjectGeneratable } from "../../domain/recommendations/recommendation-pool-v2-project-generation-eligibility.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../tenant-transaction.js";

type PrepareInput = Parameters<
  RecommendationSeedCommandRepository["prepare"]
>[0];
type Scope = Pick<
  PrepareInput,
  "organizationId" | "workspaceId" | "websiteProjectId" | "actorId"
>;
type PersistScope = Scope & Pick<PrepareInput, "requestId">;

type GenerationSnapshot = Readonly<{
  generationContractId: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
  inputPinId: string;
  snapshot: RecommendationSeedSnapshot;
}>;
type GenerationSnapshotReadMode =
  "NATIVE_V2_REQUIRED" | "MIGRATED_CURRENT_ALLOWED";

function conflict(message: string): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message,
  });
}

function asStrings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? Object.freeze(
        value.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        ),
      )
    : Object.freeze([]);
}

function asEvidenceRefs(
  value: unknown,
): readonly RecommendationSeedEvidenceRef[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const references: RecommendationSeedEvidenceRef[] = [];
  const keys = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.evidenceType !== "string" ||
      typeof candidate.recordId !== "string" ||
      typeof candidate.field !== "string"
    ) {
      continue;
    }
    const reference = {
      evidenceType: candidate.evidenceType,
      recordId: candidate.recordId,
      field: candidate.field,
      ...(typeof candidate.fingerprint === "string"
        ? { fingerprint: candidate.fingerprint }
        : {}),
    } as RecommendationSeedEvidenceRef;
    const key = JSON.stringify(reference);
    if (keys.has(key)) continue;
    keys.add(key);
    references.push(Object.freeze(reference));
  }
  return Object.freeze(references);
}

function mergeEvidenceRefs(
  ...values: readonly unknown[]
): readonly RecommendationSeedEvidenceRef[] {
  return asEvidenceRefs(
    values.flatMap((value) => (Array.isArray(value) ? value : [])),
  );
}

function provenanceAssertionFingerprint(
  scope: Scope,
  generation: GenerationSnapshot,
  seed: PreparedRecommendationSeed,
): string {
  const evidenceRefs = [...seed.evidenceRefs]
    .map((reference) => ({
      evidenceType: reference.evidenceType,
      recordId: reference.recordId,
      field: reference.field,
      fingerprint: reference.fingerprint ?? null,
    }))
    .sort((left, right) => {
      const leftKey = JSON.stringify(left);
      const rightKey = JSON.stringify(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return createHash("sha256")
    .update(
      JSON.stringify({
        contract: "recommendation-seed-provenance.v2",
        generationContractId: generation.generationContractId,
        seedFingerprint: seed.seedFingerprint,
        rawValue: seed.rawValue,
        source: seed.source,
        validationStatus: seed.validationStatus,
        validationReasonCodes: [...seed.validationReasonCodes].sort(),
        evidenceRefs,
        confidenceBand: seed.confidenceBand,
        actorId: scope.actorId,
      }),
    )
    .digest("hex");
}

function seedSnapshotFingerprint(
  scope: Scope,
  generation: GenerationSnapshot,
  seeds: RecommendationSeedPersisted["seeds"],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        contract: "recommendation-blueprint-seed-snapshot.v2",
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        websiteProjectId: scope.websiteProjectId,
        generationContractId: generation.generationContractId,
        recommendationContextVersionId:
          generation.recommendationContextVersionId,
        visiblePoolGeneration: generation.visiblePoolGeneration,
        inputPinId: generation.inputPinId,
        seeds: seeds.map((seed, index) => ({
          seedId: seed.id,
          seedFingerprint: seed.seedFingerprint,
          seedOrdinal: index + 1,
        })),
      }),
    )
    .digest("hex");
}

function required(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw conflict(`Recommendation seed snapshot is missing ${key}.`);
  }
  return value;
}

async function loadGenerationSnapshot(
  client: BacklinkTransactionClient,
  scope: Omit<Scope, "actorId"> &
    Readonly<{ targetGenerationContractId?: string }>,
  readMode: GenerationSnapshotReadMode = "NATIVE_V2_REQUIRED",
): Promise<GenerationSnapshot> {
  const result = await client.query(
    `SELECT contract.pool_contract_version "poolContractVersion",
            contract.migration_state "migrationState",
            contract.state_reason_codes "stateReasonCodes",
            CASE
              WHEN contract.migration_state='MIGRATION_BLOCKED'
                THEN COALESCE((
                  backlink_recommendation_pool_v2_native_generation_verify()
                    ->>'v1WritesFrozen'
                )::boolean,false)
              ELSE false
            END "v1WritesFrozen",
            generation.id "generationContractId",
            generation.recommendation_context_version_id
              "recommendationContextVersionId",
            generation.visible_pool_generation "visiblePoolGeneration",
            generation.input_pin_id "inputPinId",
            snapshot.id "projectContextSnapshotId",
            snapshot.snapshot_version "projectContextSnapshotVersion",
            snapshot.canonical_domain "canonicalDomain",
            snapshot.locale,
            snapshot.country_code "countryCode",
            snapshot.profile_version_id "siteProfileVersionId",
            snapshot.promotion_target_version_id
              "promotionTargetVersionId",
            snapshot.keywords "projectKeywords",
            snapshot.products "projectProducts",
            snapshot.target_audiences "projectTargetAudiences",
            snapshot.partnership_goals "projectPartnershipGoals",
            profile.id "outreachProfileVersionId",
            profile.immutable_fingerprint "outreachProfileFingerprint",
            profile.keywords_and_topics "profileKeywords",
            profile.products_and_services "profileProducts",
            profile.target_audiences "profileTargetAudiences",
            profile.partnership_goals "profilePartnershipGoals",
            profile.market,profile.location,profile.language
       FROM backlink_recommendation_pool_project_contracts contract
       JOIN backlink_recommendation_generation_contracts generation
         ON generation.organization_id=contract.organization_id
        AND generation.workspace_id=contract.workspace_id
        AND generation.website_project_id=contract.website_project_id
        AND generation.id=COALESCE(
              $4::uuid,
              contract.generation_contract_id
            )
       JOIN backlink_generation_input_pins pin
         ON (pin.organization_id,pin.workspace_id,pin.website_project_id,
             pin.id)=
            (generation.organization_id,generation.workspace_id,
             generation.website_project_id,generation.input_pin_id)
       JOIN backlink_project_context_snapshots snapshot
         ON (snapshot.organization_id,snapshot.workspace_id,
             snapshot.website_project_id,snapshot.id)=
            (generation.organization_id,generation.workspace_id,
             generation.website_project_id,
             generation.recommendation_context_version_id)
        AND snapshot.snapshot_version=pin.project_context_version
       JOIN backlink_outreach_profile_versions profile
         ON (profile.organization_id,profile.workspace_id,
             profile.website_project_id,profile.id)=
            (pin.organization_id,pin.workspace_id,pin.website_project_id,
             pin.outreach_profile_version_id)
       WHERE contract.organization_id=$1 AND contract.workspace_id=$2
         AND contract.website_project_id=$3
         AND contract.pool_contract_version='recommendation-pool.v2'
         AND (
           $5::boolean
           OR (
             generation.pool_contract_version='recommendation-pool.v2'
             AND generation.qualification_contract_version=
                 'recommendation-pool-admission.v2'
             AND generation.visibility_contract_version=
                 'recommendation-pool-release-visibility.v2'
             AND generation.score_model_version=
                 'recommendation-pool-materialization.v2'
             AND generation.creator_worker_contract_version=
                 'recommendation-pool-worker.v2'
             AND generation.seed_contract_version='recommendation-seed.v2'
             AND pin.qualification_contract_version=
                 'recommendation-pool-admission.v2'
           )
         )
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_project_context_snapshots newer
           WHERE newer.organization_id=snapshot.organization_id
             AND newer.workspace_id=snapshot.workspace_id
             AND newer.website_project_id=snapshot.website_project_id
             AND newer.snapshot_version>snapshot.snapshot_version
        )
        AND pin.site_profile_version_id=snapshot.profile_version_id
        AND pin.promotion_target_version_id=
            snapshot.promotion_target_version_id
        AND pin.market=profile.market`,
    [
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      scope.targetGenerationContractId ?? null,
      readMode === "MIGRATED_CURRENT_ALLOWED",
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw conflict(
      "Recommendation pool V2 has no complete pinned seed snapshot.",
    );
  }
  if (!isRecommendationPoolV2ProjectGeneratable(row)) {
    throw conflict("Recommendation pool V2 project is not generatable.");
  }
  return Object.freeze({
    generationContractId: required(row, "generationContractId"),
    recommendationContextVersionId: required(
      row,
      "recommendationContextVersionId",
    ),
    visiblePoolGeneration: Number(row.visiblePoolGeneration),
    inputPinId: required(row, "inputPinId"),
    snapshot: mapSeedSnapshot(row),
  });
}

function mapSeedSnapshot(row: Record<string, unknown>): RecommendationSeedSnapshot {
  const snapshot: RecommendationSeedSnapshot = Object.freeze({
    projectContextSnapshotId: required(row, "projectContextSnapshotId"),
    projectContextSnapshotVersion: Number(row.projectContextSnapshotVersion),
    canonicalDomain: required(row, "canonicalDomain"),
    locale: required(row, "locale"),
    countryCode: required(row, "countryCode"),
    siteProfileVersionId: required(row, "siteProfileVersionId"),
    outreachProfileVersionId: required(row, "outreachProfileVersionId"),
    outreachProfileFingerprint: required(row, "outreachProfileFingerprint"),
    promotionTargetVersionId: required(row, "promotionTargetVersionId"),
    market: required(row, "market"),
    location: required(row, "location"),
    language: required(row, "language"),
    keywords: Object.freeze([
      ...asStrings(row.projectKeywords),
      ...asStrings(row.profileKeywords),
    ]),
    categories: Object.freeze([
      ...asStrings(row.projectPartnershipGoals),
      ...asStrings(row.profilePartnershipGoals),
    ]),
    products: Object.freeze([
      ...asStrings(row.projectProducts),
      ...asStrings(row.profileProducts),
    ]),
    targetAudiences: Object.freeze([
      ...asStrings(row.projectTargetAudiences),
      ...asStrings(row.profileTargetAudiences),
    ]),
    seoCompetitors: Object.freeze([]),
  });
  if (
    !Number.isSafeInteger(snapshot.projectContextSnapshotVersion) ||
    snapshot.projectContextSnapshotVersion < 1
  ) {
    throw conflict("Recommendation seed snapshot version is invalid.");
  }
  return snapshot;
}

async function loadInitialPreview(
  client: BacklinkTransactionClient,
  scope: Scope,
) {
  const result = await client.query(
    `SELECT pin.id "inputPinId",
            snapshot.id "projectContextSnapshotId",
            snapshot.snapshot_version "projectContextSnapshotVersion",
            snapshot.canonical_domain "canonicalDomain",
            snapshot.locale,snapshot.country_code "countryCode",
            snapshot.profile_version_id "siteProfileVersionId",
            snapshot.promotion_target_version_id "promotionTargetVersionId",
            snapshot.keywords "projectKeywords",snapshot.products "projectProducts",
            snapshot.target_audiences "projectTargetAudiences",
            snapshot.partnership_goals "projectPartnershipGoals",
            profile.id "outreachProfileVersionId",
            profile.immutable_fingerprint "outreachProfileFingerprint",
            profile.keywords_and_topics "profileKeywords",
            profile.products_and_services "profileProducts",
            profile.target_audiences "profileTargetAudiences",
            profile.partnership_goals "profilePartnershipGoals",
            profile.market,profile.location,profile.language
       FROM backlink_recommendation_pool_project_contracts contract
       JOIN LATERAL (
         SELECT candidate.* FROM backlink_project_context_snapshots candidate
          WHERE candidate.organization_id=contract.organization_id
            AND candidate.workspace_id=contract.workspace_id
            AND candidate.website_project_id=contract.website_project_id
          ORDER BY candidate.snapshot_version DESC LIMIT 1
       ) snapshot ON snapshot.project_status='ACTIVE'
       JOIN LATERAL (
         SELECT candidate.* FROM backlink_generation_input_pins candidate
          WHERE candidate.organization_id=contract.organization_id
            AND candidate.workspace_id=contract.workspace_id
            AND candidate.website_project_id=contract.website_project_id
            AND candidate.project_context_version=snapshot.snapshot_version
            AND candidate.site_profile_version_id=snapshot.profile_version_id
            AND candidate.promotion_target_version_id=snapshot.promotion_target_version_id
            AND candidate.qualification_contract_version='recommendation-pool-admission.v2'
          ORDER BY candidate.created_at DESC,candidate.id LIMIT 1
       ) pin ON true
       JOIN backlink_outreach_profile_versions profile
         ON (profile.organization_id,profile.workspace_id,profile.website_project_id,profile.id)=
            (pin.organization_id,pin.workspace_id,pin.website_project_id,pin.outreach_profile_version_id)
        AND profile.market=pin.market
      WHERE contract.organization_id=$1 AND contract.workspace_id=$2
        AND contract.website_project_id=$3
        AND contract.pool_contract_version='recommendation-pool.v2'
        AND contract.migration_state='V2_READY'
        AND contract.generation_contract_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM backlink_recommendation_generation_contracts generation
           WHERE generation.organization_id=contract.organization_id
             AND generation.workspace_id=contract.workspace_id
             AND generation.website_project_id=contract.website_project_id
             AND generation.pool_contract_version <> 'recommendation-pool.v2'
        )`,
    [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
  );
  const row = result.rows[0];
  return row === undefined ? null : {
    // Preview hashes are not persisted; confirmation binds seeds to a real generation.
    generationContractId: `recommendation-seed-preview.v2:${required(row, "inputPinId")}`,
    snapshot: mapSeedSnapshot(row),
  };
}

function mapPreparedResponse(
  response: unknown,
): RecommendationSeedPersisted | null {
  if (
    typeof response !== "object" ||
    response === null ||
    !("state" in response) ||
    !("snapshot" in response) ||
    !("seeds" in response) ||
    !Array.isArray(response.seeds) ||
    !("confirmation" in response) ||
    !("blueprintSeedReferences" in response) ||
    !Array.isArray(response.blueprintSeedReferences)
  ) {
    return null;
  }
  return response as RecommendationSeedPersisted;
}

async function replay(
  client: BacklinkTransactionClient,
  input: PrepareInput,
): Promise<RecommendationSeedPersisted | null> {
  const result = await client.query(
    `SELECT organization_id "organizationId",
            website_project_id "websiteProjectId",
            request_hash "requestHash",response_body "responseBody"
       FROM backlink_idempotency_records
      WHERE workspace_id=$1 AND idempotency_key=$2
        AND command_type='recommendation-seeds.prepare.v2'`,
    [input.workspaceId, input.idempotencyKey],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  if (
    row.organizationId !== input.organizationId ||
    row.websiteProjectId !== input.websiteProjectId ||
    row.requestHash !== input.requestHash
  ) {
    throw conflict("Idempotency key is already bound to another seed request.");
  }
  const response = mapPreparedResponse(row.responseBody);
  if (response === null) {
    throw conflict("The recommendation seed request is already in progress.");
  }
  return Object.freeze({ ...response, replayed: true });
}

async function persistSeeds(
  client: BacklinkTransactionClient,
  scope: PersistScope,
  generation: GenerationSnapshot,
  prepared: RecommendationSeedPreparationV2Result,
): Promise<RecommendationSeedPersisted["seeds"]> {
  for (const seed of prepared.seeds) {
    await client.query(
      `INSERT INTO backlink_commercial_discovery_seeds (
         id,organization_id,workspace_id,website_project_id,
         generation_contract_id,recommendation_context_version_id,
         visible_pool_generation,input_pin_id,seed_kind,raw_value,
         normalized_value,source,validation_status,validation_reason_codes,
         evidence_refs,confidence_band,seed_fingerprint,
         supersedes_seed_id,created_by
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,
         $15::jsonb,$16,$17,$18,$19
       )
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         generation_contract_id,seed_kind,normalized_value
       ) DO NOTHING`,
      [
        randomUUID(),
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        generation.generationContractId,
        generation.recommendationContextVersionId,
        generation.visiblePoolGeneration,
        generation.inputPinId,
        seed.kind,
        seed.rawValue,
        seed.normalizedValue,
        seed.source,
        seed.validationStatus,
        JSON.stringify(seed.validationReasonCodes),
        JSON.stringify(seed.evidenceRefs),
        seed.confidenceBand,
        seed.seedFingerprint,
        seed.supersedesSeedId,
        scope.actorId,
      ],
    );
    const assertionFingerprint = provenanceAssertionFingerprint(
      scope,
      generation,
      seed,
    );
    const assertion = await client.query(
      `INSERT INTO backlink_commercial_discovery_seed_provenance_assertions (
         id,organization_id,workspace_id,website_project_id,seed_id,
         generation_contract_id,recommendation_context_version_id,
         visible_pool_generation,seed_fingerprint,asserted_raw_value,
         asserted_source,asserted_validation_status,
         asserted_validation_reason_codes,asserted_evidence_refs,
         asserted_confidence_band,assertion_fingerprint,request_id,created_by
       )
       SELECT $1,canonical.organization_id,canonical.workspace_id,
              canonical.website_project_id,canonical.id,
              canonical.generation_contract_id,
              canonical.recommendation_context_version_id,
              canonical.visible_pool_generation,canonical.seed_fingerprint,
              $8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16
         FROM backlink_commercial_discovery_seeds canonical
        WHERE canonical.organization_id=$2 AND canonical.workspace_id=$3
          AND canonical.website_project_id=$4
          AND canonical.generation_contract_id=$5
          AND canonical.seed_kind=$6 AND canonical.normalized_value=$7
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,
         generation_contract_id,assertion_fingerprint
       ) DO NOTHING`,
      [
        randomUUID(),
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        generation.generationContractId,
        seed.kind,
        seed.normalizedValue,
        seed.rawValue,
        seed.source,
        seed.validationStatus,
        JSON.stringify(seed.validationReasonCodes),
        JSON.stringify(seed.evidenceRefs),
        seed.confidenceBand,
        assertionFingerprint,
        scope.requestId,
        scope.actorId,
      ],
    );
    if (assertion.rowCount === 0) {
      const persistedAssertion = await client.query(
        `SELECT 1
           FROM backlink_commercial_discovery_seed_provenance_assertions
          WHERE organization_id=$1 AND workspace_id=$2
            AND website_project_id=$3 AND generation_contract_id=$4
            AND assertion_fingerprint=$5`,
        [
          scope.organizationId,
          scope.workspaceId,
          scope.websiteProjectId,
          generation.generationContractId,
          assertionFingerprint,
        ],
      );
      if (persistedAssertion.rows[0] === undefined) {
        throw conflict(
          "Recommendation seed provenance could not be persisted.",
        );
      }
    }
  }
  return loadCurrentSeeds(client, scope, generation);
}

async function loadCurrentSeeds(
  client: BacklinkTransactionClient,
  scope: Scope,
  generation: GenerationSnapshot,
): Promise<RecommendationSeedPersisted["seeds"]> {
  const rows = await client.query(
    `SELECT seed.id,seed.seed_kind "kind",
            COALESCE(provenance.asserted_raw_value,seed.raw_value) "rawValue",
            seed.normalized_value "normalizedValue",
            COALESCE(provenance.asserted_source,seed.source) source,
            COALESCE(
              provenance.asserted_validation_status,
              seed.validation_status
            ) "validationStatus",
            COALESCE(
              provenance.asserted_validation_reason_codes,
              seed.validation_reason_codes
            ) "validationReasonCodes",
            seed.evidence_refs "seedEvidenceRefs",
            assertion_evidence.evidence_refs "assertedEvidenceRefs",
            COALESCE(
              provenance.asserted_confidence_band,
              seed.confidence_band
            ) "confidenceBand",
            seed.seed_fingerprint "seedFingerprint",
            seed.supersedes_seed_id "supersedesSeedId"
       FROM backlink_commercial_discovery_seeds seed
       LEFT JOIN LATERAL (
         SELECT assertion.asserted_raw_value,assertion.asserted_source,
                assertion.asserted_validation_status,
                assertion.asserted_validation_reason_codes,
                assertion.asserted_confidence_band
           FROM backlink_commercial_discovery_seed_provenance_assertions assertion
          WHERE assertion.organization_id=seed.organization_id
            AND assertion.workspace_id=seed.workspace_id
            AND assertion.website_project_id=seed.website_project_id
            AND assertion.seed_id=seed.id
            AND assertion.generation_contract_id=seed.generation_contract_id
            AND assertion.recommendation_context_version_id=
                seed.recommendation_context_version_id
            AND assertion.visible_pool_generation=seed.visible_pool_generation
            AND assertion.seed_fingerprint=seed.seed_fingerprint
          ORDER BY CASE assertion.asserted_source
                     WHEN 'USER_INPUT' THEN 4
                     WHEN 'USER_TRIGGERED_GENERATION' THEN 3
                     WHEN 'SYSTEM_SUPPLEMENT' THEN 2
                     WHEN 'SYSTEM_FALLBACK' THEN 1
                     ELSE 0
                   END DESC,
                   assertion.created_at DESC,assertion.id DESC
          LIMIT 1
       ) provenance ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(
                  jsonb_agg(
                    evidence.item
                    ORDER BY assertion.created_at,assertion.id,evidence.ordinality
                  ),
                  '[]'::jsonb
                ) evidence_refs
           FROM backlink_commercial_discovery_seed_provenance_assertions assertion
           CROSS JOIN LATERAL
             jsonb_array_elements(assertion.asserted_evidence_refs)
             WITH ORDINALITY AS evidence(item,ordinality)
          WHERE assertion.organization_id=seed.organization_id
            AND assertion.workspace_id=seed.workspace_id
            AND assertion.website_project_id=seed.website_project_id
            AND assertion.seed_id=seed.id
            AND assertion.generation_contract_id=seed.generation_contract_id
            AND assertion.recommendation_context_version_id=
                seed.recommendation_context_version_id
            AND assertion.visible_pool_generation=seed.visible_pool_generation
            AND assertion.seed_fingerprint=seed.seed_fingerprint
       ) assertion_evidence ON true
      WHERE seed.organization_id=$1 AND seed.workspace_id=$2
        AND seed.website_project_id=$3 AND seed.generation_contract_id=$4
        AND NOT EXISTS (
          SELECT 1
            FROM backlink_commercial_discovery_seeds successor
           WHERE successor.organization_id=seed.organization_id
             AND successor.workspace_id=seed.workspace_id
             AND successor.website_project_id=seed.website_project_id
             AND successor.generation_contract_id=seed.generation_contract_id
             AND successor.supersedes_seed_id=seed.id
        )
      ORDER BY seed.created_at,seed.id`,
    [
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      generation.generationContractId,
    ],
  );
  return Object.freeze(
    rows.rows.map((row) =>
      Object.freeze({
        id: required(row, "id"),
        kind: row.kind as RecommendationSeedPersisted["seeds"][number]["kind"],
        rawValue: required(row, "rawValue"),
        normalizedValue: required(row, "normalizedValue"),
        source:
          row.source as RecommendationSeedPersisted["seeds"][number]["source"],
        validationStatus:
          row.validationStatus as RecommendationSeedPersisted["seeds"][number]["validationStatus"],
        validationReasonCodes: Object.freeze(
          asStrings(row.validationReasonCodes),
        ),
        evidenceRefs: mergeEvidenceRefs(
          row.seedEvidenceRefs,
          row.assertedEvidenceRefs,
        ),
        confidenceBand:
          row.confidenceBand as RecommendationSeedPersisted["seeds"][number]["confidenceBand"],
        seedFingerprint: required(row, "seedFingerprint"),
        supersedesSeedId:
          row.supersedesSeedId === null || row.supersedesSeedId === undefined
            ? null
            : String(row.supersedesSeedId),
      }),
    ),
  );
}

type BlueprintBindingResult = Readonly<{
  references: RecommendationSeedPersisted["blueprintSeedReferences"];
  seedSnapshotFingerprint: string | null;
  reasonCode: string | null;
}>;

function mapBlueprintReferences(
  rows: readonly Record<string, unknown>[],
): RecommendationSeedPersisted["blueprintSeedReferences"] {
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        id: required(row, "id"),
        blueprintId: required(row, "blueprintId"),
        seedId: required(row, "seedId"),
        seedFingerprint: required(row, "seedFingerprint"),
        seedOrdinal: Number(row.seedOrdinal),
      }),
    ),
  );
}

function referencesMatchSeeds(
  references: RecommendationSeedPersisted["blueprintSeedReferences"],
  seeds: RecommendationSeedPersisted["seeds"],
): boolean {
  return references.every((reference, index) => {
    const seed = seeds[index];
    return (
      seed !== undefined &&
      reference.seedOrdinal === index + 1 &&
      reference.seedId === seed.id &&
      reference.seedFingerprint === seed.seedFingerprint
    );
  });
}

async function bindActiveBlueprint(
  client: BacklinkTransactionClient,
  scope: Scope,
  generation: GenerationSnapshot,
  seeds: RecommendationSeedPersisted["seeds"],
): Promise<BlueprintBindingResult> {
  const eligible = seeds.filter(
    (seed) =>
      seed.validationStatus === "VERIFIED" ||
      seed.validationStatus === "RETAINED_LOW_CONFIDENCE",
  );
  const existingAssignmentResult = await client.query(
    `SELECT assignment.id,assignment.blueprint_id "blueprintId",
            assignment.seed_id "seedId",
            assignment.seed_fingerprint "seedFingerprint",
            assignment.seed_ordinal "seedOrdinal",
            blueprint.seed_snapshot_fingerprint "seedSnapshotFingerprint"
       FROM backlink_commercial_blueprint_seeds assignment
       JOIN backlink_commercial_discovery_blueprints blueprint
         ON (blueprint.organization_id,blueprint.workspace_id,
             blueprint.website_project_id,blueprint.id)=
            (assignment.organization_id,assignment.workspace_id,
             assignment.website_project_id,assignment.blueprint_id)
      WHERE assignment.organization_id=$1
        AND assignment.workspace_id=$2
        AND assignment.website_project_id=$3
        AND assignment.generation_contract_id=$4
      ORDER BY assignment.seed_ordinal`,
    [
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      generation.generationContractId,
    ],
  );
  const existingReferences = mapBlueprintReferences(
    existingAssignmentResult.rows,
  );
  if (existingReferences.length > 0) {
    const existingSnapshotFingerprint =
      existingAssignmentResult.rows[0]?.seedSnapshotFingerprint;
    if (
      typeof existingSnapshotFingerprint === "string" &&
      existingReferences.length === eligible.length &&
      referencesMatchSeeds(existingReferences, eligible)
    ) {
      return Object.freeze({
        references: existingReferences,
        seedSnapshotFingerprint: existingSnapshotFingerprint,
        reasonCode: null,
      });
    }
    return Object.freeze({
      references: Object.freeze([]),
      seedSnapshotFingerprint: null,
      reasonCode: "BLUEPRINT_SEED_REBIND_REQUIRED",
    });
  }

  const snapshotFingerprint = seedSnapshotFingerprint(
    scope,
    generation,
    eligible,
  );
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    [
      "recommendation-blueprint-context.v2",
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      generation.recommendationContextVersionId,
    ].join(":"),
  ]);
  await client.query(
    `INSERT INTO backlink_commercial_discovery_blueprints (
       id,organization_id,workspace_id,website_project_id,
       project_context_version_id,blueprint_version,status,generator,
       schema_version,prompt_version,model_version,rule_version,blueprint,
       evidence_refs,seed_snapshot_fingerprint,generated_at,created_by
     )
     SELECT $1,$2,$3,$4,$5,COALESCE(max(blueprint_version),0)+1,
            'active','DETERMINISTIC_FALLBACK','recommendation-blueprint.v2',
            'recommendation-seed.v2',NULL,'recommendation-discovery.v2',
            $6::jsonb,$7::jsonb,$8,statement_timestamp(),$9
       FROM backlink_commercial_discovery_blueprints
      WHERE organization_id=$2 AND workspace_id=$3
        AND website_project_id=$4 AND project_context_version_id=$5
     ON CONFLICT DO NOTHING`,
    [
      randomUUID(),
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      generation.recommendationContextVersionId,
      JSON.stringify({
        contractVersion: "recommendation-blueprint.v2",
        generationContractId: generation.generationContractId,
        recommendationContextVersionId:
          generation.recommendationContextVersionId,
        visiblePoolGeneration: generation.visiblePoolGeneration,
        inputPinId: generation.inputPinId,
        seedSnapshotFingerprint: snapshotFingerprint,
        seeds: eligible.map((seed, index) => ({
          seedId: seed.id,
          seedFingerprint: seed.seedFingerprint,
          seedOrdinal: index + 1,
        })),
      }),
      JSON.stringify(
        mergeEvidenceRefs(...eligible.map((seed) => seed.evidenceRefs)),
      ),
      snapshotFingerprint,
      scope.actorId,
    ],
  );
  const blueprintResult = await client.query(
    `SELECT id
       FROM backlink_commercial_discovery_blueprints
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3 AND project_context_version_id=$4
        AND seed_snapshot_fingerprint=$5 AND status='active'
      LIMIT 1`,
    [
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      generation.recommendationContextVersionId,
      snapshotFingerprint,
    ],
  );
  const blueprintId = blueprintResult.rows[0]?.id;
  if (typeof blueprintId !== "string") {
    throw conflict("Exact V2 recommendation Blueprint could not be persisted.");
  }
  const selectAssignments = () =>
    client.query(
      `SELECT assignment.id,assignment.blueprint_id "blueprintId",
              assignment.seed_id "seedId",
              assignment.seed_fingerprint "seedFingerprint",
              assignment.seed_ordinal "seedOrdinal"
         FROM backlink_commercial_blueprint_seeds assignment
        WHERE assignment.organization_id=$1
          AND assignment.workspace_id=$2
          AND assignment.website_project_id=$3
          AND assignment.blueprint_id=$4
          AND assignment.generation_contract_id=$5
        ORDER BY assignment.seed_ordinal`,
      [
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        blueprintId,
        generation.generationContractId,
      ],
    );
  for (let index = 0; index < eligible.length; index += 1) {
    const seed = eligible[index];
    if (seed === undefined) continue;
    await client.query(
      `INSERT INTO backlink_commercial_blueprint_seeds (
         id,organization_id,workspace_id,website_project_id,blueprint_id,
         seed_id,generation_contract_id,recommendation_context_version_id,
         visible_pool_generation,seed_ordinal,seed_fingerprint,created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (
         organization_id,workspace_id,website_project_id,blueprint_id,seed_id
       ) DO NOTHING`,
      [
        randomUUID(),
        scope.organizationId,
        scope.workspaceId,
        scope.websiteProjectId,
        blueprintId,
        seed.id,
        generation.generationContractId,
        generation.recommendationContextVersionId,
        generation.visiblePoolGeneration,
        index + 1,
        seed.seedFingerprint,
        scope.actorId,
      ],
    );
  }
  const references = mapBlueprintReferences((await selectAssignments()).rows);
  if (
    references.length !== eligible.length ||
    !referencesMatchSeeds(references, eligible)
  ) {
    return Object.freeze({
      references: Object.freeze([]),
      seedSnapshotFingerprint: null,
      reasonCode: "BLUEPRINT_SEED_REBIND_REQUIRED",
    });
  }
  return Object.freeze({
    references,
    seedSnapshotFingerprint: snapshotFingerprint,
    reasonCode: null,
  });
}

async function prepare(
  client: BacklinkTransactionClient,
  input: PrepareInput,
): Promise<RecommendationSeedPersisted> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    [
      "recommendation-seeds.prepare.v2",
      input.workspaceId,
      input.idempotencyKey,
    ].join(":"),
  ]);
  const prior = await replay(client, input);
  if (prior !== null) return prior;

  const generation = await loadGenerationSnapshot(client, input);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    [
      "recommendation-seeds.generation.v2",
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      generation.generationContractId,
    ].join(":"),
  ]);
  const prepared = prepareRecommendationSeeds({
    generationContractId: generation.generationContractId,
    snapshot: generation.snapshot,
    userSeeds: input.userSeeds,
    systemCandidates: input.systemCandidates,
  });
  const seeds = await persistSeeds(client, input, generation, prepared);
  const eligible = seeds.filter(
    (seed) =>
      seed.validationStatus === "VERIFIED" ||
      seed.validationStatus === "RETAINED_LOW_CONFIDENCE",
  );
  const binding =
    eligible.length === 0
      ? Object.freeze({
          references: Object.freeze([]),
          seedSnapshotFingerprint: null,
          reasonCode: "DISCOVERY_SEEDS_REQUIRED",
        })
      : await bindActiveBlueprint(client, input, generation, seeds);
  const ready = binding.reasonCode === null;
  const response: RecommendationSeedPersisted = Object.freeze({
    state: ready ? "READY" : "INPUT_REQUIRED",
    reasonCodes: Object.freeze(
      binding.reasonCode === null ? [] : [binding.reasonCode],
    ),
    replayed: false,
    confirmation:
      ready && binding.seedSnapshotFingerprint !== null
        ? Object.freeze({
            generationContractId: generation.generationContractId,
            seedSnapshotFingerprint: binding.seedSnapshotFingerprint,
          })
        : null,
    snapshot: generation.snapshot,
    seeds,
    blueprintSeedReferences: binding.references,
  });
  await client.query(
    `INSERT INTO backlink_idempotency_records (
       id,organization_id,workspace_id,website_project_id,idempotency_key,
       command_type,request_hash,response_status,response_body,
       response_schema_version,completed_at,expires_at,created_by,updated_by
     ) VALUES (
       $1,$2,$3,$4,$5,'recommendation-seeds.prepare.v2',$6,200,$7::jsonb,
       2,statement_timestamp(),statement_timestamp()+interval '24 hours',
       $8,$8
     )`,
    [
      randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.idempotencyKey,
      input.requestHash,
      JSON.stringify(response),
      input.actorId,
    ],
  );
  return response;
}

export function createRecommendationSeedRepository(
  pool: BacklinkTenantPool,
): RecommendationSeedCommandRepository {
  return Object.freeze({
    prepare(input) {
      return withBacklinkTenantTransaction(pool, input, (client) =>
        prepare(client, input),
      );
    },
    validate(input) {
      return withBacklinkTenantTransaction(pool, input, async (client) => {
        const generation = await loadInitialPreview(client, input) ?? await loadGenerationSnapshot(
          client,
          input,
          "MIGRATED_CURRENT_ALLOWED",
        );
        return prepareRecommendationSeeds({
          generationContractId: generation.generationContractId,
          snapshot: generation.snapshot,
          userSeeds: input.userSeeds,
          systemCandidates: input.systemCandidates,
        });
      });
    },
  });
}
