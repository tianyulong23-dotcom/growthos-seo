import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import type {
  SecretStoreClient,
  SecretStoreClientReference,
} from "./secret-store-client.js";
import {
  SecretStoreError,
  secretStoreFailureCodes,
  secretStoreFailureRetryability,
  secretStoreReferenceSchema,
  type SecretEncryptionContext,
  type SecretKind,
  type SecretStoreCreateInput,
  type SecretStoreDestroyInput,
  type SecretStoreReference,
  type SecretStoreResolveInput,
  type SecretStoreRotateInput,
} from "../../ports/secret-store.port.js";

const provider = "platform-secret-store";
const schemaVersion = "growthos.local-secret.v1";
const algorithm = "aes-256-gcm";
const keyBytes = 32;
const initializationVectorBytes = 12;
const fixedReferencePrefix = "secret://growthos/local-product/";
const secretKindPathPrefixes = Object.freeze({
  GOOGLE_OAUTH_CLIENT_SECRET: ["google/"],
  OAUTH_PKCE_VERIFIER: ["oauth_pkce_verifier/"],
  GMAIL_TOKEN_SET: ["gmail_token_set/"],
  GMAIL_CANARY_RECIPIENT: ["gmail/"],
  AI_PROVIDER_CREDENTIAL: ["ai/"],
  DATAFORSEO_CREDENTIAL: ["dataforseo/"],
} satisfies Record<SecretKind, readonly string[]>);

const versionSchema = z.string().regex(/^v[1-9][0-9]*$/u);
const envelopeSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  algorithm: z.literal(algorithm),
  secretKind: z.string().min(1),
  externalSecretId: z.string().min(1),
  externalSecretVersion: versionSchema,
  contextHash: z.string().regex(/^[a-f0-9]{64}$/u),
  initializationVector: z.string().min(1),
  authenticationTag: z.string().min(1),
  ciphertext: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

type SecretEnvelope = z.output<typeof envelopeSchema>;

const canonicalContext = (context: SecretEncryptionContext): string =>
  JSON.stringify({
    organizationId: context.organizationId,
    subjectProvider: context.subjectProvider,
    workspaceId: context.workspaceId ?? null,
    connectionId: context.connectionId ?? null,
    oauthAttemptId: context.oauthAttemptId ?? null,
  });

const contextHash = (context: SecretEncryptionContext): string =>
  createHash("sha256").update(canonicalContext(context)).digest("hex");

const fail = (
  operation: "create" | "resolve" | "rotate" | "destroy",
  code: keyof typeof secretStoreFailureRetryability,
  cause?: unknown,
) => new SecretStoreError({
  operation,
  code,
  retryable: secretStoreFailureRetryability[code],
}, cause === undefined ? undefined : { cause });

const nextVersion = (version: string): string => {
  const parsed = versionSchema.parse(version);
  return `v${Number(parsed.slice(1)) + 1}`;
};

const encodePathSegment = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

export const googleOauthClientSecretReference =
  "secret://growthos/local-product/google/oauth-client-secret/v1";
export const localProductGmailCanaryRecipientReference =
  "secret://growthos/local-product/gmail/canary-recipient/v1";
export const localProductAiProviderCredentialReference =
  "secret://growthos/local-product/ai/provider-credential/v1";
export const localProductDataForSeoCredentialReference =
  "secret://growthos/local-product/dataforseo/provider-credential/v1";

export function parseLocalProductSecretReference(
  value: string,
  secretKind: SecretKind,
): SecretStoreReference {
  if (!value.startsWith(fixedReferencePrefix)) {
    throw new TypeError("Local product Secret Reference is invalid.");
  }
  const parts = value.slice(fixedReferencePrefix.length).split("/");
  if (parts.length < 2) {
    throw new TypeError("Local product Secret Reference is invalid.");
  }
  const externalSecretVersion = parts.at(-1);
  const externalSecretId = parts.slice(0, -1).join("/");
  if (!secretKindPathPrefixes[secretKind].some((prefix) =>
    externalSecretId.startsWith(prefix)
  )) {
    throw new TypeError("Local product Secret Reference kind is invalid.");
  }
  return secretStoreReferenceSchema.parse({
    provider,
    secretKind,
    externalSecretId,
    externalSecretVersion,
  });
}

export type LocalProductSecretStoreClientOptions = Readonly<{
  rootDirectory: string;
  now?: () => Date;
  newId?: () => string;
}>;

export class LocalProductSecretStoreClient implements SecretStoreClient {
  readonly #rootDirectory: string;
  readonly #masterKeyPath: string;
  readonly #now: () => Date;
  readonly #newId: () => string;
  #masterKey: Promise<Buffer> | undefined;

  constructor(options: LocalProductSecretStoreClientOptions) {
    if (!isAbsolute(options.rootDirectory)) {
      throw new TypeError("Local product Secret Store root must be absolute.");
    }
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#masterKeyPath = join(this.#rootDirectory, "master-key.bin");
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
  }

  async create(
    input: SecretStoreCreateInput,
  ): Promise<SecretStoreClientReference> {
    const reference = {
      externalSecretId:
        `${input.secretKind.toLowerCase()}/${this.#newId()}`,
      externalSecretVersion: "v1",
    };
    await this.writeSecret("create", {
      secretKind: input.secretKind,
      plaintext: input.plaintext,
      context: input.context,
      ...reference,
    }, true);
    return reference;
  }

  async importFixed(
    input: Readonly<{
      reference: SecretStoreReference;
      plaintext: string;
      context: SecretEncryptionContext;
      replace?: boolean;
    }>,
  ): Promise<void> {
    if (input.reference.provider !== provider) {
      throw fail("create", secretStoreFailureCodes.invalidRequest);
    }
    await this.writeSecret("create", {
      secretKind: input.reference.secretKind,
      plaintext: input.plaintext,
      context: input.context,
      externalSecretId: input.reference.externalSecretId,
      externalSecretVersion: input.reference.externalSecretVersion,
    }, input.replace !== true);
  }

  async resolve(input: SecretStoreResolveInput): Promise<string> {
    const envelope = await this.readEnvelope("resolve", input.reference);
    this.assertEnvelope("resolve", envelope, input.reference, input.context);
    try {
      const key = await this.masterKey();
      const decipher = createDecipheriv(
        algorithm,
        key,
        Buffer.from(envelope.initializationVector, "base64url"),
      );
      decipher.setAAD(this.aad(envelope));
      decipher.setAuthTag(Buffer.from(envelope.authenticationTag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      throw fail("resolve", secretStoreFailureCodes.permanentFailure, error);
    }
  }

  async rotate(
    input: SecretStoreRotateInput,
  ): Promise<SecretStoreClientReference> {
    const current = await this.readEnvelope("rotate", input.reference);
    this.assertEnvelope("rotate", current, input.reference, input.context);
    const rotated = {
      externalSecretId: input.reference.externalSecretId,
      externalSecretVersion:
        nextVersion(input.reference.externalSecretVersion),
    };
    await this.writeSecret("rotate", {
      secretKind: input.reference.secretKind,
      plaintext: input.plaintext,
      context: input.context,
      ...rotated,
    }, true);
    return rotated;
  }

  async destroy(input: SecretStoreDestroyInput): Promise<void> {
    const path = this.secretPath(input.reference);
    try {
      const envelope = await this.readEnvelope("destroy", input.reference);
      this.assertEnvelope("destroy", envelope, input.reference, input.context);
      await rm(path, { force: true });
    } catch (error) {
      if (
        error instanceof SecretStoreError
        && error.code === secretStoreFailureCodes.notFound
      ) {
        return;
      }
      throw error;
    }
  }

  private async writeSecret(
    operation: "create" | "rotate",
    input: Readonly<{
      secretKind: SecretKind;
      plaintext: string;
      context: SecretEncryptionContext;
      externalSecretId: string;
      externalSecretVersion: string;
    }>,
    exclusive: boolean,
  ): Promise<void> {
    try {
      versionSchema.parse(input.externalSecretVersion);
      const key = await this.masterKey();
      const initializationVector = randomBytes(initializationVectorBytes);
      const partial = {
        schemaVersion,
        algorithm,
        secretKind: input.secretKind,
        externalSecretId: input.externalSecretId,
        externalSecretVersion: input.externalSecretVersion,
        contextHash: contextHash(input.context),
        initializationVector: initializationVector.toString("base64url"),
        createdAt: this.#now().toISOString(),
      } as const;
      const cipher = createCipheriv(algorithm, key, initializationVector);
      cipher.setAAD(this.aad(partial));
      const ciphertext = Buffer.concat([
        cipher.update(input.plaintext, "utf8"),
        cipher.final(),
      ]);
      const envelope: SecretEnvelope = envelopeSchema.parse({
        ...partial,
        authenticationTag: cipher.getAuthTag().toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
      });
      const path = this.secretPath({
        provider,
        secretKind: input.secretKind,
        externalSecretId: input.externalSecretId,
        externalSecretVersion: input.externalSecretVersion,
      });
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      if (exclusive) {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
        } finally {
          await handle.close();
        }
        return;
      }
      const temporaryPath = `${path}.${this.#newId()}.tmp`;
      await writeFile(
        temporaryPath,
        `${JSON.stringify(envelope)}\n`,
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      await rename(temporaryPath, path);
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      const nodeError = error as NodeJS.ErrnoException;
      throw fail(
        operation,
        nodeError.code === "EEXIST"
          ? secretStoreFailureCodes.invalidRequest
          : secretStoreFailureCodes.permanentFailure,
        error,
      );
    }
  }

  private async readEnvelope(
    operation: "resolve" | "rotate" | "destroy",
    reference: SecretStoreReference,
  ): Promise<SecretEnvelope> {
    try {
      return envelopeSchema.parse(JSON.parse(
        await readFile(this.secretPath(reference), "utf8"),
      ));
    } catch (error) {
      if (error instanceof SecretStoreError) throw error;
      const nodeError = error as NodeJS.ErrnoException;
      throw fail(
        operation,
        nodeError.code === "ENOENT"
          ? secretStoreFailureCodes.notFound
          : secretStoreFailureCodes.permanentFailure,
        error,
      );
    }
  }

  private assertEnvelope(
    operation: "resolve" | "rotate" | "destroy",
    envelope: SecretEnvelope,
    reference: SecretStoreReference,
    context: SecretEncryptionContext,
  ): void {
    if (
      reference.provider !== provider
      || envelope.secretKind !== reference.secretKind
      || envelope.externalSecretId !== reference.externalSecretId
      || envelope.externalSecretVersion !== reference.externalSecretVersion
      || envelope.contextHash !== contextHash(context)
    ) {
      throw fail(operation, secretStoreFailureCodes.invalidRequest);
    }
  }

  private secretPath(reference: SecretStoreReference): string {
    const version = versionSchema.parse(reference.externalSecretVersion);
    return join(
      this.#rootDirectory,
      "values",
      encodePathSegment(reference.externalSecretId),
      encodePathSegment(reference.secretKind),
      `${version}.json`,
    );
  }

  private aad(input: Readonly<{
    schemaVersion: string;
    algorithm: string;
    secretKind: string;
    externalSecretId: string;
    externalSecretVersion: string;
    contextHash: string;
    initializationVector: string;
    createdAt: string;
  }>): Buffer {
    return Buffer.from(JSON.stringify({
      schemaVersion: input.schemaVersion,
      algorithm: input.algorithm,
      secretKind: input.secretKind,
      externalSecretId: input.externalSecretId,
      externalSecretVersion: input.externalSecretVersion,
      contextHash: input.contextHash,
      initializationVector: input.initializationVector,
      createdAt: input.createdAt,
    }), "utf8");
  }

  private masterKey(): Promise<Buffer> {
    this.#masterKey ??= this.loadOrCreateMasterKey();
    return this.#masterKey;
  }

  private async loadOrCreateMasterKey(): Promise<Buffer> {
    await mkdir(this.#rootDirectory, { recursive: true, mode: 0o700 });
    try {
      const key = await readFile(this.#masterKeyPath);
      if (key.length !== keyBytes) {
        throw fail("resolve", secretStoreFailureCodes.permanentFailure);
      }
      return key;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "ENOENT") throw error;
    }

    const generated = randomBytes(keyBytes);
    try {
      const handle = await open(this.#masterKeyPath, "wx", 0o600);
      try {
        await handle.writeFile(generated);
      } finally {
        await handle.close();
      }
      return generated;
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code !== "EEXIST") throw error;
      const winner = await readFile(this.#masterKeyPath);
      if (winner.length !== keyBytes) {
        throw fail("resolve", secretStoreFailureCodes.permanentFailure);
      }
      return winner;
    }
  }
}
