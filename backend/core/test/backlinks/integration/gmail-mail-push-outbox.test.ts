import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
  createGmailPushWebhook,
} from "../../../src/modules/backlinks/application/workflows/mail-push-webhook.js";
import {
  createOutboxRepository,
} from "../../../src/modules/backlinks/db/repositories/outbox.repository.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly unknown[]): Promise<{
    rows: Record<string, unknown>[];
  }>;
};
const require = createRequire(import.meta.url);
const { Client } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const scope = {
  organizationId: "10000000-0000-4000-8000-000000000141",
  workspaceId: "20000000-0000-4000-8000-000000000141",
  websiteProjectId: "30000000-0000-4000-8000-000000000141",
  gmailConnectionId: "40000000-0000-4000-8000-000000000141",
} as const;
const notificationBody = {
  message: {
    data: Buffer.from(JSON.stringify({
      emailAddress: "owner@example.test",
      historyId: "99141",
    })).toString("base64"),
    messageId: "1410000000001",
  },
  subscription:
    "projects/growthos/subscriptions/backlinks-gmail-push",
};

describe("BL-AI-141 Gmail Push Outbox deduplication", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new Client({ connectionString: harness.connectionString });
    await client.connect();
  }, 120_000);
  beforeEach(() => client.query(
    "TRUNCATE backlink_outbox_events RESTART IDENTITY CASCADE",
  ));
  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("stores one durable sync request for repeated provider delivery", async () => {
    let sequence = 141;
    const webhook = createGmailPushWebhook({
      config: { enabled: true },
      identityVerifier: { verify: async () => undefined },
      targetResolver: { resolve: async () => scope },
      outbox: createOutboxRepository(client),
      newId: () =>
        `50000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`,
    });

    await expect(webhook.handle({
      authorizationHeader: "Bearer header.payload.signature",
      body: notificationBody,
    })).resolves.toEqual({ accepted: true, duplicate: false });
    await expect(webhook.handle({
      authorizationHeader: "Bearer header.payload.signature",
      body: notificationBody,
    })).resolves.toEqual({ accepted: true, duplicate: true });

    const result = await client.query(
      `SELECT event_type, payload, count(*)::int AS event_count
         FROM backlink_outbox_events
        GROUP BY event_type, payload`,
    );
    expect(result.rows).toEqual([{
      event_type: GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
      payload: {
        contractVersion: GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
        ...scope,
        trigger: "GMAIL_PUSH",
      },
      event_count: 1,
    }]);
    expect(JSON.stringify(result.rows[0]?.payload)).not.toMatch(
      /owner@example|99141|1410000000001/iu,
    );
  });
});
