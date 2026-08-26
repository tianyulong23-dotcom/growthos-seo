import { describe, expect, it } from "vitest";

import { createProjectInputPersistenceRepository } from "../../src/modules/backlinks/db/repositories/project-input-persistence.repository.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionQueryResult,
} from "../../src/modules/backlinks/db/tenant-transaction.js";

const ids = {
  outreach: "018f0000-0000-7000-8000-000000000701",
  evidence: "018f0000-0000-7000-8000-000000000702",
  evidence2: "018f0000-0000-7000-8000-000000000704",
  pins: "018f0000-0000-7000-8000-000000000703",
};

const createFakePool = () => {
  const queries: string[] = [];
  let released = false;
  const pool: BacklinkTenantPool = {
    async connect() {
      return {
        async query(text): Promise<BacklinkTransactionQueryResult> {
          const sql = text.replace(/\s+/g, " ").trim();
          queries.push(sql);
          const id = sql.includes("backlink_outreach_profile_versions")
            ? ids.outreach
            : sql.includes("backlink_shared_seo_evidence_references")
              ? ids.evidence
              : sql.includes("backlink_generation_input_pins")
                ? ids.pins
                : undefined;
          return {
            rows: id ? [{ id }] : [],
            rowCount: id ? 1 : 0,
          };
        },
        release() {
          released = true;
        },
      };
    },
  };
  return { pool, queries, released: () => released };
};

const bindingInput = {
  organizationId: "018f0000-0000-7000-8000-000000000001",
  workspaceId: "018f0000-0000-7000-8000-000000000002",
  websiteProjectId: "018f0000-0000-7000-8000-000000000003",
  inputPinId: ids.pins,
  qualificationContractVersion: "recommendation-qualification.v1",
  market: "US",
} as const;

const pinRow = {
  inputPinId: ids.pins,
  projectContextVersion: 4,
  siteProfileVersionId: "site-profile-v4",
  pinPromotionTargetVersionId: "promotion-v2",
  keywordEvidenceSnapshotIds: ["keyword-snapshot-1"],
  sharedEvidenceSnapshotIds: [ids.evidence, ids.evidence2],
  pinMarket: "US",
  qualificationContractVersion: "recommendation-qualification.v1",
  immutableFingerprint: "pins-fingerprint",
  outreachProfileRecordId: ids.outreach,
  outreachProfileVersionId: "profile-v2",
  profilePromotionTargetVersionId: "promotion-v2",
  keywordsAndTopics: ["technical seo"],
  productsAndServices: ["seo audit"],
  targetUrls: ["https://example.test/audit"],
  targetAudiences: ["site owners"],
  partnershipGoals: ["editorial mention"],
  profileMarket: "US",
  profileLocation: "United States",
  profileLanguage: "en",
  authorizedDiscoverySources: ["shared-seo-evidence"],
  profileImmutableFingerprint: "profile-fingerprint",
};

const evidenceRow = (
  recordId: string,
  sourceRecordId: string,
): Record<string, unknown> => ({
  recordId,
  evidenceType: "keyword-opportunity",
  sourceModule: "keywords",
  sourceRecordId,
  sourceVersion: "v1",
  provider: "dataforseo",
  endpoint: "labs/google/keyword_ideas/live",
  normalizedParameters: { location_code: 2840, language_code: "en" },
  requestFingerprint: `request-${sourceRecordId}`,
  market: "US",
  location: "United States",
  language: "en",
  fetchedAt: new Date("2026-08-15T01:00:00.000Z"),
  expiresAt: "2026-08-17T01:00:00.000Z",
  providerRequestId: `provider-${sourceRecordId}`,
  providerTaskId: null,
  costMicros: "2000",
  artifactRef: `s3://evidence/${sourceRecordId}.json`,
  status: "ready",
});

const createBindingPool = (
  evidenceRows: readonly Record<string, unknown>[],
) => {
  const queries: string[] = [];
  let released = false;
  const pool: BacklinkTenantPool = {
    async connect() {
      return {
        async query(text): Promise<BacklinkTransactionQueryResult> {
          const sql = text.replace(/\s+/g, " ").trim();
          queries.push(sql);
          if (sql.includes(
            "FROM backlinks.backlink_generation_input_pins AS pin",
          )) {
            return { rows: [{ ...pinRow }], rowCount: 1 };
          }
          if (sql.includes(
            "FROM backlinks.backlink_shared_seo_evidence_references",
          )) {
            return { rows: [...evidenceRows], rowCount: evidenceRows.length };
          }
          return { rows: [], rowCount: 0 };
        },
        release() {
          released = true;
        },
      };
    },
  };
  return { pool, queries, released: () => released };
};

describe("Backlinks project input persistence", () => {
  it("persists immutable versions inside the existing tenant transaction", async () => {
    const fake = createFakePool();
    const repository = createProjectInputPersistenceRepository(fake.pool);
    const common = {
      organizationId: "018f0000-0000-7000-8000-000000000001",
      websiteProjectId: "018f0000-0000-7000-8000-000000000003",
    };
    const workspaceId = "018f0000-0000-7000-8000-000000000002";

    await expect(repository.saveOutreachProfile({
      recordId: ids.outreach,
      workspaceId,
      createdBy: "user-1",
      profile: {
        ...common,
        profileVersionId: "profile-v1",
        promotionTargetVersionId: "promotion-v1",
        keywordsAndTopics: ["technical seo"],
        productsAndServices: ["seo audit"],
        targetUrls: ["https://example.test/audit"],
        targetAudiences: ["site owners"],
        partnershipGoals: ["editorial mention"],
        market: "US",
        location: "United States",
        language: "en",
        authorizedDiscoverySources: ["shared-seo-evidence"],
        immutableFingerprint: "profile-fingerprint",
      },
    })).resolves.toBe(ids.outreach);

    await expect(repository.saveSharedSeoEvidenceReference({
      recordId: ids.evidence,
      workspaceId,
      createdBy: "user-1",
      snapshot: {
        ...common,
        evidenceType: "keyword-opportunity",
        sourceModule: "keywords",
        sourceRecordId: "keyword-snapshot-1",
        sourceVersion: "v1",
        provider: "dataforseo",
        endpoint: "labs/google/keyword_ideas/live",
        normalizedParameters: { location_code: 2840, language_code: "en" },
        requestFingerprint: "request-fingerprint",
        market: "US",
        location: "United States",
        language: "en",
        fetchedAt: "2026-08-15T01:00:00.000Z",
        expiresAt: "2026-08-16T01:00:00.000Z",
        providerRequestId: "provider-request-1",
        providerTaskId: null,
        costMicros: 0,
        artifactRef: "s3://evidence/keyword-snapshot-1.json",
        status: "ready",
      },
    })).resolves.toBe(ids.evidence);

    await expect(repository.saveGenerationInputPins({
      recordId: ids.pins,
      workspaceId,
      outreachProfileRecordId: ids.outreach,
      createdBy: "user-1",
      immutableFingerprint: "pins-fingerprint",
      pins: {
        ...common,
        projectContextVersion: 1,
        siteProfileVersionId: "site-profile-v1",
        outreachProfileVersionId: "profile-v1",
        promotionTargetVersionId: "promotion-v1",
        keywordEvidenceSnapshotIds: ["keyword-snapshot-1"],
        sharedEvidenceSnapshotIds: [ids.evidence],
        market: "US",
        qualificationContractVersion: "qualification-v1",
      },
    })).resolves.toBe(ids.pins);

    expect(fake.queries.filter((query) => query === "BEGIN")).toHaveLength(3);
    expect(fake.queries.filter((query) => query === "COMMIT")).toHaveLength(3);
    expect(fake.queries.some((query) => query === "ROLLBACK")).toBe(false);
    expect(
      fake.queries.filter((query) =>
        query.includes("set_config('app.current_workspace_id'"),
      ),
    ).toHaveLength(3);
    expect(fake.released()).toBe(true);
  });

  it("loads an exact tenant-scoped pin and preserves pinned evidence order", async () => {
    const fake = createBindingPool([
      evidenceRow(ids.evidence2, "keyword-snapshot-2"),
      evidenceRow(ids.evidence, "keyword-snapshot-1"),
    ]);
    const repository = createProjectInputPersistenceRepository(fake.pool);

    await expect(
      repository.readGenerationInputBinding(bindingInput),
    ).resolves.toMatchObject({
      inputPinId: ids.pins,
      outreachProfileRecordId: ids.outreach,
      immutableFingerprint: "pins-fingerprint",
      pins: {
        projectContextVersion: 4,
        outreachProfileVersionId: "profile-v2",
        sharedEvidenceSnapshotIds: [ids.evidence, ids.evidence2],
        qualificationContractVersion: "recommendation-qualification.v1",
      },
      outreachProfile: {
        profileVersionId: "profile-v2",
        promotionTargetVersionId: "promotion-v2",
        market: "US",
      },
      sharedEvidence: [
        {
          recordId: ids.evidence,
          snapshot: {
            sourceRecordId: "keyword-snapshot-1",
            costMicros: 2000,
            fetchedAt: "2026-08-15T01:00:00.000Z",
          },
        },
        {
          recordId: ids.evidence2,
          snapshot: { sourceRecordId: "keyword-snapshot-2" },
        },
      ],
    });
    expect(fake.queries).toContain("BEGIN");
    expect(fake.queries).toContain("COMMIT");
    expect(fake.queries).not.toContain("ROLLBACK");
    expect(fake.released()).toBe(true);
  });

  it("fails closed when a referenced evidence row is unavailable", async () => {
    const fake = createBindingPool([
      evidenceRow(ids.evidence, "keyword-snapshot-1"),
    ]);
    const repository = createProjectInputPersistenceRepository(fake.pool);

    await expect(
      repository.readGenerationInputBinding(bindingInput),
    ).rejects.toThrow(`missing pinned evidence ${ids.evidence2}`);
    expect(fake.queries).toContain("ROLLBACK");
    expect(fake.queries).not.toContain("COMMIT");
    expect(fake.released()).toBe(true);
  });
});
