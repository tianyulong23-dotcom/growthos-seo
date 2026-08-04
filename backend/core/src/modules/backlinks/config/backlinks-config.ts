import { z } from "zod";

const positiveIntegerStringSchema = z
  .string()
  .regex(/^[1-9]\d*$/, "Expected a positive integer string")
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

const apiEnabledSchema = z
  .enum(["true", "false"])
  .optional()
  .transform((value) => value === "true");

export const backlinksConfigSchema = z
  .object({
    BACKLINKS_API_ENABLED: apiEnabledSchema,
    BACKLINK_API_BODY_LIMIT: positiveIntegerStringSchema,
    BACKLINK_API_REQUEST_TIMEOUT_MS: positiveIntegerStringSchema,
  })
  .strict();

export type BacklinksConfig = z.output<typeof backlinksConfigSchema>;
