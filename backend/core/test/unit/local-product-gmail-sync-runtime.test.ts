import { describe, expect, it } from "vitest";

import {
  buildLocalProductGmailInitialQuery,
  createLocalProductGmailPollingSyncCommands,
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
      text.includes("backlink_mail_sync_cursors")
    )).toBe(true);
  });
});
