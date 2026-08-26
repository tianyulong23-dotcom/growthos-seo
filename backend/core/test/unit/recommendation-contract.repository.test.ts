import { describe, expect, it } from "vitest";

import {
  createRecommendationContractRepository,
  writeCorrectedRecommendationFactsInTransaction,
} from "../../src/modules/backlinks/db/repositories/recommendation-contract.repository.js";
import type {
  BacklinkTenantPool,
  BacklinkTransactionQueryResult,
} from "../../src/modules/backlinks/db/tenant-transaction.js";
import {
  CORRECTED_QUALIFICATION_CONTRACT_VERSION,
  CORRECTED_SCORE_MODEL_VERSION,
  CORRECTED_VISIBILITY_CONTRACT_VERSION,
  RecommendationContractVersionMismatchError,
  type CreateCorrectedGenerationInput,
  type WriteCorrectedRecommendationInput,
  type WriteQualificationFactInput,
} from "../../src/modules/backlinks/ports/recommendation-contract.port.js";

const id = (value: number) =>
  `018f0062-0000-7000-8000-${String(value).padStart(12, "0")}`;

const scope = {
  organizationId: id(1),
  workspaceId: id(2),
  websiteProjectId: id(3),
  recommendationContextVersionId: id(4),
};

const createGenerationInput = (
  workerContractVersion = CORRECTED_QUALIFICATION_CONTRACT_VERSION,
): CreateCorrectedGenerationInput => ({
  ...scope,
  generationContractId: id(10),
  inputPinId: id(11),
  visiblePoolGeneration: 2,
  metricScope: "TARGET_MARKET",
  market: "US",
  location: "United States",
  language: "en",
  trafficLocationCode: 2840,
  trafficLanguageCode: "en",
  requestFingerprints: { traffic: "traffic-request-1" },
  workerContractVersion,
  operation: {
    factId: id(12),
    operationId: "generation-2",
    state: "requested",
    attempt: 1,
    reasonCode: "USER_REFRESH",
    evidence: {},
    observedAt: new Date("2026-08-15T08:00:00.000Z"),
  },
  createdBy: "phase-2-test",
});

const writeInput = (
  workerContractVersion = CORRECTED_QUALIFICATION_CONTRACT_VERSION,
): WriteCorrectedRecommendationInput => ({
  ...scope,
  generationContractId: id(10),
  visiblePoolGeneration: 2,
  workerContractVersion,
  prospectId: id(20),
  recommendationId: id(21),
  scoreId: id(22),
  inventoryId: id(23),
  canonicalDomain: "publisher.test",
  normalizationVersion: "tldts-v1",
  totalScore: 82,
  scoreComponents: [{ name: "semantic", score: 82 }],
  scoreWeights: { semantic: 1 },
  scoreEvidence: { source: "corrected-contract" },
  qualification: {
    factId: id(24),
    metricScope: "TARGET_MARKET",
    trafficOrganicEtv: 45_000,
    spamScore: 4,
    authorityRank: 62,
    accessibilityDecision: "accessible",
    semanticScore: 82,
    attempt: 1,
    decision: "eligible",
    decisionReasonCode: "QUALIFIED",
    modelVersion: "semantic-model-v1",
    promptVersion: "semantic-prompt-v1",
    ruleVersion: "qualification-rules-v1",
    requestFingerprints: { traffic: "traffic-request-1" },
    evidence: { accessibleUrl: "https://publisher.test/" },
  },
  visibility: {
    factId: id(25),
    decision: "visible",
    decisionReasonCode: "QUALIFIED_VISIBLE",
    attempt: 1,
    ruleVersion: "visibility-rules-v1",
    evidence: {},
  },
  contact: {
    factId: id(26),
    decision: "pending",
    decisionReasonCode: "CONTACT_NOT_EVALUATED",
    attempt: 1,
    evidence: {},
  },
  cooperationPath: {
    factId: id(27),
    decision: "pending",
    decisionReasonCode: "PATH_NOT_EVALUATED",
    pathType: null,
    attempt: 1,
    evidence: {},
  },
  observedAt: new Date("2026-08-15T08:01:00.000Z"),
  createdBy: "phase-2-test",
});

const qualificationInput = (
  workerContractVersion = CORRECTED_QUALIFICATION_CONTRACT_VERSION,
): WriteQualificationFactInput => {
  const corrected = writeInput(workerContractVersion);
  return {
    ...scope,
    generationContractId: corrected.generationContractId,
    workerContractVersion,
    candidateId: id(28),
    canonicalDomain: corrected.canonicalDomain,
    qualification: corrected.qualification,
    observedAt: corrected.observedAt,
    createdBy: "phase-4-test",
  };
};

const createFakePool = (
  rowsForSql: (sql: string) => readonly Record<string, unknown>[] = () => [],
) => {
  const queries: string[] = [];
  let connections = 0;
  const pool: BacklinkTenantPool = {
    async connect() {
      connections += 1;
      return {
        async query(text): Promise<BacklinkTransactionQueryResult> {
          const sql = text.replace(/\s+/gu, " ").trim();
          queries.push(sql);
          const rows = [...rowsForSql(sql)];
          return { rows, rowCount: rows.length };
        },
        release() {},
      };
    },
  };
  return { pool, queries, connections: () => connections };
};

const generationRow = {
  id: id(10),
  qualificationContractVersion: CORRECTED_QUALIFICATION_CONTRACT_VERSION,
  visibilityContractVersion: CORRECTED_VISIBILITY_CONTRACT_VERSION,
  scoreModelVersion: CORRECTED_SCORE_MODEL_VERSION,
};

describe("corrected recommendation compatibility repository", () => {
  it("rejects a delayed Worker before opening a database connection", async () => {
    const fake = createFakePool();
    const repository = createRecommendationContractRepository(fake.pool);

    await expect(
      repository.createCorrectedGeneration(
        createGenerationInput("recommendation-qualification.v0"),
      ),
    ).rejects.toBeInstanceOf(RecommendationContractVersionMismatchError);
    await expect(
      repository.writeCorrectedRecommendation(
        writeInput("recommendation-qualification.v0"),
      ),
    ).rejects.toBeInstanceOf(RecommendationContractVersionMismatchError);
    await expect(
      repository.writeQualificationFact(
        qualificationInput("recommendation-qualification.v0"),
      ),
    ).rejects.toBeInstanceOf(RecommendationContractVersionMismatchError);

    expect(fake.connections()).toBe(0);
    expect(fake.queries).toEqual([]);
  });

  it("rejects an occupied legacy generation before corrected work starts", async () => {
    const fake = createFakePool((sql) =>
      sql.includes("visible_pool_generation = $5")
        ? [{
            ...generationRow,
            scoreModelVersion: "recommendation-commercial-fit.v3",
          }]
        : [],
    );
    const repository = createRecommendationContractRepository(fake.pool);

    await expect(repository.assertCorrectedGenerationAvailable({
      ...scope,
      generationContractId: id(10),
      visiblePoolGeneration: 2,
      workerContractVersion: CORRECTED_QUALIFICATION_CONTRACT_VERSION,
    })).rejects.toThrow(
      "Corrected recommendation generation contract is incompatible.",
    );
    expect(fake.queries.some((sql) =>
      sql.includes("visible_pool_generation = $5")
    )).toBe(true);
    expect(fake.queries.some((sql) =>
      sql.includes("INSERT INTO backlinks.")
    )).toBe(false);
  });

  it("writes a candidate qualification fact without creating visible rows", async () => {
    const fake = createFakePool((sql) =>
      sql.includes("FROM backlinks.backlink_recommendation_generation_contracts")
        ? [generationRow]
        : [],
    );
    const repository = createRecommendationContractRepository(fake.pool);

    await repository.writeQualificationFact(qualificationInput());

    const qualificationInsert = fake.queries.find((sql) =>
      sql.includes(
        "INSERT INTO backlinks.backlink_recommendation_qualification_facts",
      ),
    );
    expect(qualificationInsert).toContain(
      "candidate_id, recommendation_id, prospect_id",
    );
    expect(qualificationInsert).toContain("$7, NULL, NULL");
    expect(fake.queries.some((sql) =>
      sql.includes("INSERT INTO backlinks.backlink_prospects")
      || sql.includes("INSERT INTO backlinks.backlink_recommendations")
      || sql.includes("INSERT INTO backlinks.backlink_recommendation_inventory")
      || sql.includes("INSERT INTO backlinks.backlink_recommendation_visibility")
    )).toBe(false);
  });

  it("appends a new immutable attempt and idempotently ignores the same fact id", async () => {
    const fake = createFakePool((sql) =>
      sql.includes("FROM backlinks.backlink_recommendation_generation_contracts")
        ? [generationRow]
        : [],
    );
    const repository = createRecommendationContractRepository(fake.pool);

    await repository.writeQualificationFact(qualificationInput());

    const qualificationInsert = fake.queries.find((sql) =>
      sql.includes(
        "INSERT INTO backlinks.backlink_recommendation_qualification_facts",
      ),
    );
    expect(qualificationInsert).toContain(
      "pg_advisory_xact_lock",
    );
    expect(qualificationInsert).toContain(
      "COALESCE(MAX(existing.attempt) + 1, 1)",
    );
    expect(qualificationInsert).toContain(
      "GREATEST( $15::integer",
    );
    expect(qualificationInsert).toContain(
      "next_attempt.attempt",
    );
    expect(qualificationInsert).toContain(
      "ON CONFLICT (id) DO NOTHING",
    );
    expect(qualificationInsert).not.toContain("DO UPDATE");
  });

  it("appends publication facts when the requested attempt is already occupied", async () => {
    const fake = createFakePool((sql) =>
      sql.includes("FROM backlinks.backlink_recommendation_generation_contracts")
        ? [generationRow]
        : [],
    );
    const client = await fake.pool.connect();
    const input = writeInput();

    await writeCorrectedRecommendationFactsInTransaction(client, {
      ...input,
      qualification: { ...input.qualification, attempt: 2 },
      visibility: { ...input.visibility, attempt: 2 },
      contact: { ...input.contact, attempt: 2 },
      cooperationPath: { ...input.cooperationPath, attempt: 2 },
    });
    client.release();

    const qualificationInsert = fake.queries.find((sql) =>
      sql.includes("INSERT INTO backlinks.backlink_recommendation_qualification_facts")
    );
    expect(qualificationInsert).toContain("pg_advisory_xact_lock");
    expect(qualificationInsert).toContain(
      "COALESCE(MAX(existing.attempt) + 1, 1)",
    );
    expect(qualificationInsert).toContain("GREATEST( $16::integer");
    expect(qualificationInsert).toContain("next_attempt.attempt");
    expect(qualificationInsert).toContain("ON CONFLICT (id) DO NOTHING");
    expect(qualificationInsert).not.toContain(
      "backlink_rec_qualification_attempt_uq",
    );

    const visibilityInsert = fake.queries.find((sql) =>
      sql.includes("INSERT INTO backlinks.backlink_recommendation_visibility_facts")
    );
    expect(visibilityInsert).toContain("pg_advisory_xact_lock");
    expect(visibilityInsert).toContain("GREATEST( $13::integer");
    expect(visibilityInsert).toContain("next_attempt.attempt");
    expect(visibilityInsert).toContain("ON CONFLICT (id) DO NOTHING");
    expect(visibilityInsert).not.toContain(
      "backlink_rec_visibility_attempt_uq",
    );

    for (const table of [
      "backlink_recommendation_contact_facts",
      "backlink_recommendation_cooperation_path_facts",
    ]) {
      const insert = fake.queries.find((sql) =>
        sql.includes(`INSERT INTO backlinks.${table}`)
      );
      expect(insert).toContain("pg_advisory_xact_lock");
      expect(insert).toContain("GREATEST( $12::integer");
      expect(insert).toContain("next_attempt.attempt");
      expect(insert).toContain("ON CONFLICT (id) DO NOTHING");
      expect(insert).not.toContain("DO UPDATE");
    }
    expect(fake.queries.some((sql) =>
      sql.includes("INSERT INTO backlinks.backlink_prospects")
      || sql.includes("INSERT INTO backlinks.backlink_recommendations")
      || sql.includes("INSERT INTO backlinks.backlink_recommendation_scores")
      || sql.includes("INSERT INTO backlinks.backlink_recommendation_inventory")
    )).toBe(false);
  });

  it("writes independent corrected facts and a non-published V3 projection", async () => {
    const fake = createFakePool((sql) =>
      sql.includes("FROM backlinks.backlink_recommendation_generation_contracts")
        ? [generationRow]
        : [],
    );
    const repository = createRecommendationContractRepository(fake.pool);

    await repository.createCorrectedGeneration(createGenerationInput());
    await repository.writeCorrectedRecommendation(writeInput());

    expect(
      fake.queries.some((sql) =>
        sql.includes("backlink_recommendation_generation_contracts"),
      ),
    ).toBe(true);
    expect(
      fake.queries
        .filter((sql) =>
          sql.includes(
            "FROM backlinks.backlink_recommendation_generation_contracts",
          ),
        )
        .every((sql) => !sql.includes("FOR SHARE")),
    ).toBe(true);
    expect(
      fake.queries.some((sql) =>
        sql.includes("backlink_generation_operation_facts"),
      ),
    ).toBe(true);
    const generationOperationInsert = fake.queries.find((sql) =>
      sql.includes("INSERT INTO backlinks.backlink_generation_operation_facts")
    );
    expect(generationOperationInsert).toContain("pg_advisory_xact_lock");
    expect(generationOperationInsert).toContain(
      "COALESCE(MAX(existing.attempt) + 1, 1)",
    );
    expect(generationOperationInsert).toContain("GREATEST( $9::integer");
    expect(generationOperationInsert).toContain("next_attempt.attempt");
    expect(generationOperationInsert).toContain("ON CONFLICT (id) DO NOTHING");
    expect(generationOperationInsert).not.toContain(
      "backlink_generation_operation_attempt_uq",
    );
    expect(
      fake.queries.some((sql) =>
        sql.includes("backlink_recommendation_qualification_facts"),
      ),
    ).toBe(true);
    expect(
      fake.queries.some((sql) =>
        sql.includes("backlink_recommendation_visibility_facts"),
      ),
    ).toBe(true);
    expect(
      fake.queries.some((sql) =>
        sql.includes("backlink_recommendation_contact_facts"),
      ),
    ).toBe(true);
    expect(
      fake.queries.some((sql) =>
        sql.includes("backlink_recommendation_cooperation_path_facts"),
      ),
    ).toBe(true);
    const inventoryInsert = fake.queries.find((sql) =>
      sql.includes("INSERT INTO backlinks.backlink_recommendation_inventory"),
    );
    expect(inventoryInsert).toContain("'CONTACT_REVIEW'");
    expect(inventoryInsert).toContain("'unassessed'");
    expect(inventoryInsert).toContain("'pending'");
    expect(inventoryInsert).not.toContain("'PUBLISHED'");
  });

  it("prefers corrected facts and falls back to unchanged legacy V3 rows", async () => {
    const correctedFake = createFakePool((sql) =>
      sql.includes("FROM backlinks.backlink_recommendation_qualification_facts")
        ? [{
            recommendationId: id(21),
            prospectId: id(20),
            canonicalDomain: "publisher.test",
            visiblePoolGeneration: 2,
            totalScore: "82.0000",
            qualificationDecision: "eligible",
            qualificationReasonCode: "QUALIFIED",
            visibilityDecision: "visible",
            contactDecision: "pending",
            cooperationPathDecision: "pending",
          }]
        : [],
    );
    const correctedRepository = createRecommendationContractRepository(
      correctedFake.pool,
    );
    await expect(correctedRepository.readRecommendation({
      ...scope,
      recommendationId: id(21),
    })).resolves.toMatchObject({
      contractKind: "corrected-v1",
      totalScore: 82,
      visibilityDecision: "visible",
    });

    const legacyFake = createFakePool((sql) =>
      sql.includes("FROM backlinks.backlink_recommendation_inventory inventory")
        ? [{
            recommendationId: id(31),
            prospectId: id(30),
            canonicalDomain: "legacy.test",
            visiblePoolGeneration: 1,
            totalScore: "71.0000",
            publicationStatus: "CONTACT_REVIEW",
            fitDecision: "eligible",
            contactDecision: "pending",
          }]
        : [],
    );
    const legacyRepository = createRecommendationContractRepository(
      legacyFake.pool,
    );
    await expect(legacyRepository.readRecommendation({
      ...scope,
      recommendationId: id(31),
    })).resolves.toMatchObject({
      contractKind: "legacy-v3",
      totalScore: 71,
      publicationStatus: "CONTACT_REVIEW",
    });
  });
});
