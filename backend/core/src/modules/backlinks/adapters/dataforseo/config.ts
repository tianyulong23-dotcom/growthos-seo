import { z } from "zod";

const timeoutSchema = z
  .string()
  .regex(/^[1-9]\d*$/)
  .default("60000")
  .transform(Number)
  .pipe(z.number().int().positive().max(120_000).safe());

export const dataForSeoClientConfigSchema = z
  .object({
    DATAFORSEO_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    DATAFORSEO_CREDENTIAL_SECRET_REF: z.string().trim().min(1).optional(),
    DATAFORSEO_REQUEST_TIMEOUT_MS: timeoutSchema,
  })
  .strict()
  .superRefine((config, context) => {
    if (config.DATAFORSEO_ENABLED && !config.DATAFORSEO_CREDENTIAL_SECRET_REF) {
      context.addIssue({
        code: "custom",
        path: ["DATAFORSEO_CREDENTIAL_SECRET_REF"],
        message: "credential secret reference is required when enabled",
      });
    }
  });

export type DataForSeoClientConfig = Readonly<z.output<
  typeof dataForSeoClientConfigSchema
>>;
