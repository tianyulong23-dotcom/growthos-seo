import { Pool } from "pg";
import { z } from "zod";

import {
  prepareCurrentCommercialCandidateEnrichment,
} from "../src/modules/backlinks/application/services/current-commercial-candidate-enrichment.service.js";
import {
  withBacklinkTenantTransaction,
} from "../src/modules/backlinks/db/tenant-transaction.js";
import {
  createProjectInputPersistenceTransactionRepository,
} from "../src/modules/backlinks/db/repositories/project-input-persistence.repository.js";
import {
  CORRECTED_QUALIFICATION_CONTRACT_VERSION,
} from "../src/modules/backlinks/ports/recommendation-contract.port.js";

const commandSchema = z.object({
  organizationId: z.uuid(),
  workspaceId: z.uuid(),
  websiteProjectId: z.uuid(),
  projectContextVersionId: z.uuid(),
  visiblePoolGeneration: z.number().int().positive(),
  generationInputFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  maximumCandidates: z.number().int().min(1).max(25).default(25),
}).strict();

async function readStandardInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 100_000) {
      throw new Error("COMMERCIAL_ENRICHMENT_DRY_RUN_INPUT_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  if (value.length === 0) {
    throw new Error("COMMERCIAL_ENRICHMENT_DRY_RUN_STDIN_REQUIRED");
  }
  return JSON.parse(value) as unknown;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL_REQUIRED");
  }
  const command = commandSchema.parse(await readStandardInput());
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const result = await withBacklinkTenantTransaction(
      pool,
      command,
      async (client) => {
        const context = await client.query(
          `SELECT snapshot_version AS "snapshotVersion",
                  profile_version_id AS "profileVersionId",
                  promotion_target_version_id AS "promotionTargetVersionId",
                  country_code AS "countryCode"
             FROM backlink_project_context_snapshots
            WHERE organization_id=$1 AND workspace_id=$2
              AND website_project_id=$3 AND id=$4`,
          [
            command.organizationId,
            command.workspaceId,
            command.websiteProjectId,
            command.projectContextVersionId,
          ],
        );
        const contextRow = context.rows[0];
        if (contextRow === undefined) {
          throw new Error("COMMERCIAL_ENRICHMENT_CONTEXT_NOT_FOUND");
        }
        const binding = await createProjectInputPersistenceTransactionRepository(
          client,
        ).readGenerationInputBindingForContext({
          organizationId: command.organizationId,
          workspaceId: command.workspaceId,
          websiteProjectId: command.websiteProjectId,
          projectContextVersion: Number(contextRow.snapshotVersion),
          siteProfileVersionId: String(contextRow.profileVersionId),
          promotionTargetVersionId: String(
            contextRow.promotionTargetVersionId,
          ),
          qualificationContractVersion:
            CORRECTED_QUALIFICATION_CONTRACT_VERSION,
          market: String(contextRow.countryCode),
        });
        if (binding === null) {
          throw new Error("COMMERCIAL_ENRICHMENT_GENERATION_PIN_NOT_FOUND");
        }
        if (
          command.generationInputFingerprint !== undefined
          && command.generationInputFingerprint
            !== binding.immutableFingerprint
        ) {
          throw new Error(
            "COMMERCIAL_ENRICHMENT_GENERATION_FINGERPRINT_MISMATCH",
          );
        }
        return Object.freeze({
          generationInputFingerprint: binding.immutableFingerprint,
          enrichment: await prepareCurrentCommercialCandidateEnrichment(
            client,
            {
              ...command,
              generationInputFingerprint: binding.immutableFingerprint,
              actorId: "local-product-enrichment-dry-run",
              now: new Date(),
              apply: false,
            },
          ),
        });
      },
    );
    const decisionsByState = Object.fromEntries(
      [
        "enrichment_eligible",
        "excluded",
        "insufficient_data",
        "not_selected",
      ].map((decision) => [
        decision,
        result.enrichment.decisions.filter(
          (item) => item.decision === decision,
        ).length,
      ]),
    );
    console.log(JSON.stringify({
      scope: {
        organizationId: command.organizationId,
        workspaceId: command.workspaceId,
        websiteProjectId: command.websiteProjectId,
      },
      projectContextVersionId: command.projectContextVersionId,
      visiblePoolGeneration: command.visiblePoolGeneration,
      generationInputFingerprint: result.generationInputFingerprint,
      maximumCandidates: command.maximumCandidates,
      preparedCount: result.enrichment.preparedCount,
      selectedCount: result.enrichment.candidates.length,
      decisionsByState,
      decisions: result.enrichment.decisions,
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "COMMERCIAL_ENRICHMENT_DRY_RUN_FAILED",
  );
  process.exitCode = 1;
});
