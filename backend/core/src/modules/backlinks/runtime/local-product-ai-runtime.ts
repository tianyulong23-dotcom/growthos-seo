import { createHash } from "node:crypto";

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
  selectAiProviderFetch,
} from "../adapters/ai/ai-provider-fetch.js";
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
  createAiCapabilityBudgetRepository,
  AiCapabilityBudgetError,
  type AiCapability,
  type AiCapabilityPolicy,
} from "../db/repositories/ai-capability-budget.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantContext,
  type BacklinkTenantPool,
} from "../db/tenant-transaction.js";
import {
  evaluateKillSwitch,
  type KillSwitchDecision,
} from "../domain/settings/kill-switch.js";
import type {
  AiCommercialDiscoveryBlueprintInput,
  AiCommercialDiscoveryBlueprintPort,
} from "../ports/ai-commercial-discovery-blueprint.port.js";
import {
  AiDraftError,
  type AiDraftPort,
} from "../ports/ai-draft.port.js";
import {
  secretKinds,
} from "../ports/secret-store.port.js";
import {
  localProductAiDiscoveryModelId,
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
  proxyMode: z.enum(["direct", "inherit"]).default("direct"),
  modelId: z.string().trim().min(1),
  discoveryModelId: z.string().trim().min(1),
  modelVersion: z.string().trim().min(1),
  credentialSecretReference: aiCredentialReferenceSchema,
  timeoutMs: positiveInteger.max(45_000),
  maxInputTokens: positiveInteger,
  maxOutputTokens: positiveInteger,
  inputCostUsdPerMillionTokens: positiveNumber,
  outputCostUsdPerMillionTokens: positiveNumber,
  discoveryMaxCalls: positiveInteger.max(10_000),
  discoveryAbsoluteBudgetUsd: positiveNumber,
  discoveryWindowSeconds: positiveInteger.max(31_536_000),
  discoveryMaxConcurrency: positiveInteger.max(100),
  discoveryMaxWorkItemsPerGeneration: positiveInteger.max(100),
  outreachDraftMaxCalls: positiveInteger.max(10_000),
  outreachDraftAbsoluteBudgetUsd: positiveNumber,
  outreachDraftWindowSeconds: positiveInteger.max(31_536_000),
  outreachDraftMaxConcurrency: positiveInteger.max(100),
}).strict();

export type LocalProductAiConfiguration = Readonly<
  z.output<typeof configurationSchema>
>;

type AiRunScope = BacklinkTenantContext & Readonly<{
  runId: string;
  actorId: string;
}>;

export type LocalProductAiRuntime = Readonly<{
  blueprint: AiCommercialDiscoveryBlueprintPort;
  budgetGate: DraftBudgetGate;
  draft(input: AiRunScope): AiDraftPort;
  reserve(input: AiRunScope): Promise<"active" | "terminal">;
  settle(input: AiRunScope): Promise<void>;
  release(input: AiRunScope): Promise<void>;
}>;

const configurationFields = Object.freeze({
  providerRef: "AI_PROVIDER_REF",
  baseUrl: "AI_PROVIDER_BASE_URL",
  proxyMode: "AI_PROVIDER_PROXY_MODE",
  modelId: "AI_MODEL_ID",
  discoveryModelId: "AI_DISCOVERY_MODEL_ID",
  modelVersion: "AI_MODEL_VERSION",
  credentialSecretReference: "AI_PROVIDER_CREDENTIAL_SECRET_REF",
  timeoutMs: "AI_PROVIDER_TIMEOUT_MS",
  maxInputTokens: "AI_PROVIDER_MAX_INPUT_TOKENS",
  maxOutputTokens: "AI_PROVIDER_MAX_OUTPUT_TOKENS",
  inputCostUsdPerMillionTokens:
    "AI_PROVIDER_INPUT_COST_USD_PER_MILLION_TOKENS",
  outputCostUsdPerMillionTokens:
    "AI_PROVIDER_OUTPUT_COST_USD_PER_MILLION_TOKENS",
  discoveryMaxCalls: "AI_DISCOVERY_MAX_CALLS",
  discoveryAbsoluteBudgetUsd: "AI_DISCOVERY_ABSOLUTE_BUDGET_USD",
  discoveryWindowSeconds: "AI_DISCOVERY_WINDOW_SECONDS",
  discoveryMaxConcurrency: "AI_DISCOVERY_MAX_CONCURRENCY",
  discoveryMaxWorkItemsPerGeneration:
    "AI_DISCOVERY_MAX_WORK_ITEMS_PER_GENERATION",
  outreachDraftMaxCalls: "AI_OUTREACH_DRAFT_MAX_CALLS",
  outreachDraftAbsoluteBudgetUsd:
    "AI_OUTREACH_DRAFT_ABSOLUTE_BUDGET_USD",
  outreachDraftWindowSeconds: "AI_OUTREACH_DRAFT_WINDOW_SECONDS",
  outreachDraftMaxConcurrency: "AI_OUTREACH_DRAFT_MAX_CONCURRENCY",
} as const);

export function readLocalProductAiConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): LocalProductAiConfiguration {
  const legacyMaxCalls = environment.AI_PROVIDER_MAX_CALLS;
  const legacyBudget = environment.AI_PROVIDER_ABSOLUTE_BUDGET_USD;
  const raw = Object.fromEntries(
    Object.entries(configurationFields).map(([field, environmentName]) => [
      field,
      environment[environmentName],
    ]),
  );
  raw.discoveryModelId ??= localProductAiDiscoveryModelId;
  raw.proxyMode ??= "direct";
  raw.discoveryMaxCalls ??= legacyMaxCalls;
  raw.discoveryAbsoluteBudgetUsd ??= legacyBudget;
  raw.discoveryWindowSeconds ??= "86400";
  raw.discoveryMaxConcurrency ??= "1";
  raw.discoveryMaxWorkItemsPerGeneration ??= "1";
  raw.outreachDraftMaxCalls ??= legacyMaxCalls;
  raw.outreachDraftAbsoluteBudgetUsd ??= legacyBudget;
  raw.outreachDraftWindowSeconds ??= "86400";
  raw.outreachDraftMaxConcurrency ??= "2";

  const parsed = configurationSchema.safeParse(raw);
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "unknown");
    const environmentName = configurationFields[
      field as keyof typeof configurationFields
    ] ?? field;
    throw new Error(`BACKLINKS_AI_CONFIGURATION_INVALID:${environmentName}`);
  }
  return Object.freeze(parsed.data);
}

const maximumReservationUsd = (
  configuration: LocalProductAiConfiguration,
  providerCalls: number,
): number => Number((providerCalls * (
  configuration.maxInputTokens
    * configuration.inputCostUsdPerMillionTokens
  + configuration.maxOutputTokens
    * configuration.outputCostUsdPerMillionTokens
) / 1_000_000).toFixed(6));

const providerBlockedError = () => new AiDraftError({
  code: "UNAVAILABLE",
  message: "AI Provider is blocked by the Kill Switch.",
  retryable: false,
});

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

const mapBudgetError = (error: unknown): never => {
  if (!(error instanceof AiCapabilityBudgetError)) throw error;
  if (error.reason === "BUDGET_EXCEEDED") {
    throw new AiDraftError({
      code: "BUDGET_EXCEEDED",
      message: error.message,
      retryable: false,
    });
  }
  if (error.reason === "CONCURRENCY_EXHAUSTED") {
    throw new AiDraftError({
      code: "UNAVAILABLE",
      message: error.message,
      retryable: true,
    });
  }
  throw new AiDraftError({
    code: error.reason === "RESERVATION_MISSING"
      ? "MISCONFIGURED"
      : "POLICY_VIOLATION",
    message: error.message,
    retryable: false,
  });
};

const operationKeyForBlueprint = (
  input: AiCommercialDiscoveryBlueprintInput,
): string => `commercial-blueprint:${createHash("sha256").update(
  JSON.stringify({
    organizationId: input.organizationId,
    workspaceId: input.workspaceId,
    websiteProjectId: input.websiteProjectId,
    projectContextVersionId: input.context.projectContextVersionId,
    projectSettingsVersionId: input.context.projectSettingsVersionId,
  }),
).digest("hex")}`;

const budgetInput = (
  scope: BacklinkTenantContext,
  capability: AiCapability,
  operationKey: string,
  actorId: string,
  policy: AiCapabilityPolicy,
) => ({
  ...scope,
  capability,
  operationKey,
  actorId,
  workItemCount: 1,
  policy,
});

export function createLocalProductAiRuntime(options: Readonly<{
  pool: BacklinkTenantPool;
  secretStoreRoot: string;
  configuration: LocalProductAiConfiguration;
}>): LocalProductAiRuntime {
  const configuration = configurationSchema.parse(options.configuration);
  const discoveryReservationUsd = maximumReservationUsd(configuration, 1);
  const draftReservationUsd = maximumReservationUsd(configuration, 2);
  const providerFetch = selectAiProviderFetch(configuration.proxyMode);
  if (
    discoveryReservationUsd <= 0
    || discoveryReservationUsd > configuration.discoveryAbsoluteBudgetUsd
    || configuration.discoveryMaxCalls < 1
    || draftReservationUsd <= 0
    || draftReservationUsd > configuration.outreachDraftAbsoluteBudgetUsd
    || configuration.outreachDraftMaxCalls < 2
  ) {
    throw new Error("BACKLINKS_AI_BUDGET_CONFIGURATION_INVALID");
  }

  const discoveryPolicy: AiCapabilityPolicy = Object.freeze({
    maxCalls: configuration.discoveryMaxCalls,
    absoluteBudgetUsd: configuration.discoveryAbsoluteBudgetUsd,
    windowSeconds: configuration.discoveryWindowSeconds,
    maxConcurrency: configuration.discoveryMaxConcurrency,
    maxWorkItemsPerGeneration:
      configuration.discoveryMaxWorkItemsPerGeneration,
    maxProviderCallsPerGeneration: 1,
    reservationUsd: discoveryReservationUsd,
    providerRef: configuration.providerRef,
    modelId: configuration.discoveryModelId,
  });
  const draftPolicy: AiCapabilityPolicy = Object.freeze({
    maxCalls: configuration.outreachDraftMaxCalls,
    absoluteBudgetUsd: configuration.outreachDraftAbsoluteBudgetUsd,
    windowSeconds: configuration.outreachDraftWindowSeconds,
    maxConcurrency: configuration.outreachDraftMaxConcurrency,
    maxWorkItemsPerGeneration: 1,
    maxProviderCallsPerGeneration: 2,
    reservationUsd: draftReservationUsd,
    providerRef: configuration.providerRef,
    modelId: configuration.modelId,
  });

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

  const reserveCapability = async (
    scope: BacklinkTenantContext,
    capability: AiCapability,
    operationKey: string,
    actorId: string,
    policy: AiCapabilityPolicy,
  ) => {
    await assertProviderAllowed(options.pool, scope, configuration.providerRef);
    try {
      return await withBacklinkTenantTransaction(
        options.pool,
        scope,
        (client) => createAiCapabilityBudgetRepository(client).reserve(
          budgetInput(scope, capability, operationKey, actorId, policy),
        ),
      );
    } catch (error) {
      return mapBudgetError(error);
    }
  };
  const markProviderCallStarted = async (
    scope: BacklinkTenantContext,
    capability: AiCapability,
    operationKey: string,
    actorId: string,
  ): Promise<void> => {
    try {
      await withBacklinkTenantTransaction(
        options.pool,
        scope,
        (client) => createAiCapabilityBudgetRepository(client)
          .markProviderCallStarted({
            ...scope,
            capability,
            operationKey,
            actorId,
          }),
      );
    } catch (error) {
      mapBudgetError(error);
    }
  };
  const settleCapability = async (
    scope: BacklinkTenantContext,
    capability: AiCapability,
    operationKey: string,
    actorId: string,
    actualCostUsd: number,
  ): Promise<void> => {
    try {
      await withBacklinkTenantTransaction(
        options.pool,
        scope,
        (client) => createAiCapabilityBudgetRepository(client).settle({
          ...scope,
          capability,
          operationKey,
          actorId,
          actualCostUsd,
        }),
      );
    } catch (error) {
      mapBudgetError(error);
    }
  };
  const finalizeCapabilityFailure = async (
    scope: BacklinkTenantContext,
    capability: AiCapability,
    operationKey: string,
    actorId: string,
  ): Promise<void> => {
    try {
      await withBacklinkTenantTransaction(
        options.pool,
        scope,
        (client) => createAiCapabilityBudgetRepository(client).finalizeFailure({
          ...scope,
          capability,
          operationKey,
          actorId,
        }),
      );
    } catch (error) {
      mapBudgetError(error);
    }
  };

  const blueprint: AiCommercialDiscoveryBlueprintPort = Object.freeze({
    async generate(input) {
      const operationKey = operationKeyForBlueprint(input);
      const actorId = "ai-discovery-runtime";
      const reservation = await reserveCapability(
        input,
        "AI_DISCOVERY",
        operationKey,
        actorId,
        discoveryPolicy,
      );
      if (reservation.status === "SETTLED") {
        throw new AiDraftError({
          code: "POLICY_VIOLATION",
          message: "AI Discovery operation is already settled.",
          retryable: false,
        });
      }
      const provider = createAiSdkCommercialDiscoveryBlueprintAdapter({
        providerRef: configuration.providerRef,
        providerBaseUrl: configuration.baseUrl,
        providerFetch,
        modelId: configuration.discoveryModelId,
        modelVersion: configuration.modelVersion,
        credentialSecretReference: configuration.credentialSecretReference,
        timeoutMs: configuration.timeoutMs,
        maxOutputTokens: configuration.maxOutputTokens,
        inputCostUsdPerMillionTokens:
          configuration.inputCostUsdPerMillionTokens,
        outputCostUsdPerMillionTokens:
          configuration.outputCostUsdPerMillionTokens,
        resolveSecret: resolveApprovedSecret,
        beforeProviderCall: async () => {
          await markProviderCallStarted(
            input,
            "AI_DISCOVERY",
            operationKey,
            actorId,
          );
        },
      });
      try {
        const result = await provider.generate(input);
        await settleCapability(
          input,
          "AI_DISCOVERY",
          operationKey,
          actorId,
          result.generation.estimatedCostUsd,
        );
        return result;
      } catch (error) {
        await finalizeCapabilityFailure(
          input,
          "AI_DISCOVERY",
          operationKey,
          actorId,
        );
        throw error;
      }
    },
  });

  const budgetGate: DraftBudgetGate = Object.freeze({
    async assertAvailable(scope) {
      await assertProviderAllowed(
        options.pool,
        scope,
        configuration.providerRef,
      );
      try {
        const readiness = await withBacklinkTenantTransaction(
          options.pool,
          scope,
          (client) => createAiCapabilityBudgetRepository(client).readiness(
            budgetInput(
              scope,
              "AI_OUTREACH_DRAFT",
              "draft-readiness",
              "ai-draft-runtime",
              draftPolicy,
            ),
          ),
        );
        if (readiness.state === "BUDGET_EXCEEDED") {
          throw new AiCapabilityBudgetError(
            "BUDGET_EXCEEDED",
            "AI_OUTREACH_DRAFT budget or call limit is exhausted.",
          );
        }
        if (readiness.state !== "READY") {
          throw new AiCapabilityBudgetError(
            "CONCURRENCY_EXHAUSTED",
            "AI_OUTREACH_DRAFT concurrency limit is exhausted.",
          );
        }
      } catch (error) {
        mapBudgetError(error);
      }
    },
  });

  return Object.freeze({
    blueprint,
    budgetGate,
    draft(input) {
      const transport = createAiSdkDraftTransport({
        providerBaseUrl: configuration.baseUrl,
        providerFetch,
        inputCostUsdPerMillionTokens:
          configuration.inputCostUsdPerMillionTokens,
        outputCostUsdPerMillionTokens:
          configuration.outputCostUsdPerMillionTokens,
        resolveSecret: resolveApprovedSecret,
        beforeProviderCall: async (scope) => {
          if (
            scope.organizationId !== input.organizationId
            || scope.workspaceId !== input.workspaceId
            || scope.websiteProjectId !== input.websiteProjectId
          ) {
            throw new AiDraftError({
              code: "POLICY_VIOLATION",
              message: "AI Draft scope does not match its budget reservation.",
              retryable: false,
            });
          }
          await markProviderCallStarted(
            input,
            "AI_OUTREACH_DRAFT",
            input.runId,
            input.actorId,
          );
        },
      });
      return createAiDraftClient({
        config: {
          enabled: true,
          secretRef: configuration.credentialSecretReference,
          providerRef: configuration.providerRef,
          modelId: configuration.modelId,
          modelVersion: configuration.modelVersion,
          timeoutMs: configuration.timeoutMs,
          maxInputTokens: configuration.maxInputTokens,
          maxOutputTokens: configuration.maxOutputTokens,
          absoluteBudgetUsd: draftReservationUsd,
        },
        transport,
        logger: (event) => console.log(JSON.stringify(event)),
      });
    },
    async reserve(input) {
      await assertProviderAllowed(
        options.pool,
        input,
        configuration.providerRef,
      );
      try {
        return await withBacklinkTenantTransaction(
          options.pool,
          input,
          async (client) => {
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
              return "terminal" as const;
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
            const reservation = await createAiCapabilityBudgetRepository(
              client,
            ).reserve(budgetInput(
              input,
              "AI_OUTREACH_DRAFT",
              input.runId,
              input.actorId,
              draftPolicy,
            ));
            if (reservation.status === "SETTLED") {
              throw new AiDraftError({
                code: "POLICY_VIOLATION",
                message: "AI Draft operation is already settled.",
                retryable: false,
              });
            }
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
                 AND status IN ('QUEUED','RUNNING','RETRY_SCHEDULED')`,
              [...scopeValues(input), input.runId, draftReservationUsd],
            );
            return "active" as const;
          },
        );
      } catch (error) {
        return mapBudgetError(error);
      }
    },
    async settle(input) {
      try {
        await withBacklinkTenantTransaction(
          options.pool,
          input,
          async (client) => {
            const target = await client.query(
              `SELECT status,
                      COALESCE(estimated_cost_usd,0)::text AS "actualCostUsd"
                 FROM backlinks.backlink_model_runs
                WHERE organization_id=$1
                  AND workspace_id=$2
                  AND website_project_id=$3
                  AND id=$4
                FOR UPDATE`,
              [...scopeValues(input), input.runId],
            );
            const row = target.rows[0];
            if (row === undefined || row.status !== "SUCCEEDED") {
              throw new AiDraftError({
                code: "POLICY_VIOLATION",
                message: "AI Draft Model Run is not ready for settlement.",
                retryable: false,
              });
            }
            await createAiCapabilityBudgetRepository(client).settle({
              ...input,
              capability: "AI_OUTREACH_DRAFT",
              operationKey: input.runId,
              actualCostUsd: Number(row.actualCostUsd),
            });
          },
        );
      } catch (error) {
        mapBudgetError(error);
      }
    },
    async release(input) {
      try {
        await withBacklinkTenantTransaction(
          options.pool,
          input,
          async (client) => {
            await client.query(
              `SELECT id
                 FROM backlinks.backlink_model_runs
                WHERE organization_id=$1
                  AND workspace_id=$2
                  AND website_project_id=$3
                  AND id=$4
                FOR UPDATE`,
              [...scopeValues(input), input.runId],
            );
            await createAiCapabilityBudgetRepository(client).finalizeFailure({
              ...input,
              capability: "AI_OUTREACH_DRAFT",
              operationKey: input.runId,
            });
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
      } catch (error) {
        mapBudgetError(error);
      }
    },
  });
}
