import { randomUUID } from "node:crypto";

import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import {
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
  withBacklinkTenantTransaction,
} from "../tenant-transaction.js";
import { createIdempotencyRepository } from "./idempotency.repository.js";

type RecommendationUserReleaseScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
}>;

type IdempotentReleaseCommand = Readonly<{
  idempotencyKey: string;
  requestHash: string;
}>;

type ActiveGeneration = Readonly<{
  generationContractId: string;
  recommendationContextVersionId: string;
  visiblePoolGeneration: number;
}>;

export type RecommendationInitialPublicationResult = Readonly<{
  state: "PUBLISHED" | "NOT_READY";
  currentBatchOrdinal: number | null;
  replayed: boolean;
}>;

export type RecommendationGetMoreResult = Readonly<{
  state:
    | "RELEASED"
    | "NOT_UNLOCKED"
    | "NEXT_BATCH_PREPARING"
    | "POOL_EXHAUSTED"
    | "INITIAL_BATCH_NOT_READY";
  currentBatchOrdinal: number | null;
  releasedBatchOrdinal: number | null;
  replayed: boolean;
}>;

export type RecommendationArchiveResult = Readonly<{
  itemId: string;
  archived: boolean;
  replayed: boolean;
}>;

export type RecommendationUserReleaseStatusFacts = Readonly<{
  currentBatchOrdinal: number;
  originalBatchSize: number;
  successfulOpportunityCount: number;
  firstVisibleAt: Date;
  databaseNow: Date;
  previouslyUnlockedAt: Date | null;
  previouslyUnlockReason: "OPPORTUNITY_RATIO" | "ELAPSED_18H" | "NO_GATE" | null;
  nextBatchState: "AVAILABLE" | "PREPARING" | "NONE";
}>;

export type RecommendationUserReleaseRepository = Readonly<{
  getStatus(
    input: RecommendationUserReleaseScope,
  ): Promise<RecommendationUserReleaseStatusFacts | null>;
  publishInitial(
    input: RecommendationUserReleaseScope,
  ): Promise<RecommendationInitialPublicationResult>;
  getMore(
    input: RecommendationUserReleaseScope & IdempotentReleaseCommand,
  ): Promise<RecommendationGetMoreResult>;
  setArchived(
    input: RecommendationUserReleaseScope &
      IdempotentReleaseCommand &
      Readonly<{ itemId: string; archived: boolean }>,
  ): Promise<RecommendationArchiveResult>;
}>;

function conflict(message: string): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message,
  });
}

function notFound(message: string): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.notFound,
    message,
  });
}

function internal(message: string): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.internal,
    message,
  });
}

function parseDatabaseDate(value: unknown, field: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  throw internal(`Recommendation user release ${field} is invalid.`);
}

async function activeGeneration(
  client: BacklinkTransactionClient,
  scope: RecommendationUserReleaseScope,
): Promise<ActiveGeneration> {
  const result = await client.query(
    `SELECT contract.generation_contract_id "generationContractId",
            contract.recommendation_context_version_id
              "recommendationContextVersionId",
            contract.visible_pool_generation "visiblePoolGeneration"
       FROM backlink_recommendation_pool_project_contracts contract
       JOIN backlink_recommendation_generation_contracts generation
         ON (generation.organization_id,generation.workspace_id,
             generation.website_project_id,generation.id)=
            (contract.organization_id,contract.workspace_id,
             contract.website_project_id,contract.generation_contract_id)
      WHERE contract.organization_id=$1 AND contract.workspace_id=$2
        AND contract.website_project_id=$3
        AND contract.pool_contract_version='recommendation-pool.v2'
        AND contract.migration_state='V2_ACTIVE'
        AND generation.pool_contract_version='recommendation-pool.v2'
      FOR SHARE OF contract`,
    [scope.organizationId, scope.workspaceId, scope.websiteProjectId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw conflict(
      "Recommendation pool V2 is not active for user publication.",
    );
  }
  return Object.freeze({
    generationContractId: String(row.generationContractId),
    recommendationContextVersionId: String(row.recommendationContextVersionId),
    visiblePoolGeneration: Number(row.visiblePoolGeneration),
  });
}

async function lockActorGeneration(
  client: BacklinkTransactionClient,
  scope: RecommendationUserReleaseScope,
  generation: ActiveGeneration,
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    [
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      scope.actorId,
      generation.generationContractId,
      "recommendation-user-release",
    ].join(":"),
  ]);
}

async function getStatus(
  client: BacklinkTransactionClient,
  scope: RecommendationUserReleaseScope,
  generation: ActiveGeneration,
): Promise<RecommendationUserReleaseStatusFacts | null> {
  const result = await client.query(
    `SELECT batch.batch_ordinal "currentBatchOrdinal",
            unlock_status.original_batch_size "originalBatchSize",
            unlock_status.successful_opportunity_count
              "successfulOpportunityCount",
            publication.first_visible_at "firstVisibleAt",
            statement_timestamp() "databaseNow",
            user_unlock.unlocked_at "previouslyUnlockedAt",
            user_unlock.reason "previouslyUnlockReason",
            CASE
              WHEN next_batch.state='AVAILABLE' THEN 'AVAILABLE'
              WHEN next_batch.state='PREPARING' THEN 'PREPARING'
              ELSE 'NONE'
            END "nextBatchState"
       FROM backlink_recommendation_user_cursors cursor_state
       JOIN backlink_recommendation_release_batches batch
         ON (batch.organization_id,batch.workspace_id,
             batch.website_project_id,batch.id,
             batch.recommendation_context_version_id,
             batch.visible_pool_generation)=
            (cursor_state.organization_id,cursor_state.workspace_id,
             cursor_state.website_project_id,cursor_state.current_batch_id,
             cursor_state.recommendation_context_version_id,
             cursor_state.visible_pool_generation)
       JOIN backlink_recommendation_user_publications publication
         ON (publication.organization_id,publication.workspace_id,
             publication.website_project_id,publication.user_id,
             publication.batch_id)=
            (cursor_state.organization_id,cursor_state.workspace_id,
             cursor_state.website_project_id,cursor_state.user_id,batch.id)
       CROSS JOIN LATERAL backlink_recommendation_batch_unlock_status(
         cursor_state.organization_id::text,
         cursor_state.workspace_id::text,
         cursor_state.website_project_id::text,
         cursor_state.user_id,
         batch.id::text
       ) unlock_status
       LEFT JOIN backlink_recommendation_user_unlocks user_unlock
         ON (user_unlock.organization_id,user_unlock.workspace_id,
             user_unlock.website_project_id,user_unlock.user_id,
             user_unlock.batch_id)=
            (cursor_state.organization_id,cursor_state.workspace_id,
             cursor_state.website_project_id,cursor_state.user_id,batch.id)
       LEFT JOIN backlink_recommendation_release_batches next_batch
         ON next_batch.organization_id=batch.organization_id
        AND next_batch.workspace_id=batch.workspace_id
        AND next_batch.website_project_id=batch.website_project_id
        AND next_batch.generation_contract_id=batch.generation_contract_id
        AND next_batch.recommendation_context_version_id=
            batch.recommendation_context_version_id
        AND next_batch.visible_pool_generation=batch.visible_pool_generation
        AND next_batch.batch_ordinal=batch.batch_ordinal+1
      WHERE cursor_state.organization_id=$1
        AND cursor_state.workspace_id=$2
        AND cursor_state.website_project_id=$3
        AND cursor_state.recommendation_context_version_id=$4
        AND cursor_state.visible_pool_generation=$5
        AND cursor_state.user_id=$6
        AND batch.generation_contract_id=$7
        AND batch.state='AVAILABLE'
        AND publication.publication_state='ACTIVE'`,
    [
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      generation.recommendationContextVersionId,
      generation.visiblePoolGeneration,
      scope.actorId,
      generation.generationContractId,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return Object.freeze({
    currentBatchOrdinal: Number(row.currentBatchOrdinal),
    originalBatchSize: Number(row.originalBatchSize),
    successfulOpportunityCount: Number(row.successfulOpportunityCount),
    firstVisibleAt: parseDatabaseDate(row.firstVisibleAt, "firstVisibleAt"),
    databaseNow: parseDatabaseDate(row.databaseNow, "databaseNow"),
    previouslyUnlockedAt:
      row.previouslyUnlockedAt === null ||
      row.previouslyUnlockedAt === undefined
        ? null
        : parseDatabaseDate(row.previouslyUnlockedAt, "previouslyUnlockedAt"),
    previouslyUnlockReason:
      row.previouslyUnlockReason === "OPPORTUNITY_RATIO" ||
      row.previouslyUnlockReason === "ELAPSED_18H" ||
      row.previouslyUnlockReason === "NO_GATE"
        ? row.previouslyUnlockReason
        : null,
    nextBatchState:
      row.nextBatchState === "AVAILABLE" || row.nextBatchState === "PREPARING"
        ? row.nextBatchState
        : "NONE",
  });
}

async function ensureInitialPublication(
  client: BacklinkTransactionClient,
  scope: RecommendationUserReleaseScope,
  generation: ActiveGeneration,
  legacyOnly = false,
): Promise<RecommendationInitialPublicationResult> {
  const batch = await client.query(
    `SELECT id,batch_ordinal "batchOrdinal"
       FROM backlink_recommendation_release_batches
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND generation_contract_id=$4
        AND recommendation_context_version_id=$5
        AND visible_pool_generation=$6
        AND batch_ordinal=1 AND state='AVAILABLE'
        AND (
          $7::boolean=false
          OR (
            EXISTS (
              SELECT 1
                FROM backlink_recommendation_release_batch_items AS legacy_item
               WHERE (
                 legacy_item.organization_id,legacy_item.workspace_id,
                 legacy_item.website_project_id,legacy_item.batch_id
               )=(
                 backlink_recommendation_release_batches.organization_id,
                 backlink_recommendation_release_batches.workspace_id,
                 backlink_recommendation_release_batches.website_project_id,
                 backlink_recommendation_release_batches.id
               )
                 AND legacy_item.legacy_imported=true
            )
            AND NOT EXISTS (
              SELECT 1
                FROM backlink_recommendation_release_batch_items AS native_item
               WHERE (
                 native_item.organization_id,native_item.workspace_id,
                 native_item.website_project_id,native_item.batch_id
               )=(
                 backlink_recommendation_release_batches.organization_id,
                 backlink_recommendation_release_batches.workspace_id,
                 backlink_recommendation_release_batches.website_project_id,
                 backlink_recommendation_release_batches.id
               )
                 AND native_item.legacy_imported=false
            )
          )
        )
      FOR SHARE`,
    [
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      generation.generationContractId,
      generation.recommendationContextVersionId,
      generation.visiblePoolGeneration,
      legacyOnly,
    ],
  );
  const batchRow = batch.rows[0];
  if (batchRow === undefined) {
    return Object.freeze({
      state: "NOT_READY",
      currentBatchOrdinal: null,
      replayed: false,
    });
  }

  const publicationCommand = [
    "initial",
    generation.generationContractId,
    generation.visiblePoolGeneration,
  ].join(":");
  const inserted = await client.query(
    `INSERT INTO backlink_recommendation_user_publications (
       id,organization_id,workspace_id,website_project_id,
       recommendation_context_version_id,visible_pool_generation,
       user_id,batch_id,published_by_command_id,created_by,updated_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,$7)
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,user_id,batch_id
     ) DO NOTHING
     RETURNING id`,
    [
      randomUUID(),
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      generation.recommendationContextVersionId,
      generation.visiblePoolGeneration,
      scope.actorId,
      batchRow.id,
      publicationCommand,
    ],
  );
  await client.query(
    `INSERT INTO backlink_recommendation_user_cursors (
       organization_id,workspace_id,website_project_id,
       recommendation_context_version_id,visible_pool_generation,user_id,
       highest_published_batch_ordinal,current_batch_id,updated_by
     ) VALUES ($1,$2,$3,$4,$5,$6,1,$7,$6)
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,
       recommendation_context_version_id,visible_pool_generation,user_id
     ) DO NOTHING`,
    [
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      generation.recommendationContextVersionId,
      generation.visiblePoolGeneration,
      scope.actorId,
      batchRow.id,
    ],
  );
  const cursor = await client.query(
    `SELECT highest_published_batch_ordinal "batchOrdinal"
       FROM backlink_recommendation_user_cursors
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND recommendation_context_version_id=$4
        AND visible_pool_generation=$5 AND user_id=$6`,
    [
      scope.organizationId,
      scope.workspaceId,
      scope.websiteProjectId,
      generation.recommendationContextVersionId,
      generation.visiblePoolGeneration,
      scope.actorId,
    ],
  );
  const cursorRow = cursor.rows[0];
  if (cursorRow === undefined) {
    throw internal("Recommendation publication cursor was not created.");
  }
  return Object.freeze({
    state: "PUBLISHED",
    currentBatchOrdinal: Number(cursorRow.batchOrdinal),
    replayed: inserted.rows[0] === undefined,
  });
}

function completedGetMoreResult(body: unknown): RecommendationGetMoreResult {
  if (typeof body !== "object" || body === null) {
    throw internal("Stored get-more response is invalid.");
  }
  const result = body as Partial<RecommendationGetMoreResult>;
  const storedState = String(result.state);
  if (
    ![
      "RELEASED",
      "NOT_UNLOCKED",
      "NEXT_BATCH_PREPARING",
      "POOL_EXHAUSTED",
      "NO_MORE",
      "INITIAL_BATCH_NOT_READY",
    ].includes(storedState)
  ) {
    throw internal("Stored get-more response is invalid.");
  }
  return Object.freeze({
    state: (storedState === "NO_MORE"
      ? "POOL_EXHAUSTED"
      : storedState) as RecommendationGetMoreResult["state"],
    currentBatchOrdinal:
      result.currentBatchOrdinal === null
        ? null
        : Number(result.currentBatchOrdinal),
    releasedBatchOrdinal:
      result.releasedBatchOrdinal === null
        ? null
        : Number(result.releasedBatchOrdinal),
    replayed: true,
  });
}

function completedArchiveResult(body: unknown): RecommendationArchiveResult {
  if (typeof body !== "object" || body === null) {
    throw internal("Stored recommendation archive response is invalid.");
  }
  const result = body as Partial<RecommendationArchiveResult>;
  if (
    typeof result.itemId !== "string" ||
    typeof result.archived !== "boolean"
  ) {
    throw internal("Stored recommendation archive response is invalid.");
  }
  return Object.freeze({
    itemId: result.itemId,
    archived: result.archived,
    replayed: true,
  });
}

async function beginIdempotency(
  client: BacklinkTransactionClient,
  scope: RecommendationUserReleaseScope,
  input: IdempotentReleaseCommand,
  commandType: string,
) {
  return createIdempotencyRepository(client).begin({
    ...scope,
    recordId: randomUUID(),
    idempotencyKey: input.idempotencyKey,
    commandType,
    requestHash: input.requestHash,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
  });
}

async function completeIdempotency(
  client: BacklinkTransactionClient,
  scope: RecommendationUserReleaseScope,
  recordId: string,
  body: RecommendationGetMoreResult | RecommendationArchiveResult,
): Promise<void> {
  await createIdempotencyRepository(client).complete({
    ...scope,
    recordId,
    response: {
      status: 200,
      body,
      schemaVersion: 1,
    },
  });
}

async function getMore(
  client: BacklinkTransactionClient,
  input: RecommendationUserReleaseScope & IdempotentReleaseCommand,
  generation: ActiveGeneration,
): Promise<RecommendationGetMoreResult> {
  const idempotency = await beginIdempotency(
    client,
    input,
    input,
    "recommendation-user-release.get-more",
  );
  if (idempotency.state === "completed") {
    return completedGetMoreResult(idempotency.response.body);
  }
  if (idempotency.state === "in_progress") {
    throw conflict("Recommendation get-more request is already in progress.");
  }

  const initial = await ensureInitialPublication(client, input, generation);
  if (initial.state === "NOT_READY") {
    const result = Object.freeze({
      state: "INITIAL_BATCH_NOT_READY" as const,
      currentBatchOrdinal: null,
      releasedBatchOrdinal: null,
      replayed: false,
    });
    await completeIdempotency(client, input, idempotency.recordId, result);
    return result;
  }

  const current = await client.query(
    `SELECT cursor.current_batch_id "batchId",
            batch.batch_ordinal "batchOrdinal",
            batch.recommendation_context_version_id "contextId",
            batch.visible_pool_generation "poolGeneration"
       FROM backlink_recommendation_user_cursors cursor
       JOIN backlink_recommendation_release_batches batch
         ON (batch.organization_id,batch.workspace_id,
             batch.website_project_id,batch.id)=
            (cursor.organization_id,cursor.workspace_id,
             cursor.website_project_id,cursor.current_batch_id)
      WHERE cursor.organization_id=$1 AND cursor.workspace_id=$2
        AND cursor.website_project_id=$3
        AND cursor.recommendation_context_version_id=$4
        AND cursor.visible_pool_generation=$5 AND cursor.user_id=$6
      FOR UPDATE OF cursor`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      generation.recommendationContextVersionId,
      generation.visiblePoolGeneration,
      input.actorId,
    ],
  );
  const currentRow = current.rows[0];
  if (currentRow === undefined) {
    throw internal("Recommendation publication cursor is missing.");
  }

  const unlockStatus = await client.query(
    `SELECT *
       FROM backlink_recommendation_batch_unlock_status($1,$2,$3,$4,$5)`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.actorId,
      currentRow.batchId,
    ],
  );
  const unlock = unlockStatus.rows[0];
  if (unlock?.eligible !== true) {
    const result = Object.freeze({
      state: "NOT_UNLOCKED" as const,
      currentBatchOrdinal: Number(currentRow.batchOrdinal),
      releasedBatchOrdinal: null,
      replayed: false,
    });
    await completeIdempotency(client, input, idempotency.recordId, result);
    return result;
  }

  await client.query(
    `INSERT INTO backlink_recommendation_user_unlocks (
       id,organization_id,workspace_id,website_project_id,
       recommendation_context_version_id,visible_pool_generation,
       user_id,batch_id,original_batch_size,required_opportunity_count,
       successful_opportunity_count,unlocked_at,reason,evaluated_at,created_by
     )
     SELECT $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::integer,$7,$8::uuid,
            status.original_batch_size,
            status.required_opportunity_count,
            status.successful_opportunity_count,
            statement_timestamp(),status.reason,statement_timestamp(),$7
       FROM backlink_recommendation_batch_unlock_status(
         $2,$3,$4,$7,$8
       ) status
      WHERE status.eligible
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,user_id,batch_id
     ) DO NOTHING`,
    [
      randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      currentRow.contextId,
      currentRow.poolGeneration,
      input.actorId,
      currentRow.batchId,
    ],
  );

  const next = await client.query(
    `SELECT id,batch_ordinal "batchOrdinal",state
       FROM backlink_recommendation_release_batches
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND generation_contract_id=$4
        AND recommendation_context_version_id=$5
        AND visible_pool_generation=$6 AND batch_ordinal=$7
      FOR SHARE`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      generation.generationContractId,
      currentRow.contextId,
      currentRow.poolGeneration,
      Number(currentRow.batchOrdinal) + 1,
    ],
  );
  const nextRow = next.rows[0];
  if (nextRow === undefined || nextRow.state !== "AVAILABLE") {
    const result = Object.freeze({
      state:
        nextRow === undefined
          ? ("POOL_EXHAUSTED" as const)
          : ("NEXT_BATCH_PREPARING" as const),
      currentBatchOrdinal: Number(currentRow.batchOrdinal),
      releasedBatchOrdinal: null,
      replayed: false,
    });
    await completeIdempotency(client, input, idempotency.recordId, result);
    return result;
  }

  await client.query(
    `INSERT INTO backlink_recommendation_user_publications (
       id,organization_id,workspace_id,website_project_id,
       recommendation_context_version_id,visible_pool_generation,
       user_id,batch_id,published_by_command_id,created_by,updated_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,$7)
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,user_id,batch_id
     ) DO NOTHING`,
    [
      randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      currentRow.contextId,
      currentRow.poolGeneration,
      input.actorId,
      nextRow.id,
      `get-more:${input.idempotencyKey}`,
    ],
  );
  const advanced = await client.query(
    `UPDATE backlink_recommendation_user_cursors
        SET highest_published_batch_ordinal=$7,current_batch_id=$8,
            version=version+1,updated_at=statement_timestamp(),updated_by=$6
      WHERE organization_id=$1 AND workspace_id=$2
        AND website_project_id=$3
        AND recommendation_context_version_id=$4
        AND visible_pool_generation=$5 AND user_id=$6
        AND current_batch_id=$9
      RETURNING version`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      currentRow.contextId,
      currentRow.poolGeneration,
      input.actorId,
      nextRow.batchOrdinal,
      nextRow.id,
      currentRow.batchId,
    ],
  );
  if (advanced.rows[0] === undefined) {
    throw conflict("Recommendation cursor changed during get-more.");
  }
  await client.query(
    `INSERT INTO backlink_recommendation_user_item_actions (
       id,organization_id,workspace_id,website_project_id,
       recommendation_context_version_id,visible_pool_generation,
       user_id,batch_id,action_type,target_batch_id,
       idempotency_key,request_hash,created_by
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'GET_MORE',$9,$10,$11,$7)`,
    [
      randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      currentRow.contextId,
      currentRow.poolGeneration,
      input.actorId,
      currentRow.batchId,
      nextRow.id,
      input.idempotencyKey,
      input.requestHash,
    ],
  );
  const result = Object.freeze({
    state: "RELEASED" as const,
    currentBatchOrdinal: Number(currentRow.batchOrdinal),
    releasedBatchOrdinal: Number(nextRow.batchOrdinal),
    replayed: false,
  });
  await completeIdempotency(client, input, idempotency.recordId, result);
  return result;
}

async function setArchived(
  client: BacklinkTransactionClient,
  input: RecommendationUserReleaseScope &
    IdempotentReleaseCommand &
    Readonly<{ itemId: string; archived: boolean }>,
  generation: ActiveGeneration,
): Promise<RecommendationArchiveResult> {
  const idempotency = await beginIdempotency(
    client,
    input,
    input,
    "recommendation-user-release.archive",
  );
  if (idempotency.state === "completed") {
    return completedArchiveResult(idempotency.response.body);
  }
  if (idempotency.state === "in_progress") {
    throw conflict("Recommendation archive request is already in progress.");
  }

  await ensureInitialPublication(client, input, generation);
  const item = await client.query(
    `SELECT item.batch_id "batchId",
            item.recommendation_context_version_id "contextId",
            item.visible_pool_generation "poolGeneration"
       FROM backlink_recommendation_release_batch_items item
       JOIN backlink_recommendation_release_batches batch
         ON (batch.organization_id,batch.workspace_id,
             batch.website_project_id,batch.id)=
            (item.organization_id,item.workspace_id,
             item.website_project_id,item.batch_id)
       JOIN backlink_recommendation_user_publications publication
         ON (publication.organization_id,publication.workspace_id,
             publication.website_project_id,publication.batch_id)=
            (item.organization_id,item.workspace_id,
             item.website_project_id,item.batch_id)
      WHERE item.organization_id=$1 AND item.workspace_id=$2
        AND item.website_project_id=$3 AND item.id=$4
        AND item.generation_contract_id=$5
        AND publication.user_id=$6
        AND publication.publication_state='ACTIVE'
        AND batch.state='AVAILABLE'
      FOR SHARE OF item,batch,publication`,
    [
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.itemId,
      generation.generationContractId,
      input.actorId,
    ],
  );
  const itemRow = item.rows[0];
  if (itemRow === undefined) {
    throw notFound("Recommendation item is not published for this actor.");
  }
  await client.query(
    `INSERT INTO backlink_recommendation_user_item_actions (
       id,organization_id,workspace_id,website_project_id,
       recommendation_context_version_id,visible_pool_generation,
       user_id,batch_id,batch_item_id,action_type,
       idempotency_key,request_hash,created_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$7
     )`,
    [
      randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      itemRow.contextId,
      itemRow.poolGeneration,
      input.actorId,
      itemRow.batchId,
      input.itemId,
      input.archived ? "ARCHIVED" : "UNARCHIVED",
      input.idempotencyKey,
      input.requestHash,
    ],
  );
  const result = Object.freeze({
    itemId: input.itemId,
    archived: input.archived,
    replayed: false,
  });
  await completeIdempotency(client, input, idempotency.recordId, result);
  return result;
}

export function createRecommendationUserReleaseRepository(
  pool: BacklinkTenantPool,
): RecommendationUserReleaseRepository {
  return Object.freeze({
    getStatus(input) {
      return withBacklinkTenantTransaction(pool, input, async (client) => {
        const ready = await client.query(
          `SELECT 1 FROM backlink_recommendation_pool_project_contracts
            WHERE organization_id=$1 AND workspace_id=$2 AND website_project_id=$3
              AND pool_contract_version='recommendation-pool.v2'
              AND migration_state='V2_READY' AND generation_contract_id IS NULL
            FOR SHARE`,
          [input.organizationId, input.workspaceId, input.websiteProjectId],
        );
        if (ready.rows.length > 0) return null;
        const generation = await activeGeneration(client, input);
        await lockActorGeneration(client, input, generation);
        await ensureInitialPublication(client, input, generation, true);
        return getStatus(client, input, generation);
      });
    },
    publishInitial(input) {
      return withBacklinkTenantTransaction(pool, input, async (client) => {
        const generation = await activeGeneration(client, input);
        await lockActorGeneration(client, input, generation);
        return ensureInitialPublication(client, input, generation);
      });
    },
    getMore(input) {
      return withBacklinkTenantTransaction(pool, input, async (client) => {
        const generation = await activeGeneration(client, input);
        await lockActorGeneration(client, input, generation);
        return getMore(client, input, generation);
      });
    },
    setArchived(input) {
      return withBacklinkTenantTransaction(pool, input, async (client) => {
        const generation = await activeGeneration(client, input);
        await lockActorGeneration(client, input, generation);
        return setArchived(client, input, generation);
      });
    },
  });
}
