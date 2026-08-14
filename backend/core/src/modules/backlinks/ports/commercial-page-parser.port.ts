export type CommercialPageFacts = Readonly<{
  url: string;
  collectedAt: string;
  language: string | null;
  text: string;
  wordCount: number;
  externalLinkCount: number;
  totalLinkCount: number;
  hasTitle: boolean;
  hasDescription: boolean;
  hasEditorialContainer: boolean;
  cooperationLinks: readonly string[];
  highValueLinks: readonly string[];
}>;

export interface CommercialPageParserPort {
  parse(input: Readonly<{
    body: Uint8Array;
    finalUrl: string;
    fetchedAt: string;
    canonicalDomain: string;
  }>): CommercialPageFacts;
}
