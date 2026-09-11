export type ResourceLibraryPublisher = Readonly<{
  canonicalDomain: string;
  websiteUrl: string;
  ahrefsDr: number;
  monthlyTraffic: number | null;
  language: string;
  categories: readonly string[];
  categoryMatch: "RELATED" | "ADJACENT" | "UNCONFIRMED";
}>;

export type ResourceLibraryMatchInput = Readonly<{
  projectDomain: string;
  projectDr: number;
  language: string;
  topics: readonly string[];
  excludedDomains: readonly string[];
  limit: number;
}>;

export interface ResourceLibraryPort {
  match(input: ResourceLibraryMatchInput): Promise<readonly ResourceLibraryPublisher[]>;
}

export class ResourceLibraryError extends Error {
  constructor(readonly code: "RESOURCE_LIBRARY_UNAVAILABLE" | "RESOURCE_LIBRARY_LANGUAGE_UNSUPPORTED") {
    super(code);
    this.name = "ResourceLibraryError";
  }
}
