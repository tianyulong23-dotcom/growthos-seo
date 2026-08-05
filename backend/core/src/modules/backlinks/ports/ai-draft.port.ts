import { z } from "zod";

const nonBlank = z.string().trim().min(1);
const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const aiDraftEvidenceSchema = z.object({
  id: nonBlank,
  sourceKind: z.enum([
    "PROFILE",
    "PROMOTION_TARGET",
    "OPPORTUNITY",
    "CONTACT",
    "ASSESSMENT",
  ]),
  value: nonBlank,
}).strict();

export const aiDraftInputSchema = z.object({
  organizationId: nonBlank,
  workspaceId: nonBlank,
  websiteProjectId: nonBlank,
  opportunityId: nonBlank,
  evidenceSnapshotId: nonBlank,
  promptVersion: nonBlank,
  outputSchemaVersion: nonBlank,
  systemInstruction: nonBlank,
  userContext: z.record(z.string(), jsonValueSchema),
  evidence: z.array(aiDraftEvidenceSchema).min(1).readonly(),
}).strict();

export const aiDraftOutputSchema = z.object({
  subject: nonBlank,
  bodyText: nonBlank,
  personalizationClaims: z.array(z.object({
    text: nonBlank,
    evidenceIds: z.array(nonBlank).min(1).readonly(),
  }).strict()).readonly(),
  missingInformation: z.array(nonBlank).readonly(),
  riskFlags: z.array(nonBlank).readonly(),
  requiresUserConfirmation: z.literal(true),
  canAutoSend: z.literal(false),
}).strict();

export type AiDraftInput = z.infer<typeof aiDraftInputSchema>;
export type AiDraftOutput = z.infer<typeof aiDraftOutputSchema>;

export const aiDraftErrorCodes = [
  "TIMEOUT",
  "RATE_LIMITED",
  "MALFORMED_OUTPUT",
  "REFUSED",
  "UNAVAILABLE",
  "MISCONFIGURED",
  "POLICY_VIOLATION",
  "BUDGET_EXCEEDED",
] as const;
export type AiDraftErrorCode = (typeof aiDraftErrorCodes)[number];

export class AiDraftError extends Error {
  readonly code: AiDraftErrorCode;
  readonly retryable: boolean;

  constructor(input: Readonly<{
    code: AiDraftErrorCode;
    message: string;
    retryable: boolean;
  }>) {
    super(input.message);
    this.name = "AiDraftError";
    this.code = input.code;
    this.retryable = input.retryable;
  }
}

export type AiDraftResult = Readonly<{
  output: AiDraftOutput;
  usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
  }>;
  model: Readonly<{
    providerRef: string;
    modelId: string;
    modelVersion: string;
  }>;
  latencyMs: number;
  repairCount: 0 | 1;
}>;

export type AiDraftPort = Readonly<{
  generate(input: AiDraftInput): Promise<AiDraftResult>;
}>;
