import { describe, expect, it } from "vitest";

import {
  buildLocalProductGmailInitialQuery,
  createLocalProductGmailPollingSyncCommands,
  gmailPollingStatusQueryTimeoutMs,
} from "../../src/modules/backlinks/runtime/local-product-gmail-sync-runtime.js";
import type {
  BacklinksLiveCapabilities,
} from "../../src/modules/backlinks/runtime/live-capabilities.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

const disabledCapabilities: BacklinksLiveCapabilities = Object.freeze({
  mode: "LOCAL_PRODUCT",
  stage: null,
  googleOauthEnabled: false,
  gmailSendEnabled: false,
  gmailSyncEnabled: false,
  gmailRolling24HourSendLimit: 5,
  gmailMinimumIntervalSeconds: 300,
  gmailPollingIntervalSeconds: 60,
  dataForSeoEnabled: false,
  aiProviderEnabled: false,
  browserProviderEnabled: false,
  browserWorkerEndpoint: null,
  browserWorkerTimeoutMs: 20_000,
  contactEnrichmentFetchTimeoutMs: 12_000,
  contactEnrichmentMaxPages: 8,
  contactEnrichmentMaxDepth: 2,
  contactEnrichmentMaxAttempts: 3,
  secretStoreEnabled: false,
  googleOauthClientId: null,
  googleOauthClientSecretReference: null,
  gmailRecipientSecretReference: null,
  googleOauthRedirectUri: null,
  secretStoreRoot: null,
});
const enabledCapabilities: BacklinksLiveCapabilities = Object.freeze({
  ...disabledCapabilities,
  gmailSyncEnabled: true,
});

describe("LOCAL_PRODUCT Gmail sync query", () => {
  it("supports multiple accepted product sends without recipient data", () => {
    expect(buildLocalProductGmailInitialQuery([
      {
        subject: "First outreach",
        sentAt: new Date("2026-08-02T12:00:00.000Z"),
      },
      {
        subject: "Second outreach",
        sentAt: new Date("2026-08-03T12:00:00.000Z"),
      },
    ], "LOCAL_PRODUCT")).toBe("in:anywhere after:1785585600");
  });

  it("requires at least one provider-accepted send in product mode", () => {
    expect(() =>
      buildLocalProductGmailInitialQuery([], "LOCAL_PRODUCT")
    ).toThrow(
      "BACKLINK_LOCAL_PRODUCT_GMAIL_SYNC_REQUIRES_ACCEPTED_SEND",
    );
  });

  it("uses the same accepted-send window in legacy acceptance mode", () => {
    expect(buildLocalProductGmailInitialQuery([{
      subject: "GrowthOS Gmail Canary",
      sentAt: new Date("2026-08-03T12:00:00.000Z"),
    }], "LOCAL_PRODUCT_ACCEPTANCE")).toBe("in:anywhere after:1785672000");
    expect(buildLocalProductGmailInitialQuery([
      {
        subject: "One",
        sentAt: new Date("2026-08-03T12:00:00.000Z"),
      },
      {
        subject: "Two",
        sentAt: new Date("2026-08-03T13:00:00.000Z"),
      },
    ], "LOCAL_PRODUCT_ACCEPTANCE")).toBe("in:anywhere after:1785672000");
  });

  it("keeps persisted sync status readable while provider execution is disabled", async () => {
    const queries: string[] = [];
    const pool = {
      connect: async () => ({
        async query(text: string) {
          queries.push(text);
          if (text.includes(
            "FROM backlinks.backlink_gmail_connections AS connection",
          )) {
            return {
              rows: [{
                primaryEmail: "Owner@Example.com",
                canonicalDomain: "example.com",
                locale: "en-US",
                countryCode: "US",
                profileVersionId: "profile-version",
                promotionTargetVersionId: "target-version",
              }],
              rowCount: 1,
            };
          }
          if (text.includes(
            "FROM backlinks.backlink_kill_switch_versions",
          )) {
            return { rows: [{ blocked: false }], rowCount: 1 };
          }
          if (text.includes(
            "FROM backlinks.backlink_send_attempts AS attempt",
          )) {
            return { rows: [{ count: 0 }], rowCount: 1 };
          }
          if (text.includes(
            "FROM backlinks.backlink_mail_sync_cursors",
          )) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      }),
    };
    const commands = createLocalProductGmailPollingSyncCommands({
      pool,
      workflowClient: {} as never,
      taskQueue: "growthos.backlinks.v1",
      capabilities: disabledCapabilities,
    });
    const context = {
      actor: createActorContext({
        userId: "user-test",
        sessionId: "session-test",
        roles: ["member"],
      }),
      tenant: createTenantContext({
        organizationId: "organization-test",
        workspaceId: "workspace-test",
      }),
      project: createProjectContext({
        websiteProjectId: "project-test",
        canonicalDomain: "example.com",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-version",
        promotionTargetVersionId: "target-version",
      }),
    };

    await expect(commands.status({
      context,
      connectionId: "connection-test",
    })).resolves.toMatchObject({
      state: "BLOCKED",
      pollingIntervalSeconds: 60,
      killSwitchOpen: true,
      acceptedSendCount: 0,
      cursor: null,
    });
    await expect(commands.start({
      context,
      connectionId: "connection-test",
    })).rejects.toMatchObject({
      code: "BACKLINK_INTERNAL_ERROR",
      message: "Gmail sync is disabled for this runtime.",
    });
    expect(queries.some((text) =>
      text.includes("backlink_gmail_connection_sync_cursors")
    )).toBe(true);
  });

  it("serializes status queries on one transaction client", async () => {
    let queryActive = false;
    const statusQueries: string[] = [];
    const pool = {
      connect: async () => ({
        async query(text: string) {
          if (
            text === "BEGIN"
            || text === "COMMIT"
            || text === "ROLLBACK"
            || text.includes("set_config")
          ) {
            return { rows: [], rowCount: 0 };
          }
          if (queryActive) {
            throw new Error("CONCURRENT_QUERY_ON_TRANSACTION_CLIENT");
          }
          queryActive = true;
          statusQueries.push(text);
          await new Promise((resolve) => setTimeout(resolve, 1));
          queryActive = false;
          if (text.includes("backlink_gmail_connections AS connection")) {
            return {
              rows: [{
                connectionStatus: "CONNECTED",
                mailSyncCapability: true,
                lastErrorCategory: null,
              }],
              rowCount: 1,
            };
          }
          if (text.includes("backlink_kill_switch_versions")) {
            return { rows: [{ blocked: false }], rowCount: 1 };
          }
          if (text.includes("backlink_send_attempts AS attempt")) {
            return { rows: [{ count: 0 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      }),
    };
    const commands = createLocalProductGmailPollingSyncCommands({
      pool,
      workflowClient: {} as never,
      taskQueue: "growthos.backlinks.v1",
      capabilities: enabledCapabilities,
    });
    const context = {
      actor: createActorContext({
        userId: "user-test",
        sessionId: "session-test",
        roles: ["member"],
      }),
      tenant: createTenantContext({
        organizationId: "organization-test",
        workspaceId: "workspace-test",
      }),
      project: createProjectContext({
        websiteProjectId: "project-test",
        canonicalDomain: "example.com",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-version",
        promotionTargetVersionId: "target-version",
      }),
    };

    await expect(commands.status({
      context,
      connectionId: "connection-test",
    })).resolves.toMatchObject({
      state: "WAITING_FOR_ACCEPTED_SEND",
      acceptedSendCount: 0,
      cursor: null,
    });
    expect(statusQueries).toHaveLength(4);
  });

  it("bounds an unavailable workflow status query below the Gateway timeout", async () => {
    const pool = {
      connect: async () => ({
        async query(text: string) {
          if (text.includes("backlink_gmail_connections AS connection")) {
            return {
              rows: [{
                connectionStatus: "CONNECTED",
                mailSyncCapability: true,
                lastErrorCategory: null,
              }],
              rowCount: 1,
            };
          }
          if (text.includes("backlink_kill_switch_versions")) {
            return { rows: [{ blocked: false }], rowCount: 1 };
          }
          if (text.includes("backlink_send_attempts AS attempt")) {
            return { rows: [{ count: 1 }], rowCount: 1 };
          }
          if (text.includes("backlink_gmail_connection_sync_cursors")) {
            return {
              rows: [{
                historyId: "166995",
                initialSyncCompletedAt: "2026-08-04T00:00:00.000Z",
                lastSyncedAt: "2026-08-04T00:01:00.000Z",
                version: 3,
              }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      }),
    };
    const commands = createLocalProductGmailPollingSyncCommands({
      pool,
      workflowClient: {
        getHandle() {
          return {
            query: () => new Promise(() => {}),
          };
        },
      } as never,
      taskQueue: "growthos.backlinks.v1",
      capabilities: enabledCapabilities,
    });
    const context = {
      actor: createActorContext({
        userId: "user-test",
        sessionId: "session-test",
        roles: ["member"],
      }),
      tenant: createTenantContext({
        organizationId: "organization-test",
        workspaceId: "workspace-test",
      }),
      project: createProjectContext({
        websiteProjectId: "project-test",
        canonicalDomain: "example.com",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-version",
        promotionTargetVersionId: "target-version",
      }),
    };
    const startedAt = Date.now();

    await expect(commands.status({
      context,
      connectionId: "connection-test",
    })).resolves.toMatchObject({
      state: "POLLING",
      lastSuccessfulSyncAt: "2026-08-04T00:01:00.000Z",
      lastError: "GMAIL_POLLING_STATUS_QUERY_TIMEOUT",
      lastErrorCategory: "UNKNOWN",
    });
    expect(Date.now() - startedAt).toBeLessThan(
      gmailPollingStatusQueryTimeoutMs + 500,
    );
  });

  it("uses one durable workflow for a shared Gmail connection across projects", async () => {
    const startedWorkflowIds: string[] = [];
    const signaledWorkflowIds: string[] = [];
    const pool = {
      connect: async () => ({
        async query(text: string) {
          if (text.includes(
            "FROM backlinks.backlink_gmail_connections AS connection",
          )) {
            return {
              rows: [{
                primaryEmail: "owner@example.test",
                canonicalDomain: "example.test",
                locale: "en-US",
                countryCode: "US",
                profileVersionId: "profile-version",
                promotionTargetVersionId: "target-version",
              }],
              rowCount: 1,
            };
          }
          if (text.includes("backlink_kill_switch_versions")) {
            return { rows: [{ blocked: false }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {},
      }),
    };
    const alreadyStarted = Object.assign(
      new Error("already started"),
      { name: "WorkflowExecutionAlreadyStartedError" },
    );
    const workflowClient = {
      async start(
        _workflowType: string,
        options: Readonly<{ workflowId: string }>,
      ) {
        startedWorkflowIds.push(options.workflowId);
        if (startedWorkflowIds.length > 1) throw alreadyStarted;
      },
      getHandle(workflowId: string) {
        return {
          async signal() {
            signaledWorkflowIds.push(workflowId);
          },
        };
      },
    };
    const commands = createLocalProductGmailPollingSyncCommands({
      pool,
      workflowClient: workflowClient as never,
      taskQueue: "growthos.backlinks.v1",
      capabilities: enabledCapabilities,
    });
    const contextFor = (websiteProjectId: string) => ({
      actor: createActorContext({
        userId: "user-test",
        sessionId: "session-test",
        roles: ["member"],
      }),
      tenant: createTenantContext({
        organizationId: "organization-test",
        workspaceId: "workspace-test",
      }),
      project: createProjectContext({
        websiteProjectId,
        canonicalDomain: "example.test",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-version",
        promotionTargetVersionId: "target-version",
      }),
    });

    const first = await commands.start({
      context: contextFor("project-one"),
      connectionId: "connection-test",
    });
    const second = await commands.start({
      context: contextFor("project-two"),
      connectionId: "connection-test",
    });

    expect(first.workflowId).toBe(second.workflowId);
    expect(first.workflowId).toContain(":gmail-connection:");
    expect(signaledWorkflowIds).toEqual([first.workflowId]);
  });
});
