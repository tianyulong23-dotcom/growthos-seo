import { z } from "zod";

import {
  createAiDraftClient,
} from "../adapters/ai/ai-draft-client.js";
import {
  createAiSdkCommercialDiscoveryBlueprintAdapter,
} from "../adapters/ai/ai-sdk-commercial-discovery-blueprint.adapter.js";
import {
  createAiSdkDraftTransport,
} from "../adapters/ai/ai-sdk-draft.transport.js";
import {
  LocalProductSecretStoreClient,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import {
  SecretStoreClientAdapter,
} from "../adapters/security/secret-store-client.js";
import type {
  DraftBudgetGate,
} from "../application/commands/draft.command.js";
import {
  evaluateKillSwitch,
  type KillSwitchDecision,
} from "../domain/settings/kill-switch.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantContext,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../db/tenant-transaction.js";
import {
  AiDraftError,
  type AiDraftPort,
} from "../ports/ai-draft.port.js";
import type {
  AiCommercialDiscoveryBlueprintPort,
} from "../ports/ai-commercial-discovery-blueprint.port.js";
import {
  secretKinds,
} from "../ports/secret-store.port.js";
import {
  localProductAiProviderBaseUrlSchema,
  localProductAiProviderRefs,
} from "./local-product-ai-bootstrap.js";

export const aiProviderKillSwitchCapability = "AI_PROVIDER";

const positiveNumber = z.coerce.number().finite().positive();
const positiveInteger = z.coerce.number().int().positive();
const aiCredentialReferenceSchema = z.string().trim().min(1)
  .transform((value, context) => {
    try {
      parseLocalProductSecretReference(
        value,
        secretKinds.aiProviderCredential,
      );
      return value;
    } catch {
      context.addIssue({
        code: "custom",
        message: "AI Provider Secret Reference is invalid.",
      });
      return z.NEVER;
    }
  });
const configurationSchema = z.object({
  providerRef: z.enum(localProductAiProviderRefs),
  baseUrl: localProductAiProviderBaseUrlSchema,
  modelId: z.string().trim().min(1),
  modelVersion: z.string().trim().min(1),
  credentialSecretReference: aiCredentialReferenceSchema,
  maxCalls: positiveInteger.max(10_000),
  timeoutMs: positiveInteger.max(45_000),
  maxInputTokens: positiveInteger,
  maxOutputTokens: positiveInteger,
  absoluteBudgetUsd: positiveNumber,
  inputCostUsdPerMillionTokens: positiveNumber,
  outputCostUsdPerMillionTokens: positiveNumber,
}).strict();

export type LocalProductAiConfiguration = Readonly<
  z.output<typeof configurationSchema>
>;

type AiRunScope = BacklinkTenantContext & Readonly<{ runId: string }>;

export type LocalProductAiRuntime = Readonly<{
  ai: AiDraftPort;
  blueprint: AiCommercialDiscoveryBlueprintPort;
  budgetGate: DraftBudgetGate;
  reserve(input: AiRunScope): Promise<void>;
  release(input: AiRunScope): Promise<void>;
}>;

const configurationFields = Object.freeze({
  providerRef: "AI_PROVIDER_REF",
  baseUrl: "AI_PROVIDER_BASE_URL",
  modelId: "AI_MODEL_ID",
  modelVersion: "AI_MODEL_VERSION",
  credentialSecretReference: "AI_PROVIDER_CREDENTIAL_SECRET_REF",
  maxCalls: "AI_PROVIDER_MAX_CALLS",
  timeoutMs: "AI_PROVIDER_TIMEOUT_MS",
  maxInputTokens: "AI_PROVIDER_MAX_INPUT_TOKENS",
  maxOutputTokens: "AI_PROVIDER_MAX_OUTPUT_TOKENS",
  absoluteBudgetUsd: "AI_PROVIDER_ABSOLUTE_BUDGET_USD",
  inputCostUsdPerMillionTokens:
    "AI_PROVIDER_INPUT_COST_USD_PER_MILLION_TOKENS",
  outputCostUsdPerMillionTokens:
    "AI_PROVIDER_OUTPUT_COST_USD_PER_MILLION_TOKENS",
} as const);

export function readLocalProductAiConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): LocalProductAiConfiguration {
  const parsed = configurationSchema.safeParse(Object.fromEntries(
    Object.entries(configurationFields).map(([field, environmentName]) => [
      field,
      environment[environmentName],
    ]),
  ));
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "unknown");
    const environmentName = configurationFields[
      field as keyof typeof configurationFields
    ] ?? field;
    throw new Error(`BACKLINKS_AI_CONFIGURATION_INVALID:${environmentName}`);
  }
  return Object.freeze(parsed.data);
}

const budgetReservationUsd = (
  configuration: LocalProductAiConfiguration,
): number => Number((2 * (
  configuration.maxInputTokens
    * configuration.inputCostUsdPerMillionTokens
  + configuration.maxOutputTokens
    * configuration.outputCostUsdPerMillionTokens
)) .toFixed(6)) / 1_000_000;

const budgetError = (message: string) => new AiDraftError({
  code: "BUDGET_EXCEEDED",
  message,
  retryable: false,
});

const providerBlockedError = () => new AiDraftError({
  code: "UNAVAILABLE",
  message: "AI Draft provider is blocked by the Kill Switch.",
  retryable: false,
});

const asNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const scopeValues = (scope: BacklinkTenantContext) => [
  scope.organizationId,
  scope.workspaceId,
  scope.websiteProjectId,
] as const;

async function loadKillSwitchDecisions(
  pool: BacklinkTenantPool,
  scope: BacklinkTenantContext,
  providerRef: string,
): Promise<readonly KillSwitchDecision[]> {
  return withBacklinkTenantTransaction(pool, scope, async (client) => {
    const result = await client.query(
      `SELECT DISTINCT ON (layer,capability,provider)
         layer,capability,provider,blocked,version
       FROM backlinks.backlink_kill_switch_versions
       WHERE organization_id=$1
         AND workspace_id=$2
         AND website_project_id=$3
         AND capability=$4
         AND (provider IS NULL OR provider=$5)
       ORDER BY layer,capability,provider,version DESC`,
      [
        ...scopeValues(scope),
        aiProviderKillSwitchCapability,
        providerRef,
      ],
    );
    return result.rows.map((row) => ({
      layer: row.layer as "project" | "provider",
      scopeId: row.layer === "provider"
        ? String(row.provider)
        : scope.websiteProjectId,
      capability: String(row.capability),
      provider: row.provider === null ? null : String(row.provider),
      blocked: row.blocked === true,
      version: Number(row.version),
    }));
  });
}

async function assertProviderAllowed(
  pool: BacklinkTenantPool,
  scope: BacklinkTenantContext,
  providerRef: string,
): Promise<void> {
  let decisions: readonly KillSwitchDecision[];
  try {
    decisions = await loadKillSwitchDecisions(pool, scope, providerRef);
  } catch {
    throw providerBlockedError();
  }
  const evaluation = evaluateKillSwitch({
    capability: aiProviderKillSwitchCapability,
    provider: providerRef,
    authorityAvailable: true,
    decisions,
  });
  if (evaluation.effectiveBlocked) throw providerBlockedError();
}

async function lockBudget(
  client: BacklinkTransactionClient,
  scope: BacklinkTenantContext,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       $1||':'||$2||':'||$3||':AI_PROVIDER_BUDGET',0
     ))`,
    scopeValues(scope),
  );
}

async function readCommittedAndReservedUsage(
  client: BacklinkTransactionClient,
  scope: BacklinkTenantContext,
  excludedRunId: string | null,
): Promise<Readonly<{ usedUsd: number; usedCalls: number }>> {
  const result = await client.query(
    `WITH model_usage AS (
       SELECT COALESCE(sum(
         CASE
           WHEN status='SUCCEEDED' THEN COALESCE(estimated_cost_usd,0)
           WHEN status IN ('QUEUED','RUNNING') THEN COALESCE(
             NULLIF(quality_result->>'budgetReservationUsd','')::numeric,
             0
           )
           ELSE 0
         END
       ),0) AS used_usd,
       count(*) FILTER (
         WHERE status IN ('QUEUED','RUNNING','SUCCEEDED')
       ) AS used_calls
       FROM backlinks.backlink_model_runs
       WHERE organization_id=$1
         AND workspace_id=$2
         AND website_project_id=$3
         AND quality_result->>'generationMode'='MODEL'
         AND ($4::uuid IS NULL OR id<>$4::uuid)
     ),
     blueprint_usage AS (
       SELECT COALESCE(sum(COALESCE(
                NULLIF(blueprint#>>'{generation,estimatedCostUsd}','')::numeric,
                0
              )),0) AS used_usd,
              count(*) AS used_calls
         FROM backlinks.backlink_commercial_discovery_blueprints
        WHERE organization_id=$1
          AND workspace_id=$2
          AND website_project_id=$3
          AND generator='AI'
     )
     SELECT (model_usage.used_usd+blueprint_usage.used_usd)::text AS "usedUsd",
            (model_usage.used_calls+blueprint_usage.used_calls)::text
              AS "usedCalls"
       FROM model_usage CROSS JOIN blueprint_usage`,
    [...scopeValues(scope), excludedRunId],
  );
  return {
    usedUsd: asNumber(result.rows[0]?.usedUsd),
    usedCalls: asNumber(result.rows[0]?.usedCalls),
  };
}

function assertProviderCapacity(
  usage: Readonly<{ usedUsd: number; usedCalls: number }>,
  reservationUsd: number,
  configuration: LocalProductAiConfiguration,
): void {
  if (usage.usedCalls >= configuration.maxCalls) {
    throw budgetError("AI Draft call limit is exhausted.");
  }
  if (
    usage.usedUsd + reservationUsd
      > configuration.absoluteBudgetUsd + 0.0000005
  ) {
    throw budgetError("AI Draft absolute budget is exhausted.");
  }
}

export function createLocalProductAiRuntime(options: Readonly<{
  pool: BacklinkTenantPool;
  secretStoreRoot: string;
  configuration: LocalProductAiConfiguration;
}>): LocalProductAiRuntime {
  const configuration = configurationSchema.parse(options.configuration);
  const reservationUsd = budgetReservationUsd(configuration);
  if (
    reservationUsd <= 0
    || reservationUsd > configuration.absoluteBudgetUsd
  ) {
    throw new Error("BACKLINKS_AI_BUDGET_CONFIGURATION_INVALID");
  }

  const secretStore = new SecretStoreClientAdapter({
    config: {
      enabled: true,
      provider: "platform-secret-store",
    },
    client: new LocalProductSecretStoreClient({
      rootDirectory: options.secretStoreRoot,
    }),
  });
  const credentialReference = parseLocalProductSecretReference(
    configuration.credentialSecretReference,
    secretKinds.aiProviderCredential,
  );
  const resolveApprovedSecret = async (input: Readonly<{
    organizationId: string;
    secretRef: string;
  }>): Promise<string> => {
    if (input.secretRef !== configuration.credentialSecretReference) {
      throw new Error("AI Provider Secret Reference is not approved.");
    }
    return secretStore.resolve({
      reference: credentialReference,
      context: {
        organizationId: "local-product",
        subjectProvider: "ai",
      },
    });
  };
  const assertCapacityForScope = async (
    scope: BacklinkTenantContext,
  ): Promise<void> => {
    await assertProviderAllowed(
      options.pool,
      scope,
      configuration.providerRef,
    );
    await withBacklinkTenantTransaction(
      options.pool,
      scope,
      async (client) => {
        await lockBudget(client, scope);
        assertProviderCapacity(
          await readCommittedAndReservedUsage(client, scope, null),
          reservationUsd,
          configuration,
        );
      },
    );
  };

  const budgetGate: DraftBudgetGate = Object.freeze({
    async assertAvailable(scope) {
      await assertCapacityForScope(scope);
    },
  });

  const transport = createAiSdkDraftTransport({
    providerBaseUrl: configuration.baseUrl,
    inputCostUsdPerMillionTokens:
      configuration.inputCostUsdPerMillionTokens,
    outputCostUsdPerMillionTokens:
      configuration.outputCostUsdPerMillionTokens,
    resolveSecret: resolveApprovedSecret,
    beforeProviderCall: async (scope) => {
      await assertProviderAllowed(
        options.pool,
        scope,
        configuration.providerRef,
      );
    },
  });
  const ai = createAiDraftClient({
    config: {
      enabled: true,
      secretRef: configuration.credentialSecretReference,
      providerRef: configuration.providerRef,
      modelId: configuration.modelId,
      modelVersion: configuration.modelVersion,
      timeoutMs: configuration.timeoutMs,
      maxInputTokens: configuration.maxInputTokens,
      maxOutputTokens: configuration.maxOutputTokens,
      absoluteBudgetUsd: reservationUsd,
    },
    transport,
  });
  const blueprint = createAiSdkCommercialDiscoveryBlueprintAdapter({
    providerRef: configuration.providerRef,
    providerBaseUrl: configuration.baseUrl,
    modelId: configuration.modelId,
    modelVersion: configuration.modelVersion,
    credentialSecretReference: configuration.credentialSecretReference,
    timeoutMs: configuration.timeoutMs,
    maxOutputTokens: configuration.maxOutputTokens,
    inputCostUsdPerMillionTokens:
      configuration.inputCostUsdPerMillionTokens,
    outputCostUsdPerMillionTokens:
      configuration.outputCostUsdPerMillionTokens,
    resolveSecret: resolveApprovedSecret,
    beforeProviderCall: async (scope) => {
      await assertCapacityForScope(scope);
    },
  });

  return Object.freeze({
    ai,
    blueprint,
    budgetGate,
    async reserve(input) {
      await assertProviderAllowed(
        options.pool,
        input,
        configuration.providerRef,
      );
      await withBacklinkTenantTransaction(
        options.pool,
        input,
        async (client) => {
          await lockBudget(client, input);
          const target = await client.query(
            `SELECT status,quality_result AS "qualityResult"
             FROM backlinks.backlink_model_runs
             WHERE organization_id=$1
               AND workspace_id=$2
               AND website_project_id=$3
               AND id=$4
             FOR UPDATE`,
            [...scopeValues(input), input.runId],
          );
          const row = target.rows[0];
          if (row === undefined) {
            throw new AiDraftError({
              code: "MISCONFIGURED",
              message: "AI Draft Model Run was not found.",
              retryable: false,
            });
          }
          if (["SUCCEEDED", "FAILED", "REFUSED"].includes(String(row.status))) {
            return;
          }
          const quality = row.qualityResult as
            | Readonly<Record<string, unknown>>
            | undefined;
          if (quality?.generationMode !== "MODEL") {
            throw new AiDraftError({
              code: "POLICY_VIOLATION",
              message: "AI Draft Model Run is not authorized for MODEL mode.",
              retryable: false,
            });
          }
          if (asNumber(quality.budgetReservationUsd) > 0) return;
          assertProviderCapacity(
            await readCommittedAndReservedUsage(
              client,
              input,
              input.runId,
            ),
            reservationUsd,
            configuration,
          );
          await client.query(
            `UPDATE backlinks.backlink_model_runs
             SET quality_result=jsonb_set(
               quality_result,
               '{budgetReservationUsd}',
               to_jsonb($5::numeric),
               true
             ),
             updated_at=now()
             WHERE organization_id=$1
               AND workspace_id=$2
               AND website_project_id=$3
               AND id=$4
               AND status IN ('QUEUED','RUNNING')`,
            [...scopeValues(input), input.runId, reservationUsd],
          );
        },
      );
    },
    async release(input) {
      await withBacklinkTenantTransaction(
        options.pool,
        input,
        async (client) => {
          await lockBudget(client, input);
          await client.query(
            `UPDATE backlinks.backlink_model_runs
             SET quality_result=quality_result-'budgetReservationUsd',
                 estimated_cost_usd=NULL,
                 updated_at=now()
             WHERE organization_id=$1
               AND workspace_id=$2
               AND website_project_id=$3
               AND id=$4
               AND status<>'SUCCEEDED'`,
            [...scopeValues(input), input.runId],
          );
        },
      );
    },
  });
}
