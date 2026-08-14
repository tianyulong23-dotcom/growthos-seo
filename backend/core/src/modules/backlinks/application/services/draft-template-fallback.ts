import type {
  AiDraftInput,
  AiDraftResult,
} from "../../ports/ai-draft.port.js";

type PromptContext = Readonly<{
  project?: Readonly<{
    siteName?: unknown;
    products?: unknown;
  }>;
  promotionTarget?: Readonly<{ url?: unknown }>;
  opportunity?: Readonly<{ targetHost?: unknown }>;
  preferences?: Readonly<{
    cooperationType?: unknown;
    linkAttributePreference?: unknown;
    anchorTextSuggestion?: unknown;
  }>;
}>;

const text = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;

const firstString = (value: unknown, fallback: string): string =>
  Array.isArray(value)
    ? text(value.find((item) => typeof item === "string"), fallback)
    : fallback;

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
  const project = text(context.project?.siteName, "our website");
  const product = firstString(context.project?.products, "our product");
  const targetHost = text(
    context.opportunity?.targetHost,
    "the target website",
  );
  const promotionUrl = text(
    context.promotionTarget?.url,
    `https://${project}`,
  );
  const cooperationType = text(
    context.preferences?.cooperationType,
    "GENERAL_PARTNERSHIP",
  );
  const ask = cooperationAsk(cooperationType);
  const linkPreference = text(
    context.preferences?.linkAttributePreference,
    "NOT_SPECIFIED",
  );
  const anchor = text(context.preferences?.anchorTextSuggestion, "");
  const linkSentence = linkPreference === "DOFOLLOW_PREFERRED"
    ? "If a link is editorially appropriate, we would prefer dofollow, but we will respect your linking policy and a nofollow placement is also acceptable."
    : linkPreference === "NOFOLLOW_ACCEPTABLE"
      ? "If a link is editorially appropriate, a nofollow placement is completely acceptable and we will respect your linking policy."
      : "Any link treatment would remain entirely subject to your editorial policy.";
  const anchorSentence = anchor === ""
    ? ""
    : ` The suggested anchor text is "${anchor}", only if it reads naturally in your content.`;

  return {
    output: {
      subject: `Editorial collaboration with ${project}`,
      bodyText: [
        `Hello, I am reaching out from ${project} after reviewing ${targetHost}. Your site appears relevant to people researching topics connected with ${product}, so I wanted to ask whether a focused collaboration might be useful for your audience.`,
        `We would like to ${ask}. The proposed destination is ${promotionUrl}. We can provide concise source material, product context, and factual supporting details, while leaving topic selection, wording, review standards, and publication decisions fully with your editorial team.`,
        `${linkSentence}${anchorSentence} Publication, ranking, indexing, placement, and commercial outcomes all remain unconfirmed.`,
        `Would you be open to a brief review of the idea? If it is not a fit, no action is needed. If it may be relevant, please let us know the format or information your team would need before considering it.`,
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
        {
          claim: `${promotionUrl} is the selected promotion target.`,
          evidenceIds: ["promotion-target:current"],
        },
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
      modelVersion: "cooperation-template.v1",
    },
    latencyMs: 0,
    repairCount: 0,
  };
}
