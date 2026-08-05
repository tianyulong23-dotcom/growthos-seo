import { createHmac } from "node:crypto";

import { normalizeSendIdentityEmail } from "./identity.js";

export const suppressionEmailNormalizationPolicy = Object.freeze({
  version: "suppression-email-exact-lowercase-v1",
  casing: "ASCII_LOWERCASE",
  outerWhitespace: "TRIM",
  plusAliases: "PRESERVE",
  dotAliases: "PRESERVE",
} as const);

export type SuppressionHmacKey = Readonly<{
  version: number;
  secret: Uint8Array;
}>;

export type EmailSuppressionTarget = Readonly<{
  targetType: "EMAIL";
  targetHmac: string;
  hashKeyVersion: number;
}>;

export const suppressionTargetErrorCodes = Object.freeze({
  invalidEmail: "SUPPRESSION_EMAIL_INVALID",
  invalidHmacKey: "SUPPRESSION_HMAC_KEY_INVALID",
  duplicateKeyVersion: "SUPPRESSION_HMAC_KEY_VERSION_DUPLICATE",
  invalidTarget: "SUPPRESSION_TARGET_INVALID",
} as const);

export type SuppressionTargetErrorCode =
  (typeof suppressionTargetErrorCodes)[keyof typeof suppressionTargetErrorCodes];

const errorMessages: Readonly<Record<SuppressionTargetErrorCode, string>> =
  Object.freeze({
    SUPPRESSION_EMAIL_INVALID: "The suppression email is invalid.",
    SUPPRESSION_HMAC_KEY_INVALID: "The suppression HMAC key is invalid.",
    SUPPRESSION_HMAC_KEY_VERSION_DUPLICATE:
      "Suppression HMAC key versions must be unique.",
    SUPPRESSION_TARGET_INVALID: "The suppression target is invalid.",
  });

export class SuppressionTargetError extends Error {
  readonly code: SuppressionTargetErrorCode;

  constructor(code: SuppressionTargetErrorCode) {
    super(errorMessages[code]);
    this.name = "SuppressionTargetError";
    this.code = code;
  }
}

export const normalizeSuppressionEmail = (value: string): string => {
  try {
    return normalizeSendIdentityEmail(value);
  } catch {
    throw new SuppressionTargetError(
      suppressionTargetErrorCodes.invalidEmail,
    );
  }
};

const assertHmacKey = (key: SuppressionHmacKey): void => {
  if (
    !Number.isSafeInteger(key.version)
    || key.version < 1
    || !(key.secret instanceof Uint8Array)
    || key.secret.byteLength < 32
  ) {
    throw new SuppressionTargetError(
      suppressionTargetErrorCodes.invalidHmacKey,
    );
  }
};

const hashNormalizedEmail = (
  normalizedEmail: string,
  key: SuppressionHmacKey,
): EmailSuppressionTarget => {
  assertHmacKey(key);
  const preimage =
    `growthos:backlinks:suppression:email:v1:key-${key.version}\u0000`
    + normalizedEmail;
  return Object.freeze({
    targetType: "EMAIL",
    targetHmac: createHmac("sha256", Buffer.from(key.secret))
      .update(preimage, "utf8")
      .digest("hex"),
    hashKeyVersion: key.version,
  });
};

export const createEmailSuppressionTarget = (
  email: string,
  key: SuppressionHmacKey,
): EmailSuppressionTarget =>
  hashNormalizedEmail(normalizeSuppressionEmail(email), key);

export const createEmailSuppressionTargets = (
  email: string,
  keys: readonly SuppressionHmacKey[],
): readonly EmailSuppressionTarget[] => {
  if (keys.length === 0) {
    throw new SuppressionTargetError(
      suppressionTargetErrorCodes.invalidHmacKey,
    );
  }

  const normalizedEmail = normalizeSuppressionEmail(email);
  const versions = new Set<number>();
  const targets = keys.map((key) => {
    if (versions.has(key.version)) {
      throw new SuppressionTargetError(
        suppressionTargetErrorCodes.duplicateKeyVersion,
      );
    }
    versions.add(key.version);
    return hashNormalizedEmail(normalizedEmail, key);
  });
  return Object.freeze(targets);
};

export const assertEmailSuppressionTarget = (
  target: EmailSuppressionTarget,
): void => {
  if (
    target.targetType !== "EMAIL"
    || !/^[a-f0-9]{64}$/u.test(target.targetHmac)
    || !Number.isSafeInteger(target.hashKeyVersion)
    || target.hashKeyVersion < 1
  ) {
    throw new SuppressionTargetError(
      suppressionTargetErrorCodes.invalidTarget,
    );
  }
};
