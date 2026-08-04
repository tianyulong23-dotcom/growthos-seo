export type ThirdPartyAdoption =
  | "direct-dependency"
  | "adapter"
  | "ported-source"
  | "conditional"
  | "rejected";

type SourceProvenance =
  | {
      readonly auditedCommit: string;
      readonly packageIntegrity?: never;
    }
  | {
      readonly auditedCommit?: never;
      readonly packageIntegrity: string;
    };

export type ThirdPartySourceRecord = {
  readonly id: string;
  readonly project: string;
  readonly repository: string;
  readonly license: string;
  readonly packageVersion?: string;
  readonly sourceFiles: readonly string[];
  readonly sourceFileHashes?: Readonly<Record<string, string>>;
  readonly upstreamTests: readonly string[];
  readonly targetFiles: readonly string[];
  readonly adoption: ThirdPartyAdoption;
  readonly defaultEnabled?: boolean;
  readonly allowedReuse: readonly string[];
  readonly forbiddenReuse: readonly string[];
  readonly adr: string;
} & SourceProvenance;

export type ThirdPartySourceManifest = {
  readonly schemaVersion: "1.0";
  readonly sources: readonly ThirdPartySourceRecord[];
};
