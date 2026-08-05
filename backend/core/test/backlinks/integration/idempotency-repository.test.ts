import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { toBacklinkProblemDetails } from "../../../src/modules/backlinks/api/problem-details.js";
import { backlinkErrorCodes } from "../../../src/modules/backlinks/domain/errors/backlink-error.js";
import { createIdempotencyRepository } from "../../../src/modules/backlinks/db/repositories/idempotency.repository.js";
type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};
const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
};
const databaseUrl = process.env.BACKLINKS_TEST_DATABASE_URL;
const migrationPath = new URL("../../../src/modules/backlinks/db/migrations/0001_backlink_foundation.sql", import.meta.url);

describe.skipIf(databaseUrl === undefined)(
  "BL-AI-028 Idempotency Repository",
  () => {
    const schema = `bl_ai_028_${process.pid}_${Date.now()}`;
    let client: RuntimeClient;
    let repository: ReturnType<typeof createIdempotencyRepository>;

    beforeAll(async () => {
      client = new Client({ connectionString: databaseUrl });
      await client.connect();
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(await readFile(migrationPath, "utf8"));
      repository = createIdempotencyRepository({
        query: (text, values) => client.query(text, values),
      });
    });

    beforeEach(() => client.query("TRUNCATE backlink_idempotency_records"));

    afterAll(async () => {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      await client.end();
    });

    const initial = {
      recordId: "018f0000-0000-7000-8000-000000000001",
      organizationId: "018f0000-0000-7000-8000-000000000002",
      workspaceId: "018f0000-0000-7000-8000-000000000003",
      websiteProjectId: "018f0000-0000-7000-8000-000000000004",
      idempotencyKey: "contact-create-001",
      commandType: "CREATE_CONTACT",
      requestHash: "sha256:request-a",
      actorId: "user-001",
      expiresAt: new Date("2026-07-23T00:00:00.000Z"),
    } as const;

    it("reuses the completed response for the same key, command, and payload", async () => {
      const response = { status: 202, body: { jobId: "job-001" }, schemaVersion: 1 };
      await expect(repository.begin(initial)).resolves.toEqual({
        state: "begun",
        recordId: initial.recordId,
      });
      await expect(
        repository.begin({
          ...initial,
          recordId: "018f0000-0000-7000-8000-000000000005",
        }),
      ).resolves.toEqual({ state: "in_progress", recordId: initial.recordId });

      await repository.complete({ ...initial, response });

      await expect(
        repository.begin({
          ...initial,
          recordId: "018f0000-0000-7000-8000-000000000006",
        }),
      ).resolves.toEqual({
        state: "completed",
        recordId: initial.recordId,
        response,
      });
    });

    it("maps reuse with a different payload to HTTP 409", async () => {
      await repository.begin(initial);
      const error = await repository
        .begin({
          ...initial,
          recordId: "018f0000-0000-7000-8000-000000000007",
          requestHash: "sha256:request-b",
        })
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: backlinkErrorCodes.conflict });
      expect(toBacklinkProblemDetails(error, "request-028").status).toBe(409);
    });
  },
);
