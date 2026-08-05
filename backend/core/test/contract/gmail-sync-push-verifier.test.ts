import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  GmailPushIdentityVerifier,
  gmailPushIdentityFailureCodes,
  gmailPushWebhookConfigSchema,
  type GmailPushSignedTokenVerifier,
} from "../../src/modules/backlinks/adapters/gmail/sync-push-verifier.js";

const authorization = "Bearer header.payload.signature";
const now = new Date("2026-07-29T04:00:00.000Z");
const expectedAudience = "https://gateway.example.test/gmail-push";
const authorizedEmail = "gmail-push@example-project.iam.gserviceaccount.com";

const verifiedClaims = {
  iss: "https://accounts.google.com",
  sub: "provider-subject-141",
  aud: expectedAudience,
  email: authorizedEmail,
  email_verified: true,
  iat: Math.floor(now.getTime() / 1_000) - 30,
  exp: Math.floor(now.getTime() / 1_000) + 300,
};

const createVerifier = (
  claims: unknown = verifiedClaims,
) => {
  const verifySignedIdToken = vi.fn(async () => claims);
  const verifier: GmailPushSignedTokenVerifier = {
    verifySignedIdToken,
  };
  return {
    verifySignedIdToken,
    verifier: new GmailPushIdentityVerifier({
      config: {
        enabled: true,
        expectedAudience,
        authorizedServiceAccountEmail: authorizedEmail,
      },
      verifier,
      now: () => now,
    }),
  };
};

describe("BL-AI-141 Gmail Push identity verifier", () => {
  it("defaults off and never invokes the signed-token verifier", async () => {
    const verifySignedIdToken = vi.fn(async () => verifiedClaims);
    const verifier = new GmailPushIdentityVerifier({
      verifier: { verifySignedIdToken },
    });

    await expect(verifier.verify(authorization)).rejects.toMatchObject({
      code: gmailPushIdentityFailureCodes.disabled,
      retryable: false,
    });
    expect(verifySignedIdToken).not.toHaveBeenCalled();
    expect(gmailPushWebhookConfigSchema.parse({})).toEqual({
      enabled: false,
    });
  });

  it("requires explicit audience, sender, and verifier when enabled", () => {
    expect(() => new GmailPushIdentityVerifier({
      config: { enabled: true },
    })).toThrow(expect.objectContaining({
      code: gmailPushIdentityFailureCodes.misconfigured,
    }));
  });

  it("accepts only a cryptographically verified authorized identity", async () => {
    const fake = createVerifier();

    await expect(fake.verifier.verify(authorization)).resolves.toBeUndefined();
    expect(fake.verifySignedIdToken).toHaveBeenCalledWith(
      "header.payload.signature",
    );
  });

  it.each([
    ["missing header", undefined],
    ["multiple headers", ["Bearer a.b.c", "Bearer d.e.f"]],
    ["wrong scheme", "Basic a.b.c"],
    ["malformed JWT", "Bearer not-a-jwt"],
  ])("rejects %s before provider verification", async (_name, header) => {
    const fake = createVerifier();

    await expect(fake.verifier.verify(header)).rejects.toMatchObject({
      code: gmailPushIdentityFailureCodes.unauthenticated,
    });
    expect(fake.verifySignedIdToken).not.toHaveBeenCalled();
  });

  it.each([
    ["issuer", { ...verifiedClaims, iss: "https://forged.example.test" }],
    ["audience", { ...verifiedClaims, aud: "https://wrong.example.test" }],
    ["email", { ...verifiedClaims, email: "attacker@example.test" }],
    ["email verification", { ...verifiedClaims, email_verified: false }],
    ["expiry", { ...verifiedClaims, exp: verifiedClaims.iat }],
    ["issued-at", {
      ...verifiedClaims,
      iat: Math.floor(now.getTime() / 1_000) + 120,
    }],
  ])("rejects invalid %s claims", async (_name, claims) => {
    const fake = createVerifier(claims);

    await expect(fake.verifier.verify(authorization)).rejects.toMatchObject({
      code: gmailPushIdentityFailureCodes.unauthenticated,
    });
  });

  it("fails closed when signature verification rejects", async () => {
    const verifySignedIdToken = vi.fn(async () => {
      throw new Error("forged signature");
    });
    const verifier = new GmailPushIdentityVerifier({
      config: {
        enabled: true,
        expectedAudience,
        authorizedServiceAccountEmail: authorizedEmail,
      },
      verifier: { verifySignedIdToken },
      now: () => now,
    });

    await expect(verifier.verify(authorization)).rejects.toMatchObject({
      code: gmailPushIdentityFailureCodes.unauthenticated,
      message: "Gmail Push identity verification failed.",
    });
  });

  it("contains no network or Gmail SDK implementation", () => {
    const source = readFileSync(new URL(
      "../../src/modules/backlinks/adapters/gmail/sync-push-verifier.ts",
      import.meta.url,
    ), "utf8");

    expect(source).not.toMatch(
      /\bfetch\s*\(|undici|axios|google-auth-library|@googleapis\/gmail/iu,
    );
  });
});
