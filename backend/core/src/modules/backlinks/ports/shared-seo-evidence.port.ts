import { isDeepStrictEqual } from "node:util";

export type ProjectOutreachProfile = Readonly<{
  organizationId: string;
  websiteProjectId: string;
  profileVersionId: string;
  promotionTargetVersionId: string;
  keywordsAndTopics: readonly string[];
  productsAndServices: readonly string[];
  targetUrls: readonly string[];
  targetAudiences: readonly string[];
  partnershipGoals: readonly string[];
  market: string;
  location: string;
  language: string;
  authorizedDiscoverySources: readonly string[];
  immutableFingerprint: string;
}>;

export type SharedSeoEvidenceSourceModule =
  "site-profile" | "keywords" | "competitor-serp" | "content" | "gsc";

export type SharedSeoEvidenceSnapshot = Readonly<{
  organizationId: string;
  websiteProjectId: string;
  evidenceType: string;
  sourceModule: SharedSeoEvidenceSourceModule;
  sourceRecordId: string;
  sourceVersion: string;
  provider: string;
  endpoint: string;
  normalizedParameters: Readonly<Record<string, unknown>>;
  requestFingerprint: string;
  market: string;
  location: string;
  language: string;
  fetchedAt: string;
  expiresAt: string;
  providerRequestId: string;
  providerTaskId: string | null;
  costMicros: number | null;
  artifactRef: string;
  status: "ready" | "expired" | "failed";
}>;

export type SharedSeoEvidenceRequest = Readonly<{
  organizationId: string;
  websiteProjectId: string;
  evidenceType: string;
  sourceModule: SharedSeoEvidenceSourceModule;
  provider: string;
  endpoint: string;
  requestFingerprint: string;
  market: string;
  location: string;
  language: string;
  now: string;
}>;

export type GenerationInputPins = Readonly<{
  organizationId: string;
  websiteProjectId: string;
  projectContextVersion: number;
  siteProfileVersionId: string;
  outreachProfileVersionId: string;
  promotionTargetVersionId: string;
  keywordEvidenceSnapshotIds: readonly string[];
  sharedEvidenceSnapshotIds: readonly string[];
  market: string;
  qualificationContractVersion: string;
}>;

export type PersistOutreachProfileInput = Readonly<{
  recordId: string;
  workspaceId: string;
  createdBy: string;
  profile: ProjectOutreachProfile;
}>;

export type PersistSharedSeoEvidenceReferenceInput = Readonly<{
  recordId: string;
  workspaceId: string;
  createdBy: string;
  snapshot: SharedSeoEvidenceSnapshot;
}>;

export type PersistGenerationInputPinsInput = Readonly<{
  recordId: string;
  workspaceId: string;
  outreachProfileRecordId: string;
  createdBy: string;
  immutableFingerprint: string;
  pins: GenerationInputPins;
}>;

export type ReadGenerationInputBindingInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  inputPinId: string;
  qualificationContractVersion: string;
  market: string;
}>;

export type ReadGenerationInputBindingForContextInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  projectContextVersion: number;
  siteProfileVersionId: string;
  promotionTargetVersionId: string;
  qualificationContractVersion: string;
  market: string;
}>;

export type PinnedSharedSeoEvidence = Readonly<{
  recordId: string;
  snapshot: SharedSeoEvidenceSnapshot;
}>;

export type GenerationInputBinding = Readonly<{
  inputPinId: string;
  outreachProfileRecordId: string;
  immutableFingerprint: string;
  pins: GenerationInputPins;
  outreachProfile: ProjectOutreachProfile;
  sharedEvidence: readonly PinnedSharedSeoEvidence[];
}>;

export type ResolvedSharedSeoEvidenceArtifact = Readonly<{
  snapshot: SharedSeoEvidenceSnapshot;
  payload: Readonly<Record<string, unknown>>;
}>;

export interface SharedSeoEvidencePort {
  readReusable(
    request: SharedSeoEvidenceRequest,
  ): Promise<SharedSeoEvidenceSnapshot | null>;
}

export interface SharedSeoEvidenceSourcePort {
  listProjectEvidence(
    request: Pick<
      SharedSeoEvidenceRequest,
      "organizationId" | "websiteProjectId" | "evidenceType" | "sourceModule"
    >,
  ): Promise<readonly SharedSeoEvidenceSnapshot[]>;
}

export interface SharedSeoEvidenceArtifactResolverPort {
  resolveArtifact(
    snapshot: SharedSeoEvidenceSnapshot,
  ): Promise<ResolvedSharedSeoEvidenceArtifact | null>;
}

export type SharedSeoEvidenceArtifactResolvers = Readonly<
  Partial<
    Record<SharedSeoEvidenceSourceModule, SharedSeoEvidenceArtifactResolverPort>
  >
>;

export interface SharedSeoEvidenceArtifactPort {
  readReusable(
    request: SharedSeoEvidenceRequest,
  ): Promise<ResolvedSharedSeoEvidenceArtifact | null>;
}

export interface ProjectInputPersistencePort {
  saveOutreachProfile(input: PersistOutreachProfileInput): Promise<string>;
  saveSharedSeoEvidenceReference(
    input: PersistSharedSeoEvidenceReferenceInput,
  ): Promise<string>;
  saveGenerationInputPins(
    input: PersistGenerationInputPinsInput,
  ): Promise<string>;
  readGenerationInputBinding(
    input: ReadGenerationInputBindingInput,
  ): Promise<GenerationInputBinding | null>;
  readGenerationInputBindingForContext(
    input: ReadGenerationInputBindingForContextInput,
  ): Promise<GenerationInputBinding | null>;
}

export function createSharedSeoEvidenceReadAdapter(
  source: SharedSeoEvidenceSourcePort,
): SharedSeoEvidencePort {
  return {
    async readReusable(request) {
      const candidates = await source.listProjectEvidence({
        organizationId: request.organizationId,
        websiteProjectId: request.websiteProjectId,
        evidenceType: request.evidenceType,
        sourceModule: request.sourceModule,
      });
      return (
        candidates
          .filter((candidate) =>
            isReusableSharedSeoEvidence(candidate, request),
          )
          .sort(
            (left, right) =>
              Date.parse(right.fetchedAt) - Date.parse(left.fetchedAt),
          )[0] ?? null
      );
    },
  };
}

export function createPinnedSharedSeoEvidenceSource(
  binding: GenerationInputBinding,
): SharedSeoEvidenceSourcePort {
  assertPinnedSharedSeoEvidenceBinding(binding);
  return {
    async listProjectEvidence(request) {
      if (
        request.organizationId !== binding.pins.organizationId ||
        request.websiteProjectId !== binding.pins.websiteProjectId
      ) {
        return [];
      }
      return binding.sharedEvidence
        .map((evidence) => evidence.snapshot)
        .filter(
          (snapshot) =>
            snapshot.evidenceType === request.evidenceType &&
            snapshot.sourceModule === request.sourceModule,
        );
    },
  };
}

export function createPinnedSharedSeoEvidenceArtifactReadAdapter(
  binding: GenerationInputBinding,
  resolvers: SharedSeoEvidenceArtifactResolvers,
): SharedSeoEvidenceArtifactPort {
  const evidence = createSharedSeoEvidenceReadAdapter(
    createPinnedSharedSeoEvidenceSource(binding),
  );
  return {
    async readReusable(request) {
      const snapshot = await evidence.readReusable(request);
      if (!snapshot) {
        return null;
      }
      const resolver = resolvers[snapshot.sourceModule];
      if (!resolver) {
        return null;
      }
      const resolved = await resolver.resolveArtifact(snapshot);
      if (!resolved) {
        return null;
      }
      if (!isDeepStrictEqual(resolved.snapshot, snapshot)) {
        throw new ProjectInputBindingIntegrityError(
          "Resolved shared SEO evidence does not match the pinned snapshot.",
        );
      }
      if (
        resolved.payload === null ||
        typeof resolved.payload !== "object" ||
        Array.isArray(resolved.payload)
      ) {
        throw new ProjectInputBindingIntegrityError(
          "Resolved shared SEO evidence payload must be an object.",
        );
      }
      return Object.freeze({
        snapshot,
        payload: Object.freeze({ ...resolved.payload }),
      });
    },
  };
}

export function isReusableSharedSeoEvidence(
  snapshot: SharedSeoEvidenceSnapshot,
  request: SharedSeoEvidenceRequest,
): boolean {
  const expiresAt = Date.parse(snapshot.expiresAt);
  const now = Date.parse(request.now);
  return (
    snapshot.status === "ready" &&
    Number.isFinite(expiresAt) &&
    Number.isFinite(now) &&
    expiresAt > now &&
    snapshot.organizationId === request.organizationId &&
    snapshot.websiteProjectId === request.websiteProjectId &&
    snapshot.evidenceType === request.evidenceType &&
    snapshot.sourceModule === request.sourceModule &&
    snapshot.provider === request.provider &&
    snapshot.endpoint === request.endpoint &&
    snapshot.requestFingerprint === request.requestFingerprint &&
    snapshot.market === request.market &&
    snapshot.location === request.location &&
    snapshot.language === request.language
  );
}

function assertPinnedSharedSeoEvidenceBinding(
  binding: GenerationInputBinding,
): void {
  const pinnedIds = binding.pins.sharedEvidenceSnapshotIds;
  const uniquePinnedIds = new Set(pinnedIds);
  const recordsMatchPins =
    uniquePinnedIds.size === pinnedIds.length &&
    binding.sharedEvidence.length === pinnedIds.length &&
    binding.sharedEvidence.every(
      (evidence, index) =>
        evidence.recordId === pinnedIds[index] &&
        evidence.snapshot.organizationId === binding.pins.organizationId &&
        evidence.snapshot.websiteProjectId === binding.pins.websiteProjectId &&
        evidence.snapshot.market === binding.pins.market,
    );
  if (!recordsMatchPins) {
    throw new ProjectInputBindingIntegrityError(
      "Shared SEO evidence does not match the immutable generation input pin.",
    );
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function assertGenerationInputPinsMatch(
  expected: GenerationInputPins,
  actual: GenerationInputPins,
): void {
  const matches =
    expected.organizationId === actual.organizationId &&
    expected.websiteProjectId === actual.websiteProjectId &&
    expected.projectContextVersion === actual.projectContextVersion &&
    expected.siteProfileVersionId === actual.siteProfileVersionId &&
    expected.outreachProfileVersionId === actual.outreachProfileVersionId &&
    expected.promotionTargetVersionId === actual.promotionTargetVersionId &&
    sameStrings(
      expected.keywordEvidenceSnapshotIds,
      actual.keywordEvidenceSnapshotIds,
    ) &&
    sameStrings(
      expected.sharedEvidenceSnapshotIds,
      actual.sharedEvidenceSnapshotIds,
    ) &&
    expected.market === actual.market &&
    expected.qualificationContractVersion ===
      actual.qualificationContractVersion;
  if (!matches) {
    throw new TypeError(
      "Generation input pins are bound to different project facts.",
    );
  }
}

export class ProjectInputBindingIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectInputBindingIntegrityError";
  }
}
