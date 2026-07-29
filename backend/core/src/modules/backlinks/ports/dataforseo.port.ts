import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(255);
const targetSchema = z.string().trim().min(1).max(2_048);
const timestampSchema = z.string().datetime({ offset: true });
const safeCountSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const providerRequestContextSchema = z
  .object({
    organizationId: identifierSchema,
    workspaceId: identifierSchema,
    websiteProjectId: identifierSchema,
    requestId: identifierSchema,
    idempotencyKey: identifierSchema,
    budgetReservationId: identifierSchema,
  })
  .strict();

export type ProviderRequestContext = Readonly<
  z.output<typeof providerRequestContextSchema>
>;

export const backlinkSnapshotRequestSchema = z
  .object({
    target: targetSchema,
    targetType: z.enum(["domain", "page"]),
    limit: z.number().int().min(1).max(1_000),
  })
  .strict();

export type BacklinkSnapshotRequest = Readonly<
  z.output<typeof backlinkSnapshotRequestSchema>
>;

export const providerCostSchema = z
  .object({
    costMicros: safeCountSchema,
  })
  .strict();

export type ProviderCost = Readonly<z.output<typeof providerCostSchema>>;

export const referringDomainEvidenceSchema = z
  .object({
    domain: z.string().trim().min(1).max(253),
    backlinkCount: safeCountSchema,
    rank: z.number().finite().nonnegative().nullable(),
    spamScore: z.number().finite().min(0).max(100).nullable(),
    countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
  })
  .strict();

export type ReferringDomainEvidence = Readonly<
  z.output<typeof referringDomainEvidenceSchema>
>;

export const backlinkProviderSnapshotSchema = z
  .object({
    provider: z.literal("dataforseo"),
    schemaVersion: z.string().trim().min(1).max(64),
    requestedAt: timestampSchema,
    completedAt: timestampSchema,
    costMicros: providerCostSchema.shape.costMicros,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    referringDomains: z.array(referringDomainEvidenceSchema).max(1_000),
  })
  .strict();

type ParsedBacklinkProviderSnapshot = z.output<
  typeof backlinkProviderSnapshotSchema
>;

export type BacklinkProviderSnapshot = Readonly<
  Omit<ParsedBacklinkProviderSnapshot, "referringDomains"> & {
    referringDomains: readonly ReferringDomainEvidence[];
  }
>;

export interface DataForSeoPort {
  fetchBacklinkSnapshot(
    context: ProviderRequestContext,
    request: BacklinkSnapshotRequest,
  ): Promise<BacklinkProviderSnapshot>;
}
