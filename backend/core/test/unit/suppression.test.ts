import { describe, expect, it } from "vitest";

import {
  SuppressionTargetError,
  createEmailSuppressionTarget,
  createEmailSuppressionTargets,
  normalizeSuppressionEmail,
  suppressionEmailNormalizationPolicy,
  suppressionTargetErrorCodes,
} from "../../src/modules/backlinks/domain/sending/suppression.js";

const key = (version: number, fill: number) => ({
  version,
  secret: Buffer.alloc(32, fill),
});

const expectCode = (operation: () => unknown, code: string) => {
  try {
    operation();
    throw new Error("Expected SuppressionTargetError.");
  } catch (error) {
    expect(error).toBeInstanceOf(SuppressionTargetError);
    expect(error).toMatchObject({ code });
  }
};

describe("BL-AI-108 email suppression targets", () => {
  it("uses the send identity casing rules and persists only a versioned HMAC", () => {
    const plaintext = " Person+News@Example.TEST ";
    const target = createEmailSuppressionTarget(plaintext, key(7, 0x31));

    expect(normalizeSuppressionEmail(plaintext)).toBe(
      "person+news@example.test",
    );
    expect(target).toEqual({
      targetType: "EMAIL",
      targetHmac: expect.stringMatching(/^[a-f0-9]{64}$/u),
      hashKeyVersion: 7,
    });
    expect(JSON.stringify(target)).not.toContain("person+news@example.test");
    expect(Object.isFrozen(target)).toBe(true);
    expect(suppressionEmailNormalizationPolicy).toEqual({
      version: "suppression-email-exact-lowercase-v1",
      casing: "ASCII_LOWERCASE",
      outerWhitespace: "TRIM",
      plusAliases: "PRESERVE",
      dotAliases: "PRESERVE",
    });
  });

  it("normalizes case deterministically without collapsing provider aliases", () => {
    const hmacKey = key(3, 0x52);
    expect(
      createEmailSuppressionTarget("Person@Example.test", hmacKey),
    ).toEqual(
      createEmailSuppressionTarget(" person@EXAMPLE.TEST ", hmacKey),
    );

    const plain = createEmailSuppressionTarget(
      "person@gmail.com",
      hmacKey,
    );
    const plusAlias = createEmailSuppressionTarget(
      "person+outreach@gmail.com",
      hmacKey,
    );
    const dottedAlias = createEmailSuppressionTarget(
      "per.son@gmail.com",
      hmacKey,
    );
    expect(plusAlias.targetHmac).not.toBe(plain.targetHmac);
    expect(dottedAlias.targetHmac).not.toBe(plain.targetHmac);
  });

  it("supports current and legacy key versions without exposing plaintext", () => {
    const plaintext = "rotation@example.test";
    const targets = createEmailSuppressionTargets(plaintext, [
      key(2, 0x22),
      key(1, 0x11),
    ]);

    expect(targets.map((target) => target.hashKeyVersion)).toEqual([2, 1]);
    expect(targets[0]?.targetHmac).not.toBe(targets[1]?.targetHmac);
    expect(JSON.stringify(targets)).not.toContain(plaintext);
    expect(Object.isFrozen(targets)).toBe(true);
  });

  it("rejects invalid mailboxes, weak keys, and duplicate key versions generically", () => {
    const injected = "victim@example.test\r\nBcc: attacker@example.test";
    expectCode(
      () => createEmailSuppressionTarget(injected, key(1, 0x11)),
      suppressionTargetErrorCodes.invalidEmail,
    );
    expectCode(
      () =>
        createEmailSuppressionTarget(
          "person@example.test",
          { version: 1, secret: Buffer.alloc(16) },
        ),
      suppressionTargetErrorCodes.invalidHmacKey,
    );
    expectCode(
      () =>
        createEmailSuppressionTargets("person@example.test", [
          key(1, 0x11),
          key(1, 0x22),
        ]),
      suppressionTargetErrorCodes.duplicateKeyVersion,
    );

    try {
      createEmailSuppressionTarget(injected, key(1, 0x11));
    } catch (error) {
      expect(String(error)).not.toContain("victim@example.test");
      expect(String(error)).not.toContain("attacker@example.test");
    }
  });
});
