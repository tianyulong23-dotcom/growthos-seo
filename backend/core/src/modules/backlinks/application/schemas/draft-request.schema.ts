import { z } from "zod";

const nonBlank = z.string().trim().min(1);

export const draftCooperationTypes = [
  "GUEST_POST",
  "LINK_INSERTION",
  "RESOURCE_PAGE",
  "PRODUCT_REVIEW",
  "CONTENT_PARTNERSHIP",
  "GENERAL_PARTNERSHIP",
] as const;

export const draftLinkAttributePreferences = [
  "DOFOLLOW_PREFERRED",
  "NOFOLLOW_ACCEPTABLE",
  "EITHER",
  "NOT_SPECIFIED",
] as const;

export const draftTones = [
  "NEUTRAL_BUSINESS",
  "WARM_PROFESSIONAL",
  "CONCISE_DIRECT",
] as const;

export const draftSubjectStyles = [
  "CLEAR_DIRECT",
  "BENEFIT_LED",
  "QUESTION_LED",
] as const;

export const draftRequestSchema = z.object({
  cooperationType: z.enum(draftCooperationTypes).default(
    "GENERAL_PARTNERSHIP",
  ),
  linkAttributePreference: z.enum(draftLinkAttributePreferences).default(
    "NOT_SPECIFIED",
  ),
  promotionTargetUrl: z.string().url(),
  anchorTextSuggestion: nonBlank.max(200).nullable().optional(),
  language: nonBlank.max(35),
  tone: z.enum(draftTones).default("NEUTRAL_BUSINESS"),
  subjectStyle: z.enum(draftSubjectStyles).default("CLEAR_DIRECT"),
  additionalRequirements: z.string().trim().max(2_000).default(""),
  forbiddenPhrases: z.array(nonBlank.max(120)).max(20).default([]),
}).strict();

export type DraftRequest = z.infer<typeof draftRequestSchema>;
