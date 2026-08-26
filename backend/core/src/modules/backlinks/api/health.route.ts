import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { BacklinksConfig } from "../config/index.js";
import {
  createBacklinksApiRuntimeHealth,
  providerExternalAvailabilitySchema,
  providerReasonCodeSchema,
  providerRecoveryActionSchema,
  type BacklinksApiRuntimeHealth,
} from "../runtime/runtime-health.js";

const providerHealthSchema = z
  .object({
    configured: z.boolean(),
    externalAvailability: providerExternalAvailabilitySchema,
    reasonCode: providerReasonCodeSchema.nullable(),
    recoveryAction: providerRecoveryActionSchema.nullable(),
  })
  .strict();
const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
    process: z.literal("api"),
    buildId: z.string().nullable(),
    providers: z
      .object({
        dataForSeo: providerHealthSchema,
        browser: providerHealthSchema,
        ai: providerHealthSchema,
        gmail: providerHealthSchema,
      })
      .strict(),
  })
  .strict();

export function registerBacklinksHealthRoute(
  app: FastifyInstance,
  config: Pick<BacklinksConfig, "BACKLINKS_API_ENABLED">,
  health: BacklinksApiRuntimeHealth = createBacklinksApiRuntimeHealth({}),
): void {
  if (!config.BACKLINKS_API_ENABLED) {
    return;
  }

  const api = app.withTypeProvider<ZodTypeProvider>();

  api.get(
    "/health",
    {
      schema: {
        operationId: "backlinksPrivateHealthV1",
        response: {
          200: healthResponseSchema,
        },
      },
    },
    () => health,
  );
}
