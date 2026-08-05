import { z } from "zod";

import {
  SecretStoreError,
  secretStoreCreateInputSchema,
  secretStoreDestroyInputSchema,
  secretStoreFailureCodes,
  secretStoreFailureRetryability,
  secretStoreReferenceSchema,
  secretStoreResolveInputSchema,
  secretStoreRotateInputSchema,
  type SecretStoreCreateInput,
  type SecretStoreDestroyInput,
  type SecretStoreDestroyResult,
  type SecretStoreOperation,
  type SecretStorePort,
  type SecretStoreReference,
  type SecretStoreResolveInput,
  type SecretStoreRotateInput,
} from "../../ports/secret-store.port.js";

export const secretStoreClientConfigSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.string().trim().min(1).max(255)
    .default("platform-secret-store"),
  timeoutMs: z.number().int().positive().max(60_000).default(5_000),
}).strict();

export type SecretStoreClientReference = Readonly<{
  externalSecretId: string;
  externalSecretVersion: string;
}>;

export interface SecretStoreClient {
  create(input: SecretStoreCreateInput): Promise<SecretStoreClientReference>;
  resolve(input: SecretStoreResolveInput): Promise<string>;
  rotate(input: SecretStoreRotateInput): Promise<SecretStoreClientReference>;
  destroy(input: SecretStoreDestroyInput): Promise<void>;
}

export type SecretStoreClientAdapterOptions = Readonly<{
  config?: Readonly<{
    enabled?: boolean;
    provider?: string;
    timeoutMs?: number;
  }>;
  client?: SecretStoreClient;
}>;

const clientReferenceSchema = z.object({
  externalSecretId: z.string().trim().min(1).max(2_048),
  externalSecretVersion: z.string().trim().min(1).max(2_048),
}).strict();

const fail = (
  operation: SecretStoreOperation,
  code: keyof typeof secretStoreFailureRetryability,
) => new SecretStoreError({
  operation,
  code,
  retryable: secretStoreFailureRetryability[code],
});

export class SecretStoreClientAdapter implements SecretStorePort {
  readonly #enabled: boolean;
  readonly #provider: string;
  readonly #timeoutMs: number;
  readonly #client: SecretStoreClient | undefined;

  constructor(options: SecretStoreClientAdapterOptions = {}) {
    const config = secretStoreClientConfigSchema.parse(options.config ?? {});
    if (config.enabled && options.client === undefined) {
      throw new TypeError(
        "Secret Store client is required when the provider is enabled.",
      );
    }
    this.#enabled = config.enabled;
    this.#provider = config.provider;
    this.#timeoutMs = config.timeoutMs;
    this.#client = options.client;
  }

  async create(
    input: SecretStoreCreateInput,
  ): Promise<SecretStoreReference> {
    const operation = "create";
    this.assertEnabled(operation);
    const parsed = secretStoreCreateInputSchema.safeParse(input);
    if (!parsed.success) {
      throw fail(operation, secretStoreFailureCodes.invalidRequest);
    }
    const created = await this.execute(operation, (client) =>
      client.create(parsed.data));
    return secretStoreReferenceSchema.parse({
      provider: this.#provider,
      secretKind: parsed.data.secretKind,
      ...clientReferenceSchema.parse(created),
    });
  }

  async resolve(input: SecretStoreResolveInput): Promise<string> {
    const operation = "resolve";
    this.assertEnabled(operation);
    const parsed = secretStoreResolveInputSchema.safeParse(input);
    if (!parsed.success) {
      throw fail(operation, secretStoreFailureCodes.invalidRequest);
    }
    this.assertProvider(operation, parsed.data.reference);
    const plaintext = await this.execute(operation, (client) =>
      client.resolve(parsed.data));
    if (typeof plaintext !== "string" || plaintext.length === 0) {
      throw fail(operation, secretStoreFailureCodes.permanentFailure);
    }
    return plaintext;
  }

  async rotate(
    input: SecretStoreRotateInput,
  ): Promise<SecretStoreReference> {
    const operation = "rotate";
    this.assertEnabled(operation);
    const parsed = secretStoreRotateInputSchema.safeParse(input);
    if (!parsed.success) {
      throw fail(operation, secretStoreFailureCodes.invalidRequest);
    }
    this.assertProvider(operation, parsed.data.reference);
    const rotated = await this.execute(operation, (client) =>
      client.rotate(parsed.data));
    return secretStoreReferenceSchema.parse({
      provider: this.#provider,
      secretKind: parsed.data.reference.secretKind,
      ...clientReferenceSchema.parse(rotated),
    });
  }

  async destroy(
    input: SecretStoreDestroyInput,
  ): Promise<SecretStoreDestroyResult> {
    const operation = "destroy";
    this.assertEnabled(operation);
    const parsed = secretStoreDestroyInputSchema.safeParse(input);
    if (!parsed.success) {
      throw fail(operation, secretStoreFailureCodes.invalidRequest);
    }
    this.assertProvider(operation, parsed.data.reference);
    await this.execute(operation, (client) => client.destroy(parsed.data));
    return { destroyed: true };
  }

  private assertEnabled(operation: SecretStoreOperation): void {
    if (!this.#enabled) {
      throw fail(operation, secretStoreFailureCodes.disabled);
    }
  }

  private assertProvider(
    operation: SecretStoreOperation,
    reference: SecretStoreReference,
  ): void {
    if (reference.provider !== this.#provider) {
      throw fail(operation, secretStoreFailureCodes.invalidRequest);
    }
  }

  private async execute<Result>(
    operation: SecretStoreOperation,
    action: (client: SecretStoreClient) => Promise<Result>,
  ): Promise<Result> {
    const client = this.#client;
    if (client === undefined) {
      throw fail(operation, secretStoreFailureCodes.disabled);
    }

    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        action(client),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(fail(operation, secretStoreFailureCodes.timeout));
          }, this.#timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      throw fail(operation, secretStoreFailureCodes.temporaryFailure);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
