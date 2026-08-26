import type {
  AiDraftInput,
  AiDraftResult,
} from "../../ports/ai-draft.port.js";

type PromptContext = Readonly<{
  project?: Readonly<{
    siteName?: unknown;
  }>;
  promotionTarget?: Readonly<{ label?: unknown; url?: unknown }>;
  opportunity?: Readonly<{ targetHost?: unknown }>;
  preferences?: Readonly<{
    cooperationType?: unknown;
    linkAttributePreference?: unknown;
    anchorTextSuggestion?: unknown;
  }>;
}>;

const text = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;

const visibleText = (
  value: unknown,
  fallback: string,
  maximumLength = 120,
): string => {
  const normalized = text(value, fallback)
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    normalized === ""
    || /\[(?:name|company|website)\]|\{\{[^}]+\}\}|\b(?:TBD|lorem ipsum)\b/iu
      .test(normalized)
  ) {
    return fallback;
  }
  return normalized.slice(0, maximumLength).trim();
};

const promotionUrl = (value: unknown): string | null => {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = new URL(value.trim());
    return ["http:", "https:"].includes(parsed.protocol)
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
};

const cooperationAsk = (value: string): string => ({
  GUEST_POST: "contribute a useful guest article",
  LINK_INSERTION: "suggest a relevant addition to an existing resource",
  RESOURCE_PAGE: "be considered for a relevant resource page",
  PRODUCT_REVIEW: "offer the product for an independent editorial review",
  CONTENT_PARTNERSHIP: "explore a practical content partnership",
  GENERAL_PARTNERSHIP: "explore a relevant editorial partnership",
}[value] ?? "explore a relevant editorial partnership");

export function createDraftTemplateFallback(
  input: AiDraftInput,
  riskCode: string,
): AiDraftResult {
  const context = input.userContext as PromptContext;
  const project = visibleText(context.project?.siteName, "our website");
  const targetHost = visibleText(
    context.opportunity?.targetHost,
    "the target website",
  );
  const targetLabel = visibleText(
    context.promotionTarget?.label,
    "the page selected for this campaign",
  );
  const targetUrl = promotionUrl(context.promotionTarget?.url);
  const cooperationType = text(
    context.preferences?.cooperationType,
    "GENERAL_PARTNERSHIP",
  );
  const ask = cooperationAsk(cooperationType);
  const linkPreference = text(
    context.preferences?.linkAttributePreference,
    "NOT_SPECIFIED",
  );
  const anchor = visibleText(
    context.preferences?.anchorTextSuggestion,
    "",
    100,
  );
  const linkSentence = linkPreference === "DOFOLLOW_PREFERRED"
    ? "If a link is editorially appropriate, we would prefer dofollow, but we will respect your linking policy and a nofollow placement is also acceptable."
    : linkPreference === "NOFOLLOW_ACCEPTABLE"
      ? "If a link is editorially appropriate, a nofollow placement is completely acceptable and we will respect your linking policy."
      : "Any link treatment would remain entirely subject to your editorial policy.";
  const anchorSentence = anchor === ""
    ? ""
    : ` The suggested anchor text is "${anchor}", only if it reads naturally in your content.`;
  const destinationSentence = targetUrl === null
    ? `The proposed destination is ${targetLabel}, and we can share the exact URL with the editorial brief.`
    : `The proposed destination is ${targetUrl}.`;

  return {
    output: {
      subject: `Editorial idea for ${targetHost}`,
      bodyText: [
        `Hello, I am reaching out from ${project} with an editorial idea for ${targetHost}. The audience overlap appears relevant enough to ask whether a carefully scoped collaboration could be useful to your readers, without assuming that the idea is already a fit for your publication.`,
        `We would like to ${ask}. ${destinationSentence} We can provide a concise brief, factual source material, and any product context your team requests, while leaving the angle, wording, review standards, and final publication decision entirely with your editors.`,
        `${linkSentence}${anchorSentence} We are not assuming acceptance, publication, ranking, indexing, placement, pricing, or any particular link attribute. Any collaboration should proceed only when it meets your normal editorial standards and offers genuine value to the intended audience.`,
        `Would you be open to a brief review of the idea? If it is not relevant, no action is needed. If it may be useful, please let us know what format, evidence, or background your team would need before deciding whether to consider it further.`,
      ].join("\n\n"),
      factsUsed: [
        {
          claim: `${project} is the sender's project site.`,
          evidenceIds: ["profile:current"],
        },
        {
          claim: `${targetHost} is the target website for this Opportunity.`,
          evidenceIds: ["opportunity:current"],
        },
        ...(targetUrl === null
          ? []
          : [{
              claim: `${targetUrl} is the selected promotion target.`,
              evidenceIds: ["promotion-target:current"],
            }]),
      ],
      riskFlags: [`TEMPLATE_FALLBACK:${riskCode}`],
      requiresUserConfirmation: true,
      canAutoSend: false,
    },
    usage: { inputTokens: 0, outputTokens: 0 },
    estimatedCostUsd: 0,
    model: {
      providerRef: "template-fallback",
      modelId: "cooperation-template",
      modelVersion: "cooperation-template.v2",
    },
    latencyMs: 0,
    repairCount: 0,
  };
}
