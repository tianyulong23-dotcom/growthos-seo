import {
  browserFetchEvidenceContractVersion,
  browserFetchEvidenceSchema,
  browserFetchRequestSchema,
  type BrowserFetchEvidence,
  type BrowserFetchPort,
  type BrowserFetchRequest,
} from "./crawler-browser-fetch.port.js";

const defaultObservedAt = "2026-07-28T00:00:00.000Z";
const fakeEvidenceSnapshotHash = "b".repeat(64);

export type FakeBrowserFetchAdapterOptions = Readonly<{
  observedAt?: string;
  finalUrl?: string;
}>;

export class FakeBrowserFetchAdapter implements BrowserFetchPort {
  readonly #observedAt: string;
  readonly #finalUrl: string | undefined;
  readonly #calls: BrowserFetchRequest[] = [];

  constructor(options: FakeBrowserFetchAdapterOptions = {}) {
    this.#observedAt = options.observedAt ?? defaultObservedAt;
    this.#finalUrl = options.finalUrl;
  }

  get calls(): readonly BrowserFetchRequest[] {
    return Object.freeze([...this.#calls]);
  }

  async fetch(input: BrowserFetchRequest): Promise<BrowserFetchEvidence> {
    const request = browserFetchRequestSchema.parse(input);
    this.#calls.push(request);

    return browserFetchEvidenceSchema.parse({
      contractVersion: browserFetchEvidenceContractVersion,
      executionMode: "browser",
      requestId: request.requestId,
      sourcePageUrl: request.sourcePageUrl,
      finalUrl: this.#finalUrl ?? request.sourcePageUrl,
      targetUrl: request.targetUrl,
      evidenceSnapshot: {
        fetchMode: "browser_fake",
        staticEvidenceSnapshotId: request.staticEvidenceSnapshotId,
        staticEvidenceSnapshotHash: request.staticEvidenceSnapshotHash,
      },
      evidenceSnapshotHash: fakeEvidenceSnapshotHash,
      observedAt: this.#observedAt,
    });
  }
}
