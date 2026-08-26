import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../tenant-transaction.js";
import type {
  GenerationInputBinding,
  PersistGenerationInputPinsInput,
  PersistOutreachProfileInput,
  PersistSharedSeoEvidenceReferenceInput,
  ProjectInputPersistencePort,
  ProjectOutreachProfile,
  ReadGenerationInputBindingInput,
  ReadGenerationInputBindingForContextInput,
  SharedSeoEvidenceSnapshot,
} from "../../ports/shared-seo-evidence.port.js";
import { ProjectInputBindingIntegrityError } from "../../ports/shared-seo-evidence.port.js";

const persistedId = (
  result: Readonly<{ rows: readonly Record<string, unknown>[] }>,
): string => {
  const id = result.rows[0]?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("Immutable Backlinks project input was not persisted.");
  }
  return id;
};

const tenantContext = (
  organizationId: string,
  workspaceId: string,
  websiteProjectId: string,
) => ({ organizationId, workspaceId, websiteProjectId });

const invalidBinding = (message: string): never => {
  throw new ProjectInputBindingIntegrityError(message);
};

const asString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    return invalidBinding(`Generation input binding has invalid ${field}.`);
  }
  return value;
};

const asOptionalString = (value: unknown, field: string): string | null => {
  if (value === null) {
    return null;
  }
  return asString(value, field);
};

const asPositiveInteger = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return invalidBinding(`Generation input binding has invalid ${field}.`);
  }
  return value;
};

const asStringArray = (value: unknown, field: string): readonly string[] => {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    return invalidBinding(`Generation input binding has invalid ${field}.`);
  }
  return Object.freeze([...value]);
};

const asRecord = (
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidBinding(`Generation input binding has invalid ${field}.`);
  }
  return Object.freeze({ ...value });
};

const asIso = (value: unknown, field: string): string => {
  const date = value instanceof Date
    ? value
    : typeof value === "string"
      ? new Date(value)
      : null;
  if (date === null || !Number.isFinite(date.getTime())) {
    return invalidBinding(`Generation input binding has invalid ${field}.`);
  }
  return date.toISOString();
};

const asNullableCost = (value: unknown): number | null => {
  if (value === null) {
    return null;
  }
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.length > 0
      ? Number(value)
      : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0
  ) {
    return invalidBinding("Generation input binding has invalid costMicros.");
  }
  return parsed;
};

const asSourceModule = (
  value: unknown,
): SharedSeoEvidenceSnapshot["sourceModule"] => {
  if (
    value !== "site-profile" &&
    value !== "keywords" &&
    value !== "competitor-serp" &&
    value !== "content" &&
    value !== "gsc"
  ) {
    return invalidBinding(
      "Generation input binding has invalid evidence sourceModule.",
    );
  }
  return value;
};

const asEvidenceStatus = (
  value: unknown,
): SharedSeoEvidenceSnapshot["status"] => {
  if (value !== "ready" && value !== "expired" && value !== "failed") {
    return invalidBinding(
      "Generation input binding has invalid evidence status.",
    );
  }
  return value;
};

async function saveOutreachProfile(
  client: BacklinkTransactionClient,
  input: PersistOutreachProfileInput,
): Promise<string> {
  const profile = input.profile;
  const result = await client.query(
    `WITH inserted AS (
       INSERT INTO backlinks.backlink_outreach_profile_versions (
         id, organization_id, workspace_id, website_project_id,
         profile_version_id, promotion_target_version_id,
         keywords_and_topics, products_and_services, target_urls,
         target_audiences, partnership_goals, market, location, language,
         authorized_discovery_sources, immutable_fingerprint, created_by
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
         $10::jsonb, $11::jsonb, $12, $13, $14, $15::jsonb, $16, $17
       )
       ON CONFLICT (
         organization_id, workspace_id, website_project_id,
         immutable_fingerprint
       ) DO NOTHING
       RETURNING id
     )
     SELECT id::text AS id FROM inserted
     UNION ALL
     SELECT id::text AS id
       FROM backlinks.backlink_outreach_profile_versions
      WHERE organization_id = $2
        AND workspace_id = $3
        AND website_project_id = $4
        AND immutable_fingerprint = $16
     LIMIT 1`,
    [
      input.recordId,
      profile.organizationId,
      input.workspaceId,
      profile.websiteProjectId,
      profile.profileVersionId,
      profile.promotionTargetVersionId,
      JSON.stringify(profile.keywordsAndTopics),
      JSON.stringify(profile.productsAndServices),
      JSON.stringify(profile.targetUrls),
      JSON.stringify(profile.targetAudiences),
      JSON.stringify(profile.partnershipGoals),
      profile.market,
      profile.location,
      profile.language,
      JSON.stringify(profile.authorizedDiscoverySources),
      profile.immutableFingerprint,
      input.createdBy,
    ],
  );
  return persistedId(result);
}

async function saveSharedSeoEvidenceReference(
  client: BacklinkTransactionClient,
  input: PersistSharedSeoEvidenceReferenceInput,
): Promise<string> {
  const snapshot = input.snapshot;
  const result = await client.query(
    `WITH inserted AS (
       INSERT INTO backlinks.backlink_shared_seo_evidence_references (
         id, organization_id, workspace_id, website_project_id,
         evidence_type, source_module, source_record_id, source_version,
         provider, endpoint, normalized_parameters, request_fingerprint,
         market, location, language, fetched_at, expires_at,
         provider_request_id, provider_task_id, cost_micros, artifact_ref,
         status, created_by
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12,
         $13, $14, $15, $16::timestamptz, $17::timestamptz, $18, $19,
         $20, $21, $22, $23
       )
       ON CONFLICT (
         organization_id, workspace_id, website_project_id,
         source_module, source_record_id, source_version
       ) DO NOTHING
       RETURNING id
     )
     SELECT id::text AS id FROM inserted
     UNION ALL
     SELECT id::text AS id
       FROM backlinks.backlink_shared_seo_evidence_references
      WHERE organization_id = $2
        AND workspace_id = $3
        AND website_project_id = $4
        AND source_module = $6
        AND source_record_id = $7
        AND source_version = $8
     LIMIT 1`,
    [
      input.recordId,
      snapshot.organizationId,
      input.workspaceId,
      snapshot.websiteProjectId,
      snapshot.evidenceType,
      snapshot.sourceModule,
      snapshot.sourceRecordId,
      snapshot.sourceVersion,
      snapshot.provider,
      snapshot.endpoint,
      JSON.stringify(snapshot.normalizedParameters),
      snapshot.requestFingerprint,
      snapshot.market,
      snapshot.location,
      snapshot.language,
      snapshot.fetchedAt,
      snapshot.expiresAt,
      snapshot.providerRequestId,
      snapshot.providerTaskId,
      snapshot.costMicros,
      snapshot.artifactRef,
      snapshot.status,
      input.createdBy,
    ],
  );
  return persistedId(result);
}

async function saveGenerationInputPins(
  client: BacklinkTransactionClient,
  input: PersistGenerationInputPinsInput,
): Promise<string> {
  const pins = input.pins;
  const result = await client.query(
    `WITH inserted AS (
       INSERT INTO backlinks.backlink_generation_input_pins (
         id, organization_id, workspace_id, website_project_id,
         project_context_version, site_profile_version_id,
         outreach_profile_version_id, promotion_target_version_id,
         keyword_evidence_snapshot_ids, shared_evidence_snapshot_ids,
         market, qualification_contract_version, immutable_fingerprint,
         created_by
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
         $11, $12, $13, $14
       )
       ON CONFLICT (
         organization_id, workspace_id, website_project_id,
         immutable_fingerprint
       ) DO NOTHING
       RETURNING id
     )
     SELECT id::text AS id FROM inserted
     UNION ALL
     SELECT id::text AS id
       FROM backlinks.backlink_generation_input_pins
      WHERE organization_id = $2
        AND workspace_id = $3
        AND website_project_id = $4
        AND immutable_fingerprint = $13
     LIMIT 1`,
    [
      input.recordId,
      pins.organizationId,
      input.workspaceId,
      pins.websiteProjectId,
      pins.projectContextVersion,
      pins.siteProfileVersionId,
      input.outreachProfileRecordId,
      pins.promotionTargetVersionId,
      JSON.stringify(pins.keywordEvidenceSnapshotIds),
      JSON.stringify(pins.sharedEvidenceSnapshotIds),
      pins.market,
      pins.qualificationContractVersion,
      input.immutableFingerprint,
      input.createdBy,
    ],
  );
  return persistedId(result);
}

async function readGenerationInputBinding(
  client: BacklinkTransactionClient,
  input: ReadGenerationInputBindingInput,
): Promise<GenerationInputBinding | null> {
  const result = await client.query(
    `SELECT pin.id::text AS "inputPinId",
            pin.project_context_version AS "projectContextVersion",
            pin.site_profile_version_id AS "siteProfileVersionId",
            pin.promotion_target_version_id AS "pinPromotionTargetVersionId",
            pin.keyword_evidence_snapshot_ids AS "keywordEvidenceSnapshotIds",
            pin.shared_evidence_snapshot_ids AS "sharedEvidenceSnapshotIds",
            pin.market AS "pinMarket",
            pin.qualification_contract_version
              AS "qualificationContractVersion",
            pin.immutable_fingerprint AS "immutableFingerprint",
            profile.id::text AS "outreachProfileRecordId",
            profile.profile_version_id AS "outreachProfileVersionId",
            profile.promotion_target_version_id
              AS "profilePromotionTargetVersionId",
            profile.keywords_and_topics AS "keywordsAndTopics",
            profile.products_and_services AS "productsAndServices",
            profile.target_urls AS "targetUrls",
            profile.target_audiences AS "targetAudiences",
            profile.partnership_goals AS "partnershipGoals",
            profile.market AS "profileMarket",
            profile.location AS "profileLocation",
            profile.language AS "profileLanguage",
            profile.authorized_discovery_sources
              AS "authorizedDiscoverySources",
            profile.immutable_fingerprint AS "profileImmutableFingerprint"
       FROM backlinks.backlink_generation_input_pins AS pin
       JOIN backlinks.backlink_outreach_profile_versions AS profile
         ON (profile.organization_id, profile.workspace_id,
             profile.website_project_id, profile.id) =
            (pin.organization_id, pin.workspace_id,
             pin.website_project_id, pin.outreach_profile_version_id)
      WHERE pin.organization_id = $1
        AND pin.workspace_id = $2
        AND pin.website_project_id = $3
        AND pin.id = $4
        AND pin.qualification_contract_version = $5
        AND pin.market = $6
      LIMIT 1`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.inputPinId,
      input.qualificationContractVersion,
      input.market,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }

  const inputPinId = asString(row.inputPinId, "inputPinId");
  const outreachProfileRecordId = asString(
    row.outreachProfileRecordId,
    "outreachProfileRecordId",
  );
  const outreachProfileVersionId = asString(
    row.outreachProfileVersionId,
    "outreachProfileVersionId",
  );
  const promotionTargetVersionId = asString(
    row.pinPromotionTargetVersionId,
    "promotionTargetVersionId",
  );
  const pinMarket = asString(row.pinMarket, "market");
  const profilePromotionTargetVersionId = asString(
    row.profilePromotionTargetVersionId,
    "profilePromotionTargetVersionId",
  );
  const profileMarket = asString(row.profileMarket, "profileMarket");
  if (
    inputPinId !== input.inputPinId ||
    promotionTargetVersionId !== profilePromotionTargetVersionId ||
    pinMarket !== input.market ||
    pinMarket !== profileMarket
  ) {
    return invalidBinding(
      "Generation input pin is inconsistent with its outreach profile.",
    );
  }

  const sharedEvidenceSnapshotIds = asStringArray(
    row.sharedEvidenceSnapshotIds,
    "sharedEvidenceSnapshotIds",
  );
  const pins = Object.freeze({
    organizationId: input.organizationId,
    websiteProjectId: input.websiteProjectId,
    projectContextVersion: asPositiveInteger(
      row.projectContextVersion,
      "projectContextVersion",
    ),
    siteProfileVersionId: asString(
      row.siteProfileVersionId,
      "siteProfileVersionId",
    ),
    outreachProfileVersionId,
    promotionTargetVersionId,
    keywordEvidenceSnapshotIds: asStringArray(
      row.keywordEvidenceSnapshotIds,
      "keywordEvidenceSnapshotIds",
    ),
    sharedEvidenceSnapshotIds,
    market: pinMarket,
    qualificationContractVersion: asString(
      row.qualificationContractVersion,
      "qualificationContractVersion",
    ),
  });
  const outreachProfile: ProjectOutreachProfile = Object.freeze({
    organizationId: input.organizationId,
    websiteProjectId: input.websiteProjectId,
    profileVersionId: outreachProfileVersionId,
    promotionTargetVersionId: profilePromotionTargetVersionId,
    keywordsAndTopics: asStringArray(
      row.keywordsAndTopics,
      "keywordsAndTopics",
    ),
    productsAndServices: asStringArray(
      row.productsAndServices,
      "productsAndServices",
    ),
    targetUrls: asStringArray(row.targetUrls, "targetUrls"),
    targetAudiences: asStringArray(row.targetAudiences, "targetAudiences"),
    partnershipGoals: asStringArray(
      row.partnershipGoals,
      "partnershipGoals",
    ),
    market: profileMarket,
    location: asString(row.profileLocation, "profileLocation"),
    language: asString(row.profileLanguage, "profileLanguage"),
    authorizedDiscoverySources: asStringArray(
      row.authorizedDiscoverySources,
      "authorizedDiscoverySources",
    ),
    immutableFingerprint: asString(
      row.profileImmutableFingerprint,
      "profileImmutableFingerprint",
    ),
  });

  const evidenceRows = sharedEvidenceSnapshotIds.length === 0
    ? []
    : (
        await client.query(
          `SELECT id::text AS "recordId", evidence_type AS "evidenceType",
                  source_module AS "sourceModule",
                  source_record_id AS "sourceRecordId",
                  source_version AS "sourceVersion", provider, endpoint,
                  normalized_parameters AS "normalizedParameters",
                  request_fingerprint AS "requestFingerprint", market,
                  location, language, fetched_at AS "fetchedAt",
                  expires_at AS "expiresAt",
                  provider_request_id AS "providerRequestId",
                  provider_task_id AS "providerTaskId",
                  cost_micros AS "costMicros", artifact_ref AS "artifactRef",
                  status
             FROM backlinks.backlink_shared_seo_evidence_references
            WHERE organization_id = $1
              AND workspace_id = $2
              AND website_project_id = $3
              AND id = ANY($4::uuid[])`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            sharedEvidenceSnapshotIds,
          ],
        )
      ).rows;
  const evidenceById = new Map<string, GenerationInputBinding["sharedEvidence"][number]>();
  for (const evidenceRow of evidenceRows) {
    const recordId = asString(evidenceRow.recordId, "evidence recordId");
    if (evidenceById.has(recordId)) {
      return invalidBinding(
        `Generation input binding contains duplicate evidence ${recordId}.`,
      );
    }
    const snapshot: SharedSeoEvidenceSnapshot = Object.freeze({
      organizationId: input.organizationId,
      websiteProjectId: input.websiteProjectId,
      evidenceType: asString(evidenceRow.evidenceType, "evidenceType"),
      sourceModule: asSourceModule(evidenceRow.sourceModule),
      sourceRecordId: asString(evidenceRow.sourceRecordId, "sourceRecordId"),
      sourceVersion: asString(evidenceRow.sourceVersion, "sourceVersion"),
      provider: asString(evidenceRow.provider, "provider"),
      endpoint: asString(evidenceRow.endpoint, "endpoint"),
      normalizedParameters: asRecord(
        evidenceRow.normalizedParameters,
        "normalizedParameters",
      ),
      requestFingerprint: asString(
        evidenceRow.requestFingerprint,
        "requestFingerprint",
      ),
      market: asString(evidenceRow.market, "evidence market"),
      location: asString(evidenceRow.location, "evidence location"),
      language: asString(evidenceRow.language, "evidence language"),
      fetchedAt: asIso(evidenceRow.fetchedAt, "fetchedAt"),
      expiresAt: asIso(evidenceRow.expiresAt, "expiresAt"),
      providerRequestId: asString(
        evidenceRow.providerRequestId,
        "providerRequestId",
      ),
      providerTaskId: asOptionalString(
        evidenceRow.providerTaskId,
        "providerTaskId",
      ),
      costMicros: asNullableCost(evidenceRow.costMicros),
      artifactRef: asString(evidenceRow.artifactRef, "artifactRef"),
      status: asEvidenceStatus(evidenceRow.status),
    });
    if (
      snapshot.market !== pins.market ||
      snapshot.location !== outreachProfile.location ||
      snapshot.language !== outreachProfile.language
    ) {
      return invalidBinding(
        `Pinned evidence ${recordId} has a different market or locale scope.`,
      );
    }
    evidenceById.set(recordId, Object.freeze({ recordId, snapshot }));
  }
  const sharedEvidence = sharedEvidenceSnapshotIds.map((recordId) => {
    const evidence = evidenceById.get(recordId);
    if (evidence === undefined) {
      return invalidBinding(
        `Generation input binding is missing pinned evidence ${recordId}.`,
      );
    }
    return evidence;
  });

  return Object.freeze({
    inputPinId,
    outreachProfileRecordId,
    immutableFingerprint: asString(
      row.immutableFingerprint,
      "immutableFingerprint",
    ),
    pins,
    outreachProfile,
    sharedEvidence: Object.freeze(sharedEvidence),
  });
}

async function readGenerationInputBindingForContext(
  client: BacklinkTransactionClient,
  input: ReadGenerationInputBindingForContextInput,
): Promise<GenerationInputBinding | null> {
  const result = await client.query(
    `SELECT id::text AS id
       FROM backlinks.backlink_generation_input_pins
      WHERE organization_id = $1
        AND workspace_id = $2
        AND website_project_id = $3
        AND project_context_version = $4
        AND site_profile_version_id = $5
        AND promotion_target_version_id = $6
        AND qualification_contract_version = $7
        AND market = $8
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.projectContextVersion,
      input.siteProfileVersionId,
      input.promotionTargetVersionId,
      input.qualificationContractVersion,
      input.market,
    ],
  );
  const inputPinId = result.rows[0]?.id;
  if (typeof inputPinId !== "string" || inputPinId.length === 0) {
    return null;
  }
  return readGenerationInputBinding(client, {
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
    inputPinId,
    qualificationContractVersion: input.qualificationContractVersion,
    market: input.market,
  });
}

export function createProjectInputPersistenceTransactionRepository(
  client: BacklinkTransactionClient,
): ProjectInputPersistencePort {
  return Object.freeze({
    saveOutreachProfile: (input: PersistOutreachProfileInput) =>
      saveOutreachProfile(client, input),
    saveSharedSeoEvidenceReference: (
      input: PersistSharedSeoEvidenceReferenceInput,
    ) =>
      saveSharedSeoEvidenceReference(client, input),
    saveGenerationInputPins: (input: PersistGenerationInputPinsInput) =>
      saveGenerationInputPins(client, input),
    readGenerationInputBinding: (input: ReadGenerationInputBindingInput) =>
      readGenerationInputBinding(client, input),
    readGenerationInputBindingForContext: (
      input: ReadGenerationInputBindingForContextInput,
    ) =>
      readGenerationInputBindingForContext(client, input),
  });
}

export function createProjectInputPersistenceRepository(
  pool: BacklinkTenantPool,
): ProjectInputPersistencePort {
  return Object.freeze({
    saveOutreachProfile: (input: PersistOutreachProfileInput) =>
      withBacklinkTenantTransaction(
        pool,
        tenantContext(
          input.profile.organizationId,
          input.workspaceId,
          input.profile.websiteProjectId,
        ),
        (client) => saveOutreachProfile(client, input),
      ),
    saveSharedSeoEvidenceReference: (
      input: PersistSharedSeoEvidenceReferenceInput,
    ) =>
      withBacklinkTenantTransaction(
        pool,
        tenantContext(
          input.snapshot.organizationId,
          input.workspaceId,
          input.snapshot.websiteProjectId,
        ),
        (client) => saveSharedSeoEvidenceReference(client, input),
      ),
    saveGenerationInputPins: (input: PersistGenerationInputPinsInput) =>
      withBacklinkTenantTransaction(
        pool,
        tenantContext(
          input.pins.organizationId,
          input.workspaceId,
          input.pins.websiteProjectId,
        ),
        (client) => saveGenerationInputPins(client, input),
      ),
    readGenerationInputBinding: (input: ReadGenerationInputBindingInput) =>
      withBacklinkTenantTransaction(
        pool,
        tenantContext(
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
        ),
        (client) => readGenerationInputBinding(client, input),
      ),
    readGenerationInputBindingForContext: (
      input: ReadGenerationInputBindingForContextInput,
    ) =>
      withBacklinkTenantTransaction(
        pool,
        tenantContext(
          input.organizationId,
          input.workspaceId,
          input.websiteProjectId,
        ),
        (client) => readGenerationInputBindingForContext(client, input),
      ),
  });
}
