import { z } from "zod";

import {
  backlinkSnapshotRequestSchema,
  type BacklinkSnapshotRequest,
} from "../../ports/dataforseo.port.js";
import type { DataForSeoClientConfig } from "./config.js";
import { mapDataForSeoProviderError } from "./error-mapper.js";

const resolvedCredentialsSchema = z
  .object({
    login: z.string().trim().min(1),
    password: z.string().min(1),
  })
  .strict();

export type DataForSeoResolvedCredentials = Readonly<z.output<
  typeof resolvedCredentialsSchema
>>;
export type DataForSeoSecretResolver = (secretReference: string) => Promise<unknown>;

export interface DataForSeoClientRuntime {
  fetchBacklinkSnapshot(request: BacklinkSnapshotRequest): Promise<unknown>;
}

export type DataForSeoClientRuntimeFactory = (options: {
  readonly credentials: DataForSeoResolvedCredentials;
  readonly timeoutMs: number;
}) => DataForSeoClientRuntime;

export class DataForSeoClientDisabledError extends Error {
  constructor() {
    super("DataForSEO client is disabled");
    this.name = "DataForSeoClientDisabledError";
  }
}

export class DataForSeoClientUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataForSeoClientUnavailableError";
  }
}

export class DataForSeoClient {
  constructor(
    private readonly config: DataForSeoClientConfig,
    private readonly resolveSecret: DataForSeoSecretResolver,
    private readonly runtimeFactory?: DataForSeoClientRuntimeFactory,
  ) {}

  async fetchBacklinkSnapshot(
    request: BacklinkSnapshotRequest,
  ): Promise<unknown> {
    if (!this.config.DATAFORSEO_ENABLED) {
      throw new DataForSeoClientDisabledError();
    }

    if (this.runtimeFactory === undefined) {
      throw new DataForSeoClientUnavailableError(
        "DataForSEO client runtime is not configured",
      );
    }

    const secretReference = this.config.DATAFORSEO_CREDENTIAL_SECRET_REF;
    if (secretReference === undefined) {
      throw new DataForSeoClientUnavailableError(
        "DataForSEO credential secret reference is not configured",
      );
    }

    const resolvedCredentials = resolvedCredentialsSchema.safeParse(
      await this.resolveSecret(secretReference),
    );
    if (!resolvedCredentials.success) {
      throw new DataForSeoClientUnavailableError(
        "Resolved DataForSEO credential secret is invalid",
      );
    }

    const parsedRequest = backlinkSnapshotRequestSchema.parse(request);
    const runtime = this.runtimeFactory({
      credentials: Object.freeze(resolvedCredentials.data),
      timeoutMs: this.config.DATAFORSEO_REQUEST_TIMEOUT_MS,
    });

    try {
      return await runtime.fetchBacklinkSnapshot(parsedRequest);
    } catch (error) {
      throw mapDataForSeoProviderError(error);
    }
  }
}
