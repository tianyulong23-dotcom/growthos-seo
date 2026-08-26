import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createOutboxRepository,
  type AppendOutboxInput,
} from "../../../src/modules/backlinks/db/repositories/outbox.repository.js";
type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{
    rows: Record<string, unknown>[];
  }>;
};
const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
};
const databaseUrl = process.env.BACKLINKS_TEST_DATABASE_URL;
const migrationPath = new URL("../../../src/modules/backlinks/db/migrations/0001_backlink_foundation.sql", import.meta.url);
const uuid = (value: number) =>
  `018f0000-0000-7000-8000-${value.toString().padStart(12, "0")}`;

describe.skipIf(databaseUrl === undefined)("BL-AI-030 Outbox Repository", () => {
  const schema = `bl_ai_030_${process.pid}_${Date.now()}`;
  let clientA: RuntimeClient;
  let clientB: RuntimeClient;
  let repositoryA: ReturnType<typeof createOutboxRepository>;
  let repositoryB: ReturnType<typeof createOutboxRepository>;

  beforeAll(async () => {
    clientA = new Client({ connectionString: databaseUrl });
    clientB = new Client({ connectionString: databaseUrl });
    await Promise.all([clientA.connect(), clientB.connect()]);
    await clientA.query(`CREATE SCHEMA "${schema}"`);
    await clientA.query(`SET search_path TO "${schema}"`);
    await clientA.query(await readFile(migrationPath, "utf8"));
    await clientB.query(`SET search_path TO "${schema}"`);
    repositoryA = createOutboxRepository(clientA);
    repositoryB = createOutboxRepository(clientB);
  });
  beforeEach(() => clientA.query("TRUNCATE backlink_outbox_events"));
  afterAll(async () => {
    await clientA.query("SET search_path TO public");
    await clientA.query(`DROP SCHEMA "${schema}" CASCADE`);
    await Promise.all([clientA.end(), clientB.end()]);
  });

  const event = (sequence: number): AppendOutboxInput => ({
    eventId: uuid(100 + sequence),
    organizationId: uuid(1),
    workspaceId: uuid(2),
    websiteProjectId: uuid(3),
    eventType: "prospect.created",
    aggregateId: uuid(200 + sequence),
    aggregateVersion: 1,
    idempotencyKey: `outbox-${sequence}`,
    payload: { prospectId: sequence },
    payloadSchemaVersion: 1,
    actorId: "user-030",
  });

  it("appends idempotently and never returns one event to two claimers", async () => {
    const firstEvent = event(1);
    const events = [firstEvent, event(2), event(3), event(4)];
    for (const input of events) await repositoryA.append(input);
    await expect(repositoryA.append(firstEvent)).resolves.toEqual({
      state: "existing",
      eventId: firstEvent.eventId,
    });

    const claimed = (
      await Promise.all([
        repositoryA.claim({ workerId: "worker-a", limit: 2 }),
        repositoryB.claim({ workerId: "worker-b", limit: 2 }),
      ])
    ).flat();
    expect(claimed).toHaveLength(4);
    expect(new Set(claimed.map((item) => item.eventId)).size).toBe(4);
    expect(claimed.every((item) => item.status === "processing")).toBe(true);
  });

  it("releases a failed claim for retry and then marks it published", async () => {
    const input = event(10);
    await repositoryA.append(input);
    const [first] = await repositoryA.claim({ workerId: "worker-a", limit: 1 });
    expect(first).toMatchObject({ eventId: input.eventId, attemptCount: 1 });

    await expect(repositoryA.mark({
      eventId: input.eventId,
      workerId: "worker-a",
      outcome: "failed",
      retryAt: new Date(Date.now() - 1_000),
    })).resolves.toBe(true);
    const [retry] = await repositoryB.claim({ workerId: "worker-b", limit: 1 });
    expect(retry).toMatchObject({ eventId: input.eventId, attemptCount: 2 });
    await expect(repositoryB.mark({
      eventId: input.eventId,
      workerId: "worker-b",
      outcome: "published",
    })).resolves.toBe(true);

    const stored = await clientA.query(
      "SELECT status, attempt_count, published_at IS NOT NULL AS published FROM backlink_outbox_events",
    );
    expect(stored.rows[0]).toEqual({
      status: "published",
      attempt_count: 2,
      published: true,
    });
  });

  it("claims only the explicitly authorized recovery event", async () => {
    const authorized = event(20);
    const unrelated = event(21);
    await repositoryA.append(authorized);
    await repositoryA.append(unrelated);

    const claimed = await repositoryA.claim({
      workerId: "recovery-worker",
      limit: 1,
      eventId: authorized.eventId,
    });

    expect(claimed.map((item) => item.eventId)).toEqual([
      authorized.eventId,
    ]);
    expect((await clientA.query(
      "SELECT id,status FROM backlink_outbox_events ORDER BY id",
    )).rows).toEqual([
      { id: authorized.eventId, status: "processing" },
      { id: unrelated.eventId, status: "pending" },
    ]);
  });
});
