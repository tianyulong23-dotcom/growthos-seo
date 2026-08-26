import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpportunityCommands } from "../../../src/modules/backlinks/application/commands/opportunities.command.js";
import { createOpportunityRepository } from "../../../src/modules/backlinks/db/repositories/opportunity.repository.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import {
  startBacklinksPostgresHarness,
  type BacklinksPostgresHarness,
} from "./harness/postgresql-container.js";
type Client = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};
const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as {
  readonly Client: new (config: unknown) => Client;
};
const migration = (name: string) =>
  new URL(
    `../../../src/modules/backlinks/db/migrations/${name}`,
    import.meta.url,
  );
const roles = new URL(
  "../../../../database/roles/0001_growthos_schema_roles.sql",
  import.meta.url,
);
const manifestUrl = new URL(
  "../../../../database/deployment-manifest.v1.json",
  import.meta.url,
);
type DeploymentManifest = Readonly<{
  steps: readonly Readonly<{
    migrationId: string;
    path: string;
  }>[];
}>;
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1),
  workspaceId = id(2),
  websiteProjectId = id(3);
const recommendationContextVersionId = id(4),
  prospectId = id(5);
const recommendationId = id(6),
  inventoryId = id(7);
const contactCandidateId = id(8),
  contactEvidenceId = id(9);

describe("BL-AI-076 create Opportunity command", () => {
  let harness: BacklinksPostgresHarness, client: Client;
  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await client.query(await readFile(roles, "utf8"));
    await client.query(`
      SET ROLE growthos_platform_owner;
      SET search_path = platform, pg_catalog;
      CREATE FUNCTION backlink_list_active_website_projects(text, text)
      RETURNS TABLE (website_project_id text, context_version integer)
      LANGUAGE sql STABLE SECURITY DEFINER
      SET search_path = platform, pg_catalog
      AS $function$ SELECT NULL::text, NULL::integer WHERE false; $function$;
      REVOKE ALL
        ON FUNCTION backlink_list_active_website_projects(text, text)
        FROM PUBLIC;
      GRANT USAGE ON SCHEMA platform TO growthos_backlinks_owner;
      GRANT EXECUTE
        ON FUNCTION backlink_list_active_website_projects(text, text)
        TO growthos_backlinks_owner;
      RESET ROLE;
      RESET search_path;
    `);
    const manifest = JSON.parse(
      await readFile(manifestUrl, "utf8"),
    ) as DeploymentManifest;
    for (const step of manifest.steps.filter(
      ({ migrationId }) =>
        migrationId.startsWith("backlinks-")
        && migrationId !== "backlinks-0001",
    )) {
      await client.query(
        await readFile(migration(basename(step.path)), "utf8"),
      );
    }
    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(
      `INSERT INTO backlink_prospects (
      id,organization_id,workspace_id,website_project_id,
      recommendation_context_version_id,hostname_ascii,registrable_domain,
      normalization_version,created_by,updated_by
    ) VALUES ($1,$2,$3,$4,$5,'www.publisher.test','publisher.test','tldts-v1','seed','seed')`,
      [
        prospectId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationContextVersionId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_recommendations (
      id,organization_id,workspace_id,website_project_id,prospect_id,
      recommendation_context_version_id,status,created_by,updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,'shown','seed','seed')`,
      [
        recommendationId,
        organizationId,
        workspaceId,
        websiteProjectId,
        prospectId,
        recommendationContextVersionId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_recommendation_inventory (
      id,organization_id,workspace_id,website_project_id,recommendation_id,
      prospect_id,recommendation_context_version_id,status,created_by,updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'shown','seed','seed')`,
      [
        inventoryId,
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationId,
        prospectId,
        recommendationContextVersionId,
      ],
    );
  }, 120_000);
  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  it("creates one Opportunity when the same recommendation is replayed", async () => {
    const context = {
      actor: createActorContext({
        userId: "user-1",
        sessionId: "session-1",
        roles: ["member"],
      }),
      tenant: createTenantContext({ organizationId, workspaceId }),
      project: createProjectContext({
        websiteProjectId,
        canonicalDomain: "owner.test",
        locale: "en-US",
        countryCode: "US",
        profileVersionId: "profile-v1",
        promotionTargetVersionId: "target-v1",
      }),
    };
    const commands = createOpportunityCommands(
      createOpportunityRepository(client),
    );
    const seedReadyRecommendation = async (
      seed: Readonly<{
        prospectId: string;
        recommendationId: string;
        inventoryId: string;
        contactCandidateId: string;
        contactEvidenceId: string;
        contactSnapshotId: string;
        recommendationContextVersionId: string;
        hostname: string;
        registrableDomain: string;
        email: string;
        domainRelation: string;
        confidence: number;
        purpose: string;
        purposeConfidence: number;
      }>,
    ) => {
      await client.query(
        `INSERT INTO backlink_prospects (
        id,organization_id,workspace_id,website_project_id,
        recommendation_context_version_id,hostname_ascii,registrable_domain,
        normalization_version,created_by,updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'tldts-v1','seed','seed')`,
        [
          seed.prospectId,
          organizationId,
          workspaceId,
          websiteProjectId,
          seed.recommendationContextVersionId,
          seed.hostname,
          seed.registrableDomain,
        ],
      );
      await client.query(
        `INSERT INTO backlink_recommendations (
        id,organization_id,workspace_id,website_project_id,prospect_id,
        recommendation_context_version_id,status,created_by,updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,'shown','seed','seed')`,
        [
          seed.recommendationId,
          organizationId,
          workspaceId,
          websiteProjectId,
          seed.prospectId,
          seed.recommendationContextVersionId,
        ],
      );
      await client.query(
        `INSERT INTO backlink_recommendation_inventory (
        id,organization_id,workspace_id,website_project_id,recommendation_id,
        prospect_id,recommendation_context_version_id,status,created_by,updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'shown','seed','seed')`,
        [
          seed.inventoryId,
          organizationId,
          workspaceId,
          websiteProjectId,
          seed.recommendationId,
          seed.prospectId,
          seed.recommendationContextVersionId,
        ],
      );
      await client.query(
        `INSERT INTO backlink_contact_candidates (
        id,organization_id,workspace_id,website_project_id,prospect_id,
        recommendation_context_version_id,normalized_email,email_domain_ascii,
        domain_relation,syntax_validator_version,confidence,guessed,status,
        inferred_purpose,purpose_confidence,created_by,updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,split_part($7,'@',2),$8,
        'email-syntax.v1',$9,false,'candidate',$10,$11,'seed','seed')`,
        [
          seed.contactCandidateId,
          organizationId,
          workspaceId,
          websiteProjectId,
          seed.prospectId,
          seed.recommendationContextVersionId,
          seed.email,
          seed.domainRelation,
          seed.confidence,
          seed.purpose,
          seed.purposeConfidence,
        ],
      );
      await client.query(
        `INSERT INTO backlink_contact_evidence (
        id,organization_id,workspace_id,website_project_id,candidate_id,
        source_url,observed_at,extraction_method,evidence_snippet,parser_version,
        content_sha256,confidence,expires_at,created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,now(),'visible_text',$7,
        'contact-parser.v1',repeat('b',64),$8,now()+interval '30 days','seed')`,
        [
          seed.contactEvidenceId,
          organizationId,
          workspaceId,
          websiteProjectId,
          seed.contactCandidateId,
          `https://${seed.hostname}/contact`,
          seed.email,
          seed.confidence,
        ],
      );
      await client.query(
        `INSERT INTO backlink_contact_evidence_snapshots (
        id,organization_id,workspace_id,website_project_id,recommendation_id,
        prospect_id,recommendation_context_version_id,contact_candidate_id,
        contact_evidence_id,source_url,email_sha256,email_reference,
        inferred_purpose,contact_confidence,purpose_confidence,
        evidence_confidence,collected_at,rules_version,created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,repeat('c',64),$11,
        $12,$13,$14,$13,now(),'contact-publication.v1','seed')`,
        [
          seed.contactSnapshotId,
          organizationId,
          workspaceId,
          websiteProjectId,
          seed.recommendationId,
          seed.prospectId,
          seed.recommendationContextVersionId,
          seed.contactCandidateId,
          seed.contactEvidenceId,
          `https://${seed.hostname}/contact`,
          `contact-evidence:${seed.contactEvidenceId}`,
          seed.purpose,
          seed.confidence,
          seed.purposeConfidence,
        ],
      );
      await client.query(
        `UPDATE backlink_recommendation_inventory
            SET publication_status='PUBLISHED',
                fit_decision='eligible',
                fit_score_model_version='recommendation-commercial-fit.v4',
                contact_decision='eligible',
                contact_reason_code='PUBLIC_EMAIL_FOUND',
                verified_public_email_count=1,
                contact_evidence_snapshot_id=$2,
                default_contact_candidate_id=$3,
                default_contact_source_url=$4,
                default_contact_email_sha256=repeat('c',64),
                default_contact_email_reference=$5,
                contact_collected_at=now(),
                contact_rules_version='contact-publication.v1',
                updated_at=now()
          WHERE id=$1`,
        [
          seed.inventoryId,
          seed.contactSnapshotId,
          seed.contactCandidateId,
          `https://${seed.hostname}/contact`,
          `contact-evidence:${seed.contactEvidenceId}`,
        ],
      );
    };
    const missingContactInput = {
      context,
      recommendationId,
      contactCandidateId,
      expectedVersion: 1,
      idempotencyKey: "accept-rec-no-contact",
      requestId: "request-no-contact",
    };
    await expect(
      commands.createFromRecommendation(missingContactInput),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });
    await client.query(
      `INSERT INTO backlink_contact_candidates (
      id,organization_id,workspace_id,website_project_id,prospect_id,
      recommendation_context_version_id,normalized_email,email_domain_ascii,
      domain_relation,syntax_validator_version,confidence,guessed,status,
      inferred_purpose,purpose_confidence,created_by,updated_by
    ) VALUES ($1,$2,$3,$4,$5,$6,'editorial@publisher.test','publisher.test',
      'same_registrable_domain','email-syntax.v1',95,false,'candidate',
      'editorial',95,'seed','seed')`,
      [
        contactCandidateId,
        organizationId,
        workspaceId,
        websiteProjectId,
        prospectId,
        recommendationContextVersionId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_contact_evidence (
      id,organization_id,workspace_id,website_project_id,candidate_id,
      source_url,observed_at,extraction_method,evidence_snippet,parser_version,
      content_sha256,confidence,expires_at,created_by
    ) VALUES ($1,$2,$3,$4,$5,'https://www.publisher.test/contact',now(),
      'mailto','editorial@publisher.test','contact-parser.v1',
      repeat('a',64),95,now()+interval '30 days','seed')`,
      [
        contactEvidenceId,
        organizationId,
        workspaceId,
        websiteProjectId,
        contactCandidateId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_contact_evidence_snapshots (
      id,organization_id,workspace_id,website_project_id,recommendation_id,
      prospect_id,recommendation_context_version_id,contact_candidate_id,
      contact_evidence_id,source_url,email_sha256,email_reference,
      inferred_purpose,contact_confidence,purpose_confidence,
      evidence_confidence,collected_at,rules_version,created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,
      'https://www.publisher.test/contact',repeat('a',64),$10,
      'editorial',95,95,95,now(),'contact-publication.v1','seed')`,
      [
        id(22),
        organizationId,
        workspaceId,
        websiteProjectId,
        recommendationId,
        prospectId,
        recommendationContextVersionId,
        contactCandidateId,
        contactEvidenceId,
        `contact-evidence:${contactEvidenceId}`,
      ],
    );
    await client.query(
      `UPDATE backlink_recommendation_inventory
          SET publication_status='PUBLISHED',
              fit_decision='eligible',
              fit_score_model_version='recommendation-commercial-fit.v4',
              contact_decision='eligible',
              contact_reason_code='PUBLIC_EMAIL_FOUND',
              verified_public_email_count=1,
              contact_evidence_snapshot_id=$2,
              default_contact_candidate_id=$3,
              default_contact_source_url='https://www.publisher.test/contact',
              default_contact_email_sha256=repeat('a',64),
              default_contact_email_reference=$4,
              contact_collected_at=now(),
              contact_rules_version='contact-publication.v1',
              updated_at=now()
        WHERE id=$1`,
      [
        inventoryId,
        id(22),
        contactCandidateId,
        `contact-evidence:${contactEvidenceId}`,
      ],
    );
    const input = {
      context,
      recommendationId,
      expectedVersion: 1,
      contactCandidateId,
      idempotencyKey: "accept-rec-1",
      requestId: "request-1",
    };
    const first = await commands.createFromRecommendation(input);
    expect(first).toMatchObject({
      recommendationId,
      websiteProjectId,
      targetSiteKey: "publisher.test",
      targetHostAscii: "www.publisher.test",
      joinSequence: 1,
      contactCandidateId,
      contactReviewRequired: false,
      businessStage: "JOINED",
      version: 1,
      replayed: false,
    });
    expect(await commands.createFromRecommendation(input)).toEqual({
      ...first,
      replayed: true,
    });

    await seedReadyRecommendation({
      prospectId: id(16),
      recommendationId: id(17),
      inventoryId: id(18),
      contactCandidateId: id(19),
      contactEvidenceId: id(20),
      contactSnapshotId: id(23),
      recommendationContextVersionId: id(21),
      hostname: "review.test",
      registrableDomain: "review.test",
      email: "press@agency.test",
      domainRelation: "external_domain",
      confidence: 90,
      purpose: "partnerships",
      purposeConfidence: 90,
    });
    const second = await commands.createFromRecommendation({
      context,
      recommendationId: id(17),
      contactCandidateId: id(19),
      expectedVersion: 1,
      idempotencyKey: "accept-rec-review",
      requestId: "request-review",
    });
    expect(second).toMatchObject({
      recommendationId: id(17),
      contactCandidateId: id(19),
      contactReviewRequired: false,
      joinSequence: 2,
      replayed: false,
    });

    await seedReadyRecommendation({
      prospectId: id(10),
      recommendationId: id(11),
      inventoryId: id(12),
      contactCandidateId: id(13),
      contactEvidenceId: id(14),
      contactSnapshotId: id(24),
      recommendationContextVersionId: id(15),
      hostname: "news.publisher.test",
      registrableDomain: "publisher.test",
      email: "news@publisher.test",
      domainRelation: "same_registrable_domain",
      confidence: 90,
      purpose: "editorial",
      purposeConfidence: 90,
    });
    await expect(
      commands.createFromRecommendation({
        context,
        recommendationId: id(11),
        contactCandidateId: id(13),
        expectedVersion: 1,
        idempotencyKey: "accept-rec-duplicate",
        requestId: "request-duplicate",
      }),
    ).rejects.toMatchObject({ code: "BACKLINK_CONFLICT" });

    expect(
      (
        await client.query(
          `SELECT
      (SELECT count(*)::int FROM backlink_opportunities) opportunities,
      (SELECT count(*)::int FROM backlink_opportunity_cycles) cycles,
      (SELECT count(*)::int FROM backlink_contacts) contacts,
      (SELECT count(*)::int FROM backlink_lifecycle_events) lifecycle,
      (SELECT count(*)::int FROM backlink_audit_events) audit,
      (SELECT count(*)::int FROM backlink_idempotency_records) idempotency,
      (SELECT status FROM backlink_contact_candidates WHERE id=$4)
        initial_contact_status,
      (SELECT status FROM backlink_contact_candidates WHERE id=$5)
        second_contact_status,
      (SELECT status FROM backlink_recommendation_inventory WHERE id=$1)
        initial_status,
      (SELECT status FROM backlink_recommendation_inventory WHERE id=$2)
        second_status,
      (SELECT status FROM backlink_recommendation_inventory WHERE id=$3)
        duplicate_status`,
          [inventoryId, id(18), id(12), contactCandidateId, id(19)],
        )
      ).rows[0],
    ).toEqual({
      opportunities: 2,
      cycles: 2,
      contacts: 2,
      lifecycle: 2,
      audit: 2,
      idempotency: 2,
      initial_contact_status: "promoted",
      second_contact_status: "promoted",
      initial_status: "accepted",
      second_status: "accepted",
      duplicate_status: "shown",
    });
  });
});
