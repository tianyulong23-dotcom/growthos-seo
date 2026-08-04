import { z } from "zod";

const nonBlankSchema = z.string().min(1).max(2_048)
  .refine((value) => value.trim().length > 0, "Value must not be blank.");
const plaintextSchema = z.string().min(1).max(65_536);

export const secretKinds = {
  oauthPkceVerifier: "OAUTH_PKCE_VERIFIER",
  gmailTokenSet: "GMAIL_TOKEN_SET",
} as const;

export const secretKindSchema = z.enum(Object.values(secretKinds));
export type SecretKind = z.output<typeof secretKindSchema>;

export const secretEncryptionContextSchema = z.object({
  organizationId: nonBlankSchema,
  subjectProvider: z.literal("google"),
  workspaceId: nonBlankSchema.optional(),
  connectionId: nonBlankSchema.optional(),
  oauthAttemptId: nonBlankSchema.optional(),
}).strict();

export type SecretEncryptionContext = Readonly<
  z.output<typeof secretEncryptionContextSchema>
>;

export const secretStoreReferenceSchema = z.object({
  provider: nonBlankSchema,
  secretKind: secretKindSchema,
  externalSecretId: nonBlankSchema,
  externalSecretVersion: nonBlankSchema,
}).strict();

export type SecretStoreReference = Readonly<
  z.output<typeof secretStoreReferenceSchema>
>;

const validateContext = (
  input: Readonly<{
    secretKind: SecretKind;
    context: SecretEncryptionContext;
  }>,
  context: z.RefinementCtx,
) => {
  if (
    input.secretKind === secretKinds.gmailTokenSet
    && input.context.connectionId === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["context", "connectionId"],
      message: "connectionId is required for a Gmail Token Set.",
    });
  }
  if (
    input.secretKind === secretKinds.oauthPkceVerifier
    && (
      input.context.workspaceId === undefined
      || input.context.oauthAttemptId === undefined
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["context"],
      message:
        "workspaceId and oauthAttemptId are required for a PKCE verifier.",
    });
  }
};

export const secretStoreCreateInputSchema = z.object({
  secretKind: secretKindSchema,
  plaintext: plaintextSchema,
  context: secretEncryptionContextSchema,
}).strict().superRefine(validateContext);

export type SecretStoreCreateInput = Readonly<
  z.output<typeof secretStoreCreateInputSchema>
>;

export const secretStoreResolveInputSchema = z.object({
  reference: secretStoreReferenceSchema,
  context: secretEncryptionContextSchema,
}).strict().superRefine((input, context) => {
  validateContext({
    secretKind: input.reference.secretKind,
    context: input.context,
  }, context);
});

export type SecretStoreResolveInput = Readonly<
  z.output<typeof secretStoreResolveInputSchema>
>;

export const secretStoreRotateInputSchema = z.object({
  reference: secretStoreReferenceSchema,
  plaintext: plaintextSchema,
  context: secretEncryptionContextSchema,
}).strict().superRefine((input, context) => {
  validateContext({
    secretKind: input.reference.secretKind,
    context: input.context,
  }, context);
});

export type SecretStoreRotateInput = Readonly<
  z.output<typeof secretStoreRotateInputSchema>
>;

export const secretStoreDestroyInputSchema = secretStoreResolveInputSchema;
export type SecretStoreDestroyInput = SecretStoreResolveInput;

export type SecretStoreDestroyResult = Readonly<{
  destroyed: true;
}>;

export const secretStoreOperations = [
  "create",
  "resolve",
  "rotate",
  "destroy",
] as const;
export type SecretStoreOperation = (typeof secretStoreOperations)[number];

export const secretStoreFailureCodes = {
  disabled: "SECRET_STORE_DISABLED",
  invalidRequest: "SECRET_STORE_INVALID_REQUEST",
  notFound: "SECRET_STORE_NOT_FOUND",
  timeout: "SECRET_STORE_TIMEOUT",
  temporaryFailure: "SECRET_STORE_TEMPORARY_FAILURE",
  permanentFailure: "SECRET_STORE_PERMANENT_FAILURE",
} as const;

export type SecretStoreFailureCode =
  (typeof secretStoreFailureCodes)[keyof typeof secretStoreFailureCodes];

export const secretStoreFailureRetryability = {
  [secretStoreFailureCodes.disabled]: false,
  [secretStoreFailureCodes.invalidRequest]: false,
  [secretStoreFailureCodes.notFound]: false,
  [secretStoreFailureCodes.timeout]: true,
  [secretStoreFailureCodes.temporaryFailure]: true,
  [secretStoreFailureCodes.permanentFailure]: false,
} as const satisfies Record<SecretStoreFailureCode, boolean>;

export type SecretStoreFailure = Readonly<{
  operation: SecretStoreOperation;
  code: SecretStoreFailureCode;
  retryable: boolean;
}>;

export class SecretStoreError extends Error {
  readonly operation: SecretStoreOperation;
  readonly code: SecretStoreFailureCode;
  readonly retryable: boolean;

  constructor(failure: SecretStoreFailure, options?: ErrorOptions) {
    super(
      `Secret Store ${failure.operation} failed with ${failure.code}.`,
      options,
    );
    this.name = "SecretStoreError";
    this.operation = failure.operation;
    this.code = failure.code;
    this.retryable = failure.retryable;
  }
}

export interface SecretStorePort {
  create(input: SecretStoreCreateInput): Promise<SecretStoreReference>;
  resolve(input: SecretStoreResolveInput): Promise<string>;
  rotate(input: SecretStoreRotateInput): Promise<SecretStoreReference>;
  destroy(
    input: SecretStoreDestroyInput,
  ): Promise<SecretStoreDestroyResult>;
}
