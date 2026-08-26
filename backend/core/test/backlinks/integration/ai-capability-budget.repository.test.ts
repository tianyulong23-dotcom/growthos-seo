import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  AiCapabilityBudgetError,
  createAiCapabilityBudgetRepository,
  type AiCapability,
  type AiCapabilityPolicy,
} from "../../../src/modules/backlinks/db/repositories/ai-capability-budget.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionQueryResult,
} from "../../../src/modules/backlinks/db/tenant-transaction.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";

type RuntimeClient = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<BacklinkTransactionQueryResult>;
};
type RuntimePool = BacklinkTenantPool & {
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<BacklinkTransactionQueryResult>;
};

const require = createRequire(import.meta.url);
const { Client: PgClient, Pool: PgPool } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
  readonly Pool: new (config: unknown) => RuntimePool;
};
const rolesUrl = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const migrationUrl = new URL(
  "../../../src/modules/backlinks/db/migrations/0064_backlink_ai_capability_budgets.sql",
  import.meta.url,
);
const scope = {
  organizationId: "018f0064-0000-7000-8000-000000000001",
  workspaceId: "018f0064-0000-7000-8000-000000000002",
  websiteProjectId: "018f0064-0000-7000-8000-000000000003",
};
const basePolicy: AiCapabilityPolicy = Object.freeze({
  maxCalls: 10,
  absoluteBudgetUsd: 1,
  windowSeconds: 60,
  maxConcurrency: 1,
  maxWorkItemsPerGeneration: 1,
  maxProviderCallsPerGeneration: 1,
  reservationUsd: 0.1,
  providerRef: "test-provider",
  modelId: "test-model",
});

const budgetInput = (
  capability: AiCapability,
  operationKey: string,
  policy: AiCapabilityPolicy = basePolicy,
) => ({
  ...scope,
  capability,
  operationKey,
  actorId: "phase-3-integration",
  workItemCount: 1,
  policy,
});

describe("Phase 3 AI capability budget repository", () => {
  let harness: BacklinksPostgresHarness;
  let admin: RuntimeClient;
  let pool: RuntimePool;
  let currentTime = new Date("2026-08-15T08:00:00.000Z");

  const transact = <T>(
    work: (
      repository: ReturnType<typeof createAiCapabilityBudgetRepository>,
    ) => Promise<T>,
  ) => withBacklinkTenantTransaction(
    pool,
    scope,
    (client) => work(createAiCapabilityBudgetRepository(
      client,
      () => currentTime,
    )),
  );

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    admin = new PgClient({ connectionString: harness.connectionString });
    await admin.connect();
    await admin.query(await readFile(rolesUrl, "utf8"));
    await admin.query(await readFile(migrationUrl, "utf8"));
    pool = new PgPool({ connectionString: harness.connectionString });
  }, 120_000);

  beforeEach(async () => {
    currentTime = new Date("2026-08-15T08:00:00.000Z");
    await admin.query(
      `TRUNCATE
         backlinks.backlink_ai_capability_usage_ledger,
         backlinks.backlink_ai_capability_windows`,
    );
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
    await harness?.stop();
  });

  it("serializes concurrent reservations by capability", async () => {
    const reservations = await Promise.allSettled([
      transact((repository) => repository.reserve(
        budgetInput("AI_DISCOVERY", "concurrent-a"),
      )),
      transact((repository) => repository.reserve(
        budgetInput("AI_DISCOVERY", "concurrent-b"),
      )),
    ]);

    expect(reservations.filter(({ status }) => status === "fulfilled"))
      .toHaveLength(1);
    const rejected = reservations.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        name: "AiCapabilityBudgetError",
        reason: "CONCURRENCY_EXHAUSTED",
      }),
    });
  });

  it("keeps discovery exhaustion independent from outreach draft", async () => {
    const discoveryPolicy = {
      ...basePolicy,
      maxCalls: 1,
    };
    await transact(async (repository) => {
      const input = budgetInput(
        "AI_DISCOVERY",
        "discovery-exhausted",
        discoveryPolicy,
      );
      await repository.reserve(input);
      await repository.markProviderCallStarted(input);
      await repository.settle({ ...input, actualCostUsd: 0.05 });
    });

    await expect(transact((repository) => repository.reserve(
      budgetInput("AI_DISCOVERY", "discovery-blocked", discoveryPolicy),
    ))).rejects.toMatchObject({
      name: "AiCapabilityBudgetError",
      reason: "BUDGET_EXCEEDED",
    });

    await expect(transact((repository) => repository.reserve(
      budgetInput("AI_OUTREACH_DRAFT", "draft-ready"),
    ))).resolves.toMatchObject({
      status: "RESERVED",
    });
  });

  it("keeps outreach draft exhaustion independent from discovery", async () => {
    const draftPolicy = {
      ...basePolicy,
      maxCalls: 2,
      maxProviderCallsPerGeneration: 2,
      reservationUsd: 0.2,
    };
    await transact(async (repository) => {
      const input = budgetInput(
        "AI_OUTREACH_DRAFT",
        "draft-exhausted",
        draftPolicy,
      );
      await repository.reserve(input);
      await repository.markProviderCallStarted(input);
      await repository.markProviderCallStarted(input);
      await repository.settle({ ...input, actualCostUsd: 0.1 });
    });

    await expect(transact((repository) => repository.reserve(
      budgetInput("AI_OUTREACH_DRAFT", "draft-blocked", draftPolicy),
    ))).rejects.toMatchObject({
      name: "AiCapabilityBudgetError",
      reason: "BUDGET_EXCEEDED",
    });

    await expect(transact((repository) => repository.reserve(
      budgetInput("AI_DISCOVERY", "discovery-ready"),
    ))).resolves.toMatchObject({
      status: "RESERVED",
    });
  });

  it("renews an expired capability window immediately", async () => {
    const firstWindow = await transact(async (repository) => {
      const input = budgetInput("AI_DISCOVERY", "expired-window");
      const reservation = await repository.reserve(input);
      await repository.markProviderCallStarted(input);
      await repository.settle({ ...input, actualCostUsd: 0.05 });
      return reservation.windowId;
    });

    currentTime = new Date("2026-08-15T08:01:01.000Z");
    const readiness = await transact((repository) => repository.readiness(
      budgetInput("AI_DISCOVERY", "new-window"),
    ));

    expect(readiness).toMatchObject({
      state: "READY",
      remainingCalls: 10,
      availableConcurrency: 1,
    });
    expect(readiness.windowId).not.toBe(firstWindow);
  });

  it("enforces the draft provider-call ceiling per generation", async () => {
    const draftPolicy = {
      ...basePolicy,
      maxProviderCallsPerGeneration: 2,
      reservationUsd: 0.2,
    };
    const input = budgetInput(
      "AI_OUTREACH_DRAFT",
      "draft-two-attempts",
      draftPolicy,
    );

    await transact(async (repository) => {
      await repository.reserve(input);
      await repository.markProviderCallStarted(input);
      await repository.markProviderCallStarted(input);
    });

    const error = await transact((repository) =>
      repository.markProviderCallStarted(input),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiCapabilityBudgetError);
    expect(error).toMatchObject({
      reason: "PROVIDER_CALL_LIMIT_EXCEEDED",
    });
  });
});
