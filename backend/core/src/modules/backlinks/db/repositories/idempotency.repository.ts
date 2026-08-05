import { BacklinkError, backlinkErrorCodes } from "../../domain/errors/backlink-error.js";
export type IdempotencyQueryClient = Readonly<{
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>;
}>;
export type IdempotencyResponse = Readonly<{
  status: number;
  body: unknown;
  schemaVersion: number;
}>;
type IdempotencyScope = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  actorId: string;
}>;
export type BeginIdempotencyInput = IdempotencyScope & Readonly<{
  recordId: string;
  idempotencyKey: string;
  commandType: string;
  requestHash: string;
  expiresAt: Date;
}>;
export type CompleteIdempotencyInput = IdempotencyScope & Readonly<{
  recordId: string;
  response: IdempotencyResponse;
}>;
export type BeginIdempotencyResult =
  | Readonly<{ state: "begun" | "in_progress"; recordId: string }>
  | Readonly<{ state: "completed"; recordId: string; response: IdempotencyResponse }>;
type StoredRecord = {
  id: string;
  organization_id: string;
  website_project_id: string;
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
  response_schema_version: number | null;
  completed_at: Date | null;
};
const conflict = () =>
  new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message: "Idempotency key is already bound to a different request.",
  });
function completed(record: StoredRecord): BeginIdempotencyResult {
  if (record.response_status === null || record.response_schema_version === null) {
    throw new BacklinkError({
      code: backlinkErrorCodes.internal,
      message: "Stored idempotency response is incomplete.",
    });
  }
  return {
    state: "completed",
    recordId: record.id,
    response: { status: record.response_status, body: record.response_body,
      schemaVersion: record.response_schema_version },
  };
}
export function createIdempotencyRepository(client: IdempotencyQueryClient) {
  return {
    async begin(input: BeginIdempotencyInput): Promise<BeginIdempotencyResult> {
      const inserted = await client.query(
        `INSERT INTO backlink_idempotency_records
          (id, organization_id, workspace_id, website_project_id,
           idempotency_key, command_type, request_hash, expires_at,
           created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
         ON CONFLICT (workspace_id, idempotency_key, command_type) DO NOTHING
         RETURNING id`,
        [
          input.recordId, input.organizationId, input.workspaceId,
          input.websiteProjectId, input.idempotencyKey, input.commandType,
          input.requestHash, input.expiresAt,
          input.actorId,
        ],
      );
      if (inserted.rows[0] !== undefined) {
        return { state: "begun", recordId: input.recordId };
      }

      const selected = await client.query(
        `SELECT id, organization_id, website_project_id, request_hash,
                response_status, response_body, response_schema_version, completed_at
           FROM backlink_idempotency_records
          WHERE workspace_id = $1 AND idempotency_key = $2
            AND command_type = $3`,
        [input.workspaceId, input.idempotencyKey, input.commandType],
      );
      const record = selected.rows[0] as StoredRecord | undefined;
      if (record === undefined) {
        throw new BacklinkError({ code: backlinkErrorCodes.internal,
          message: "Idempotency record could not be loaded.", retryable: true });
      }
      if (
        record.organization_id !== input.organizationId ||
        record.website_project_id !== input.websiteProjectId ||
        record.request_hash !== input.requestHash
      ) {
        throw conflict();
      }
      return record.completed_at === null
        ? { state: "in_progress", recordId: record.id }
        : completed(record);
    },

    async complete(input: CompleteIdempotencyInput): Promise<BeginIdempotencyResult> {
      const result = await client.query(
        `UPDATE backlink_idempotency_records
            SET response_status = $5, response_body = $6,
                response_schema_version = $7, completed_at = now(),
                updated_at = now(), updated_by = $8
          WHERE id = $1 AND organization_id = $2 AND workspace_id = $3
            AND website_project_id = $4 AND completed_at IS NULL
        RETURNING id, response_status, response_body,
                  response_schema_version, completed_at`,
        [
          input.recordId, input.organizationId, input.workspaceId,
          input.websiteProjectId, input.response.status, input.response.body,
          input.response.schemaVersion,
          input.actorId,
        ],
      );
      const record = result.rows[0] as StoredRecord | undefined;
      if (record === undefined) throw conflict();
      return completed(record);
    },
  };
}
