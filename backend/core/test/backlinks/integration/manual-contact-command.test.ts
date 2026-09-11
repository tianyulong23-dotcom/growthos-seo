import { createRequire } from "node:module";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createContactCommands } from "../../../src/modules/backlinks/application/commands/contacts.command.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../../src/modules/backlinks/domain/context/index.js";
import { backlinkErrorCodes } from "../../../src/modules/backlinks/domain/errors/backlink-error.js";
import type { ResolvedProjectContext } from "../../../src/modules/backlinks/ports/project-context.port.js";
import { installBacklinksManifestAfterFoundation } from "./harness/deployment-manifest.js";
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
const id = (value: number) =>
  `01900000-0000-7000-8000-${String(value).padStart(12, "0")}`;
const organizationId = id(1);
const workspaceA = id(2);
const workspaceB = id(3);
const projectA = id(4);
const projectB = id(5);
const recommendationContextVersionId = id(6);
const prospectId = id(7);
const recommendationId = id(8);
const inventoryId = id(9);
const opportunityId = id(10);

function context(
  workspaceId: string,
  websiteProjectId: string,
): ResolvedProjectContext {
  return {
    actor: createActorContext({
      userId: "local-product-user",
      sessionId: "local-product-session",
      roles: ["member"],
    }),
    tenant: createTenantContext({ organizationId, workspaceId }),
    project: createProjectContext({
      websiteProjectId,
      canonicalDomain: "elephtv.com",
      locale: "en-US",
      countryCode: "US",
      profileVersionId: "profile-v1",
      promotionTargetVersionId: "promotion-v1",
    }),
  };
}

describe("LP-FINAL Opportunity manual Contact command", () => {
  let harness: BacklinksPostgresHarness;
  let client: Client;

  beforeAll(async () => {
    harness = await startBacklinksPostgresHarness();
    await harness.migrate();
    client = new PgClient({ connectionString: harness.connectionString });
    await client.connect();
    await installBacklinksManifestAfterFoundation(client, "0092");

    await client.query("SET search_path = backlinks, pg_catalog");
    await client.query(
      `INSERT INTO backlink_prospects (
        id,organization_id,workspace_id,website_project_id,
        recommendation_context_version_id,hostname_ascii,registrable_domain,
        normalization_version,created_by,updated_by
      ) VALUES ($1,$2,$3,$4,$5,'target.test','target.test','tldts-v1','seed','seed')`,
      [
        prospectId,
        organizationId,
        workspaceA,
        projectA,
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
        workspaceA,
        projectA,
        prospectId,
        recommendationContextVersionId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_recommendation_inventory (
        id,organization_id,workspace_id,website_project_id,recommendation_id,
        prospect_id,recommendation_context_version_id,status,created_by,updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'accepted','seed','seed')`,
      [
        inventoryId,
        organizationId,
        workspaceA,
        projectA,
        recommendationId,
        prospectId,
        recommendationContextVersionId,
      ],
    );
    await client.query(
      `INSERT INTO backlink_opportunities (
        id,organization_id,workspace_id,website_project_id,recommendation_id,
        prospect_id,recommendation_context_version_id,target_site_key,
        target_host_ascii,target_identity_rule_version,join_sequence,
        created_by,updated_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,'target.test','target.test',
        'tldts-v1',1,'seed','seed')`,
      [
        opportunityId,
        organizationId,
        workspaceA,
        projectA,
        recommendationId,
        prospectId,
        recommendationContextVersionId,
      ],
    );
  }, 180_000);

  afterAll(async () => {
    await client?.end();
    await harness?.stop();
  });

  async function inScope<T>(
    resolved: ResolvedProjectContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    await client.query("BEGIN");
    try {
      await client.query("SET LOCAL ROLE growthos_backlinks_writer");
      await client.query("SET LOCAL search_path = backlinks, pg_catalog");
      await client.query(
        `SELECT set_config('app.current_organization_id',$1,true),
          set_config('app.current_workspace_id',$2,true),
          set_config('app.current_website_project_id',$3,true)`,
        [
          resolved.tenant.organizationId,
          resolved.tenant.workspaceId,
          resolved.project.websiteProjectId,
        ],
      );
      const result = await operation();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  it("recovers a manual candidate without duplicate facts and enforces RLS", async () => {
    const projectContext = context(workspaceA, projectA);
    const commands = createContactCommands(client);
    const baseInput = {
      context: projectContext,
      requestId: "request-manual-contact-1",
      opportunityId,
      normalizedEmail: "editor@target.test",
      contactRole: "editorial" as const,
      reason: "Confirmed by the local product user.",
      idempotencyKey: "manual-contact-1",
    };

    const first = await inScope(projectContext, () =>
      commands.createManualCandidate(baseInput),
    );
    expect(first).toMatchObject({
      prospectId,
      normalizedEmail: "editor@target.test",
      contactRole: "editorial",
      status: "candidate",
      version: 1,
      replayed: false,
    });
    await expect(
      inScope(projectContext, () => commands.createManualCandidate(baseInput)),
    ).resolves.toEqual({ ...first, replayed: true });

    const recovered = await inScope(projectContext, () =>
      commands.createManualCandidate({
        ...baseInput,
        requestId: "request-manual-contact-2",
        idempotencyKey: "manual-contact-2",
      }),
    );
    expect(recovered).toEqual({ ...first, replayed: true });

    const counts = await inScope(projectContext, () =>
      client.query(
        `SELECT
          (SELECT count(*)::int FROM backlink_contact_candidates) candidates,
          (SELECT count(*)::int FROM backlink_contact_evidence) evidence,
          (SELECT count(*)::int FROM backlink_lifecycle_events
            WHERE event_type='contact_candidate.created') lifecycle,
          (SELECT count(*)::int FROM backlink_audit_events
            WHERE action='contact_candidate.created') audit,
          (SELECT count(*)::int FROM backlink_idempotency_records
            WHERE command_type='contact.candidate.create') idempotency`,
      ),
    );
    expect(counts.rows[0]).toEqual({
      candidates: 1,
      evidence: 1,
      lifecycle: 1,
      audit: 1,
      idempotency: 2,
    });

    const confirmed = await inScope(projectContext, () =>
      commands.confirm({
        context: projectContext,
        requestId: "request-confirm-contact-1",
        candidateId: first.candidateId,
        expectedVersion: 1,
        contactRole: "editorial",
        reason: "Confirmed for this Opportunity.",
      }),
    );
    expect(confirmed).toMatchObject({
      candidateId: first.candidateId,
      candidateStatus: "promoted",
      candidateVersion: 2,
      contactStatus: "active",
      contactVersion: 1,
    });

    const selection = await inScope(projectContext, () =>
      commands.listOpportunityContacts(projectContext, opportunityId),
    );
    expect(selection).toMatchObject({
      state: "AUTO_SELECTED",
      autoSelectedContactId: confirmed.contactId,
      items: [
        {
          id: confirmed.contactId,
          opportunityId,
          confirmedAt: expect.stringMatching(/Z$/u),
          status: "active",
          guessed: false,
          version: 1,
        },
      ],
    });

    const otherContext = context(workspaceB, projectB);
    await expect(
      inScope(otherContext, () =>
        commands.listOpportunityContacts(otherContext, opportunityId),
      ),
    ).rejects.toMatchObject({ code: backlinkErrorCodes.notFound });
    const isolated = await inScope(otherContext, () =>
      client.query(
        `SELECT
          (SELECT count(*)::int FROM backlink_contact_candidates) candidates,
          (SELECT count(*)::int FROM backlink_contacts) contacts`,
      ),
    );
    expect(isolated.rows[0]).toEqual({ candidates: 0, contacts: 0 });
  });
});
