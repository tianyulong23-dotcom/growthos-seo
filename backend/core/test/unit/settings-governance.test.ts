import { describe, expect, it } from "vitest";

import {
  createProjectSettingsService,
  type ProjectSettingsVersion,
} from "../../src/modules/backlinks/domain/settings/settings-version.js";
import {
  evaluateKillSwitch,
} from "../../src/modules/backlinks/domain/settings/kill-switch.js";
import {
  selectExpiredRetentionCandidates,
} from "../../src/modules/backlinks/domain/retention/retention-policy.js";

const scope = {
  organizationId: "organization-171",
  workspaceId: "workspace-171",
  websiteProjectId: "project-171",
};

describe("BL-AI-171 Settings Version", () => {
  it("appends versions and keeps a running Job bound to its start version", async () => {
    const versions: ProjectSettingsVersion[] = [{
      id: "settings-v1",
      ...scope,
      version: 1,
      values: {
        reportingTimezone: "Asia/Shanghai",
        reportLookbackDays: 30,
        exportExpiryHours: 24,
      },
      createdAt: new Date("2026-07-29T03:00:00.000Z"),
      createdBy: "user-171",
    }];
    const service = createProjectSettingsService({
      repository: {
        getCurrent: async () => versions.at(-1) ?? null,
        append: async (input) => {
          const next: ProjectSettingsVersion = {
            id: input.id,
            ...input.scope,
            version: input.expectedVersion + 1,
            values: input.values,
            createdAt: input.createdAt,
            createdBy: input.createdBy,
          };
          versions.push(next);
          return next;
        },
      },
      newId: () => "settings-v2",
      now: () => new Date("2026-07-29T03:10:00.000Z"),
    });

    const jobBinding = await service.bindAtJobStart(scope);
    const updated = await service.update({
      scope,
      expectedVersion: 1,
      values: {
        reportingTimezone: "UTC",
        reportLookbackDays: 14,
        exportExpiryHours: 12,
      },
      actorId: "user-171",
    });

    expect(updated).toMatchObject({ id: "settings-v2", version: 2 });
    expect(jobBinding).toMatchObject({
      settingsVersionId: "settings-v1",
      settingsVersion: 1,
      values: { reportingTimezone: "Asia/Shanghai" },
    });
  });
});

describe("BL-AI-172 layered Kill Switch", () => {
  it("fails closed by default and never lets a child enable override a parent block", () => {
    expect(evaluateKillSwitch({
      capability: "DATA_PROVIDER",
      provider: "DataForSEO",
      authorityAvailable: true,
      decisions: [],
    })).toMatchObject({
      effectiveBlocked: true,
      sourceLayer: "default",
    });

    expect(evaluateKillSwitch({
      capability: "DATA_PROVIDER",
      provider: "DataForSEO",
      authorityAvailable: true,
      decisions: [{
        layer: "global",
        scopeId: "global",
        capability: "DATA_PROVIDER",
        provider: null,
        blocked: true,
        version: 4,
      }, {
        layer: "provider",
        scopeId: "DataForSEO",
        capability: "DATA_PROVIDER",
        provider: "DataForSEO",
        blocked: false,
        version: 7,
      }],
    })).toMatchObject({
      effectiveBlocked: true,
      sourceLayer: "global",
      sourceVersion: 4,
    });

    expect(evaluateKillSwitch({
      capability: "DATA_PROVIDER",
      provider: "DataForSEO",
      authorityAvailable: false,
      decisions: [],
    })).toMatchObject({
      effectiveBlocked: true,
      sourceLayer: "authority_unavailable",
    });
  });
});

describe("BL-AI-173 Retention selector", () => {
  it("selects only expired records and preserves legal hold, audit, and suppression exceptions", () => {
    const result = selectExpiredRetentionCandidates({
      now: new Date("2026-07-29T04:00:00.000Z"),
      policy: {
        id: "retention-v1",
        version: 1,
        rules: {
          raw_html: { retainForMilliseconds: 30 * 24 * 60 * 60 * 1000 },
          contact_evidence: {
            retainForMilliseconds: 365 * 24 * 60 * 60 * 1000,
          },
          provider_raw_response: {
            retainForMilliseconds: 30 * 24 * 60 * 60 * 1000,
          },
          seo_snapshot: {
            retainForMilliseconds: 730 * 24 * 60 * 60 * 1000,
          },
          provider_usage: {
            retainForMilliseconds: 365 * 24 * 60 * 60 * 1000,
          },
          audit: { retainForMilliseconds: 730 * 24 * 60 * 60 * 1000 },
          lifecycle: {
            retainForMilliseconds: 730 * 24 * 60 * 60 * 1000,
          },
          gmail_token: { retainForMilliseconds: 24 * 60 * 60 * 1000 },
          project_data: {
            retainForMilliseconds: 60 * 24 * 60 * 60 * 1000,
          },
          suppression: {
            retainForMilliseconds: 365 * 24 * 60 * 60 * 1000,
          },
        },
      },
      records: [{
        id: "expired-html",
        category: "raw_html",
        retainedFrom: new Date("2026-06-01T00:00:00.000Z"),
        legalHold: false,
        suppressionActive: false,
      }, {
        id: "legal-hold",
        category: "raw_html",
        retainedFrom: new Date("2026-06-01T00:00:00.000Z"),
        legalHold: true,
        suppressionActive: false,
      }, {
        id: "audit-fact",
        category: "audit",
        retainedFrom: new Date("2020-01-01T00:00:00.000Z"),
        legalHold: false,
        suppressionActive: false,
      }, {
        id: "active-suppression",
        category: "suppression",
        retainedFrom: new Date("2020-01-01T00:00:00.000Z"),
        legalHold: false,
        suppressionActive: true,
      }],
    });

    expect(result.selected.map(({ id }) => id)).toEqual(["expired-html"]);
    expect(result.excluded).toMatchObject([
      { id: "active-suppression", reason: "active_suppression" },
      { id: "audit-fact", reason: "audit_record" },
      { id: "legal-hold", reason: "legal_hold" },
    ]);
    expect(result).not.toHaveProperty("delete");
  });
});
