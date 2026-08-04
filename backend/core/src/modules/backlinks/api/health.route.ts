import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { BacklinksConfig } from "../config/index.js";

const healthResponseSchema = z
  .object({
    status: z.literal("ok"),
  })
  .strict();

export function registerBacklinksHealthRoute(
  app: FastifyInstance,
  config: Pick<BacklinksConfig, "BACKLINKS_API_ENABLED">,
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
    () => ({ status: "ok" as const }),
  );
}
