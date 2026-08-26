import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { prepareCurrentCommercialCandidateEnrichment } from "../../../src/modules/backlinks/application/services/current-commercial-candidate-enrichment.service.js";
import { reassessCurrentCommercialCandidates } from "../../../src/modules/backlinks/application/services/current-commercial-candidate-reassessment.service.js";
import { evaluateCommercialCandidate } from "../../../src/modules/backlinks/domain/recommendations/commercial-candidate-evaluation.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
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
  ): Promise<{ rows: Record<string, unknown>[] }>;
};

type RuntimePool = BacklinkTenantPool & {
  end(): Promise<void>;
};

const require = createRequire(import.meta.url);
const { Client, Pool } = require("pg") as {
  readonly Client: new (config: unknown) => RuntimeClient;
  readonly Pool: new (config: unknown) => RuntimePool;
};
const migrationDirectory = new URL(
  "../../../src/modules/backlinks/db/migrations/",
  import.meta.url,
);
const rolesMigration = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);

const id = (value: number) =>
  `018f2000-0000-7000-8000-${value.toString().padStart(12, "0")}`;

const organizationId = id(1);
const workspaceId = id(2);
const websiteProjectId = id(3);
const contextVersionId = id(4);
const outreachProfileId = id(5);
const inputPinId = id(6);
const jobId = id(7);
const refillId = id(8);
const blueprintId = id(9);
const discoveryBatchId = id(10);
const candidateId = id(11);
const excludedCandidateId = id(12);
const manualCandidateId = id(13);
const generationInputFingerprint = "generation-fingerprint-v8";
const now = new Date("2026-08-19T16:00:00.000Z");
const scope = { organizationId, workspaceId, websiteProjectId };

const staticAssessment = {
  canonicalDomain: "publisher.example",
  decision: "ready",
  language: "en",
  topics: ["film reviews"],
  matchedProducts: ["streaming entertainment"],
  matchedTopics: ["film reviews"],
  matchedKeywords: ["film reviews"],
  matchedTargetPages: [],
  matchedAudiences: [],
  matchedPartnershipGoals: [],
  relatedContentPages: ["https://publisher.example/reviews"],
  productRelevance: 0.4,
  editorialQuality: 0.2,
  siteType: "specialist_blog",
  monetizationMethods: [],
  cooperationPages: [],
  outboundLinkDensity: 0.8,
  technicalAccessibility: 1,
  unsafeOrMalicious: false,
  highConfidenceLinkFarm: false,
  unrelatedIndustry: false,
  evidenceUrls: ["https://publisher.example/"],
  evidenceRefs: ["safefetch:publisher.example"],
  failedUrls: [],
  collectedAt: "2026-08-19T00:00:00.000Z",
  ruleVersion: "commercial-static-assessment.v3",
} as const;

const business = {
  selfOrRelatedDomain: false,
  existingBacklinkOrOpportunity: false,
  permanentlyRejectedOrSuppressed: false,
  unsafeOrDisallowedIndustry: false,
  targetCountryCode: "ZA",
  candidateCountryCode: "ZA",
  targetLanguages: ["en-ZA", "en"],
  allowSameLanguageExpansion: false,
  targetMarketScopedDiscovery: true,
} as const;

const provider = {
  rank: 0,
  traffic: 0,
  backlinkCount: null,
  referringDomainCount: null,
  spamScore: 50,
  countryCode: "ZA",
  backlinkPageEvidence: [],
  evidenceRefs: ["dataforseo:discovery:publisher.example"],
  collectedAt: "2026-08-19T00:00:00.000Z",
} as const;

const nearThresholdScore = evaluateCommercialCandidate({
  business,
  provider,
  staticAssessment,
});
const unsafeAssessment = {
  ...staticAssessment,
  canonicalDomain: "unsafe.example",
  unsafeOrMalicious: true,
} as const;
const unsafeScore = evaluateCommercialCandidate({
  business,
  provider,
  staticAssessment: unsafeAssessment,
});
const manualScore = {
  ...nearThresholdScore,
  decision: "manual_review",
  total: null,
} as const;

async function migrateBacklinks(client: RuntimeClient): Promise<void> {
  const migrationNames = (await readdir(fileURLToPath(migrationDirectory)))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrationNames.filter(
    (item) => item >= "0002_" && item < "0005_",
  )) {
    await client.query(
      await readFile(new URL(name, migrationDirectory), "utf8"),
    );
  }
  await client.query(await readFile(rolesMigration, "utf8"));
  for (const name of migrationNames.filter(
    (item) => item >= "0005_" && !item.startsWith("0044_"),
  )) {
    await client.query(
      await readFile(new URL(name, migrationDirectory), "utf8"),
    );
  }
}

async function seedCurrentGeneration(client: RuntimeClient): Promise<void> {
  await client.query(
    `INSERT INTO backlinks.backlink_project_context_snapshots (
       id,organization_id,workspace_id,website_project_id,snapshot_version,
       project_status,canonical_domain,locale,country_code,
       profile_version_id,promotion_target_version_id,products,keywords,
       target_urls,target_market,target_audiences,partnership_goals,created_by
     ) VALUES (
       $1,$2,$3,$4,8,'ACTIVE','elephtv.com','en','ZA',
       'profile-v4','promotion-v2','["streaming entertainment"]'::jsonb,
       '["film reviews"]'::jsonb,
       '["https://elephtv.com/reviews"]'::jsonb,
       'ZA','["South African viewers"]'::jsonb,
       '["editorial review"]'::jsonb,'stage2d-test'
     )`,
    [contextVersionId, organizationId, workspaceId, websiteProjectId],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_outreach_profile_versions (
       id,organization_id,workspace_id,website_project_id,
       profile_version_id,promotion_target_version_id,keywords_and_topics,
       products_and_services,target_urls,target_audiences,partnership_goals,
       market,location,language,authorized_discovery_sources,
       immutable_fingerprint,created_by
     ) VALUES (
       $1,$2,$3,$4,'profile-v4','promotion-v2',
       '["film reviews"]'::jsonb,'["streaming entertainment"]'::jsonb,
       '["https://elephtv.com/reviews"]'::jsonb,
       '["South African viewers"]'::jsonb,'["editorial review"]'::jsonb,
       'ZA','ZA','en','["shared-seo-evidence"]'::jsonb,
       'profile-fingerprint-v4','stage2d-test'
     )`,
    [outreachProfileId, organizationId, workspaceId, websiteProjectId],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_generation_input_pins (
       id,organization_id,workspace_id,website_project_id,
       project_context_version,site_profile_version_id,
       outreach_profile_version_id,promotion_target_version_id,
       keyword_evidence_snapshot_ids,shared_evidence_snapshot_ids,market,
       qualification_contract_version,immutable_fingerprint,created_by
     ) VALUES (
       $1,$2,$3,$4,8,'profile-v4',$5,'promotion-v2',
       '[]'::jsonb,'[]'::jsonb,'ZA','recommendation-qualification.v1',
       $6,'stage2d-test'
     )`,
    [
      inputPinId,
      organizationId,
      workspaceId,
      websiteProjectId,
      outreachProfileId,
      generationInputFingerprint,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_jobs (
       id,organization_id,workspace_id,website_project_id,job_type,
       source_object_type,source_object_id,status,workflow_id,correlation_id,
       started_at,finished_at,created_by,updated_by
     ) VALUES (
       $1,$2,$3,$4,'recommendation_refill','recommendation_context',$5,
       'success','stage2d-existing-generation','stage2d-existing-generation',
       '2026-08-19T15:00:00Z','2026-08-19T15:10:00Z',
       'stage2d-test','stage2d-test'
     )`,
    [jobId, organizationId, workspaceId, websiteProjectId, contextVersionId],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_recommendation_refills (
       id,organization_id,workspace_id,website_project_id,job_id,
       recommendation_context_version_id,visible_pool_generation,
       trigger_reason,low_watermark,high_watermark,refill_window_key,
       created_by,updated_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,1,'inventory_low',9,10,
       'stage2d-existing-generation','stage2d-test','stage2d-test'
     )`,
    [
      refillId,
      organizationId,
      workspaceId,
      websiteProjectId,
      jobId,
      contextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_blueprints (
       id,organization_id,workspace_id,website_project_id,
       project_context_version_id,blueprint_version,generator,schema_version,
       prompt_version,rule_version,blueprint,evidence_refs,generated_at,
       created_by
     ) VALUES (
       $1,$2,$3,$4,$5,1,'DETERMINISTIC_FALLBACK','stage2d.v1',
       'stage2d.v1','stage2d.v1','{}'::jsonb,'[]'::jsonb,
       '2026-08-19T15:00:00Z','stage2d-test'
     )`,
    [
      blueprintId,
      organizationId,
      workspaceId,
      websiteProjectId,
      contextVersionId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_discovery_batches (
       id,organization_id,workspace_id,website_project_id,blueprint_id,
       project_context_version_id,status,idempotency_key,request_intent,
       source_types,started_at,finished_at,created_by,
       visible_pool_generation,refill_job_id,raw_candidate_count
     ) VALUES (
       $1,$2,$3,$4,$5,$6,'completed','stage2d-existing-generation',
       'DISCOVERY','["BLUEPRINT_SERP_STANDARD_QUEUE"]'::jsonb,
       '2026-08-19T15:01:00Z','2026-08-19T15:09:00Z','stage2d-test',
       1,$7,3
     )`,
    [
      discoveryBatchId,
      organizationId,
      workspaceId,
      websiteProjectId,
      blueprintId,
      contextVersionId,
      jobId,
    ],
  );
  await client.query(
    `INSERT INTO backlinks.backlink_commercial_candidates (
       id,organization_id,workspace_id,website_project_id,blueprint_id,
       discovery_batch_id,project_context_version_id,canonical_domain,
       source_types,static_assessment,gate_decision,commercial_score,
       score_model_version,state,created_by,updated_by,visible_pool_generation
     ) VALUES
     (
       $1,$4,$5,$6,$7,$8,$9,'publisher.example',
       '["BLUEPRINT_SERP_STANDARD_QUEUE"]'::jsonb,$10::jsonb,$11::jsonb,
       $12::jsonb,'recommendation-commercial-fit.v4','insufficient_data',
       'stage2d-test','stage2d-test',1
     ),
     (
       $2,$4,$5,$6,$7,$8,$9,'unsafe.example',
       '["BLUEPRINT_SERP_STANDARD_QUEUE"]'::jsonb,$13::jsonb,$14::jsonb,
       $15::jsonb,'recommendation-commercial-fit.v4','excluded',
       'stage2d-test','stage2d-test',1
     ),
     (
       $3,$4,$5,$6,$7,$8,$9,'manual.example',
       '["BLUEPRINT_SERP_STANDARD_QUEUE"]'::jsonb,$16::jsonb,$17::jsonb,
       $18::jsonb,'recommendation-commercial-fit.v4','manual_review',
       'stage2d-test','stage2d-test',1
     )`,
    [
      candidateId,
      excludedCandidateId,
      manualCandidateId,
      organizationId,
      workspaceId,
      websiteProjectId,
      blueprintId,
      discoveryBatchId,
      contextVersionId,
      JSON.stringify(staticAssessment),
      JSON.stringify({
        decision: nearThresholdScore.decision,
        hitGates: nearThresholdScore.hitGates,
        missingEvidence: nearThresholdScore.missingEvidence,
      }),
      JSON.stringify(nearThresholdScore),
      JSON.stringify(unsafeAssessment),
      JSON.stringify({
        decision: unsafeScore.decision,
        hitGates: unsafeScore.hitGates,
        missingEvidence: unsafeScore.missingEvidence,
      }),
      JSON.stringify(unsafeScore),
      JSON.stringify({
        ...staticAssessment,
        canonicalDomain: "manual.example",
      }),
      JSON.stringify({
        decision: "manual_review",
        hitGates: [],
        missingEvidence: ["manual_review"],
      }),
      JSON.stringify(manualScore),
    ],
  );
}

function prepare(apply: boolean, overrides: Record<string, unknown> = {}) {
  return withBacklinkTenantTransaction(
    pool,
    scope,
    (transaction) => prepareCurrentCommercialCandidateEnrichment(
      transaction,
      {
        ...scope,
        projectContextVersionId: contextVersionId,
        visiblePoolGeneration: 1,
        actorId: "stage2d-test",
        now,
        generationInputFingerprint,
        maximumCandidates: 25,
        apply,
        ...overrides,
      },
    ),
  );
}

let harness: BacklinksPostgresHarness;
let client: RuntimeClient;
let pool: RuntimePool;

describe("current generation commercial candidate enrichment", () => {
  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new Client({ connectionString: harness.connectionString });
    await client.connect();
    await migrateBacklinks(client);
    pool = new Pool({
      connectionString: harness.connectionString,
      options: "-c search_path=backlinks,pg_catalog",
    });
  }, 180_000);

  beforeEach(async () => {
    await client.query(`
      TRUNCATE backlinks.backlink_commercial_candidates,
        backlinks.backlink_commercial_discovery_batches,
        backlinks.backlink_commercial_discovery_blueprints,
        backlinks.backlink_recommendation_refills,
        backlinks.backlink_jobs,
        backlinks.backlink_generation_input_pins,
        backlinks.backlink_outreach_profile_versions,
        backlinks.backlink_project_context_snapshots
      CASCADE
    `);
    await seedCurrentGeneration(client);
  });

  afterAll(async () => {
    await pool?.end();
    await client?.end();
    await harness?.stop();
  });

  it("prepares once under concurrency and never revives excluded or manual candidates", async () => {
    const results = await Promise.all([prepare(true), prepare(true)]);

    expect(results.map(({ preparedCount }) => preparedCount).sort()).toEqual([
      0,
      1,
    ]);
    const rows = (await client.query(
      `SELECT canonical_domain AS domain,state,version
         FROM backlinks.backlink_commercial_candidates
        ORDER BY canonical_domain`,
    )).rows;
    expect(rows).toEqual([
      { domain: "manual.example", state: "manual_review", version: 1 },
      { domain: "publisher.example", state: "enrichment_eligible", version: 2 },
      { domain: "unsafe.example", state: "excluded", version: 1 },
    ]);
  });

  it("replays without writes and fails closed on generation or pin mismatch", async () => {
    await expect(prepare(true)).resolves.toMatchObject({ preparedCount: 1 });
    await expect(prepare(true)).resolves.toMatchObject({ preparedCount: 0 });
    await expect(prepare(true, {
      visiblePoolGeneration: 2,
    })).resolves.toMatchObject({
      candidates: [],
      preparedCount: 0,
    });
    await expect(prepare(true, {
      generationInputFingerprint: "wrong-generation-fingerprint",
    })).resolves.toMatchObject({
      candidates: [],
      preparedCount: 0,
    });

    const state = (await client.query(
      `SELECT state,version
         FROM backlinks.backlink_commercial_candidates
        WHERE id=$1`,
      [candidateId],
    )).rows[0];
    expect(state).toEqual({ state: "enrichment_eligible", version: 2 });
  });

  it("fails closed when a newer authoritative context exists", async () => {
    await client.query(
      `INSERT INTO backlinks.backlink_project_context_snapshots (
         id,organization_id,workspace_id,website_project_id,snapshot_version,
         project_status,canonical_domain,locale,country_code,
         profile_version_id,promotion_target_version_id,products,keywords,
         target_urls,target_market,target_audiences,partnership_goals,created_by
       ) VALUES (
         $1,$2,$3,$4,9,'ACTIVE','elephtv.com','en','ZA',
         'profile-v5','promotion-v2','["streaming entertainment"]'::jsonb,
         '["film reviews"]'::jsonb,
         '["https://elephtv.com/reviews"]'::jsonb,
         'ZA','["South African viewers"]'::jsonb,
         '["editorial review"]'::jsonb,'stage2d-test'
       )`,
      [id(14), organizationId, workspaceId, websiteProjectId],
    );

    await expect(prepare(true)).resolves.toMatchObject({
      candidates: [],
      preparedCount: 0,
    });
    const state = (await client.query(
      `SELECT state,version
         FROM backlinks.backlink_commercial_candidates
        WHERE id=$1`,
      [candidateId],
    )).rows[0];
    expect(state).toEqual({ state: "insufficient_data", version: 1 });
  });

  it("reassesses a stale 55-point admission once under the current 50-point rule", async () => {
    const assessment = {
      ...staticAssessment,
      productRelevance: 0.5,
      editorialQuality: 0.4,
      matchedTargetPages: ["https://elephtv.com/reviews"],
      matchedAudiences: [],
      cooperationPages: [],
      outboundLinkDensity: 0.1,
    } as const;
    const currentScore = evaluateCommercialCandidate({
      business,
      provider: {
        rank: null,
        traffic: null,
        backlinkCount: null,
        referringDomainCount: null,
        spamScore: null,
        evidenceRefs: ["dataforseo:publisher.example"],
        collectedAt: "2026-08-19T00:00:00.000Z",
      },
      staticAssessment: assessment,
    });
    expect(currentScore.decision).toBe("eligible");
    expect(currentScore.total).toBeGreaterThanOrEqual(50);
    expect(currentScore.total).toBeLessThan(55);

    await client.query(
      `UPDATE backlinks.backlink_commercial_candidates
          SET static_assessment=$2::jsonb,
              gate_decision=$3::jsonb,
              commercial_score=$4::jsonb,
              state='insufficient_data'
        WHERE id=$1`,
      [
        candidateId,
        JSON.stringify(assessment),
        JSON.stringify({
          decision: "ineligible",
          hitGates: [],
          missingEvidence: currentScore.missingEvidence,
        }),
        JSON.stringify({
          ...currentScore,
          decision: "ineligible",
          admission: {
            ...currentScore.admission,
            baselineThreshold: 55,
            appliedThreshold: 55,
            fallbackApplied: false,
          },
        }),
      ],
    );

    const reassess = () =>
      withBacklinkTenantTransaction(
        pool,
        scope,
        (transaction) =>
          reassessCurrentCommercialCandidates(transaction, {
            ...scope,
            projectContextVersionId: contextVersionId,
            visiblePoolGeneration: 1,
            actorId: "stage2r-threshold-reassessment",
            now,
          }),
      );

    await expect(reassess()).resolves.toEqual({ reassessedCount: 1 });
    await expect(reassess()).resolves.toEqual({ reassessedCount: 0 });

    const state = (await client.query(
      `SELECT state,version,
              commercial_score->>'decision' AS decision,
              commercial_score#>>'{admission,appliedThreshold}' AS threshold
         FROM backlinks.backlink_commercial_candidates
        WHERE id=$1`,
      [candidateId],
    )).rows[0];
    expect(state).toEqual({
      state: "candidate_ready",
      version: 2,
      decision: "eligible",
      threshold: "50",
    });
  });
});
