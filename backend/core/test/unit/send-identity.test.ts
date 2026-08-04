import { describe, expect, it } from "vitest";

import {
  SendIdentityAuthorizationError,
  authorizeSendIdentity,
  createGoogleSendAsIdentity,
  createOidcPrimarySendIdentity,
  sendIdentityAuthorizationErrorCodes,
  type SendIdentityConnection,
} from "../../src/modules/backlinks/domain/sending/identity.js";

const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;

const organizationId = id(1);
const gmailConnectionId = id(2);
const connection: SendIdentityConnection = {
  organizationId,
  gmailConnectionId,
  connectionStatus: "CONNECTED",
  sendAvailability: "AVAILABLE",
};

const primaryIdentity = () =>
  createOidcPrimarySendIdentity({
    identityId: id(101),
    organizationId,
    gmailConnectionId,
    emailAddress: " Owner@Example.test ",
    displayName: " Owner ",
    emailVerified: true,
    observedAt: "2026-07-27T06:00:00.000Z",
    version: 1,
  });

const acceptedAlias = () =>
  createGoogleSendAsIdentity({
    identityId: id(102),
    organizationId,
    gmailConnectionId,
    emailAddress: "Alias@Example.test",
    displayName: "Outreach",
    isPrimary: false,
    isDefault: false,
    verificationStatus: "accepted",
    treatAsAlias: true,
    observedAt: "2026-07-27T06:01:00.000Z",
    version: 2,
  });

const pendingAlias = () =>
  createGoogleSendAsIdentity({
    identityId: id(103),
    organizationId,
    gmailConnectionId,
    emailAddress: "pending@example.test",
    displayName: null,
    isPrimary: false,
    isDefault: false,
    verificationStatus: "pending",
    treatAsAlias: true,
    observedAt: "2026-07-27T06:02:00.000Z",
    version: 1,
  });

const expectCode = (
  operation: () => unknown,
  code: string,
) => {
  try {
    operation();
    throw new Error("Expected SendIdentityAuthorizationError.");
  } catch (error) {
    expect(error).toBeInstanceOf(SendIdentityAuthorizationError);
    expect(error).toMatchObject({ code });
  }
};

describe("BL-AI-106 SendIdentity authorization", () => {
  it("creates only a verified OIDC primary identity and normalizes its address", () => {
    const identity = primaryIdentity();

    expect(identity).toEqual({
      identityId: id(101),
      organizationId,
      gmailConnectionId,
      emailAddress: "owner@example.test",
      displayName: "Owner",
      isPrimary: true,
      isDefault: true,
      verificationStatus: "accepted",
      treatAsAlias: false,
      source: "OIDC_PRIMARY",
      observedAt: "2026-07-27T06:00:00.000Z",
      version: 1,
    });
    expect(Object.isFrozen(identity)).toBe(true);

    expectCode(
      () =>
        createOidcPrimarySendIdentity({
          identityId: id(104),
          organizationId,
          gmailConnectionId,
          emailAddress: "unverified@example.test",
          displayName: null,
          emailVerified: false,
          observedAt: "2026-07-27T06:00:00.000Z",
          version: 1,
        }),
      sendIdentityAuthorizationErrorCodes.identityNotVerified,
    );
    expectCode(
      () =>
        createOidcPrimarySendIdentity({
          identityId: id(105),
          organizationId,
          gmailConnectionId,
          emailAddress: "owner@example.test\r\nBcc: attacker@example.test",
          displayName: null,
          emailVerified: true,
          observedAt: "2026-07-27T06:00:00.000Z",
          version: 1,
        }),
      sendIdentityAuthorizationErrorCodes.invalidIdentity,
    );
  });

  it("derives From from an accepted current identity and authorizes Reply-To from the same list", () => {
    const primary = primaryIdentity();
    const alias = acceptedAlias();

    const authorized = authorizeSendIdentity({
      connection,
      identities: [primary, alias, pendingAlias()],
      fromIdentityId: alias.identityId,
      requestedFromAddress: " ALIAS@example.test ",
      requestedReplyTo: " OWNER@example.test ",
    });

    expect(authorized).toEqual({
      from: {
        identityId: alias.identityId,
        emailAddress: "alias@example.test",
        displayName: "Outreach",
        identityVersion: 2,
      },
      replyTo: {
        identityId: primary.identityId,
        emailAddress: "owner@example.test",
        identityVersion: 1,
      },
    });
    expect(Object.isFrozen(authorized)).toBe(true);
    expect(Object.isFrozen(authorized.from)).toBe(true);
    expect(Object.isFrozen(authorized.replyTo)).toBe(true);
  });

  it("rejects pending, cross-connection, and arbitrary From or Reply-To values", () => {
    const primary = primaryIdentity();
    const alias = acceptedAlias();
    const foreign = createGoogleSendAsIdentity({
      ...acceptedAlias(),
      identityId: id(201),
      gmailConnectionId: id(202),
    });

    expectCode(
      () =>
        authorizeSendIdentity({
          connection,
          identities: [primary, pendingAlias()],
          fromIdentityId: id(103),
        }),
      sendIdentityAuthorizationErrorCodes.fromNotAuthorized,
    );
    expectCode(
      () =>
        authorizeSendIdentity({
          connection,
          identities: [primary, foreign],
          fromIdentityId: foreign.identityId,
        }),
      sendIdentityAuthorizationErrorCodes.fromNotAuthorized,
    );
    expectCode(
      () =>
        authorizeSendIdentity({
          connection,
          identities: [primary, alias],
          fromIdentityId: alias.identityId,
          requestedFromAddress: "spoofed@example.test",
        }),
      sendIdentityAuthorizationErrorCodes.fromNotAuthorized,
    );
    expectCode(
      () =>
        authorizeSendIdentity({
          connection,
          identities: [primary, alias],
          fromIdentityId: primary.identityId,
          requestedReplyTo: "external@example.test",
        }),
      sendIdentityAuthorizationErrorCodes.replyToNotAuthorized,
    );
  });

  it.each([
    {
      connectionStatus: "REAUTH_REQUIRED" as const,
      sendAvailability: "AVAILABLE" as const,
    },
    {
      connectionStatus: "DISCONNECTED" as const,
      sendAvailability: "PAUSED" as const,
    },
    {
      connectionStatus: "CONNECTED" as const,
      sendAvailability: "PAUSED" as const,
    },
  ])(
    "rejects a connection that is not currently sendable: %s",
    (connectionState) => {
      expectCode(
        () =>
          authorizeSendIdentity({
            connection: { ...connection, ...connectionState },
            identities: [primaryIdentity()],
            fromIdentityId: id(101),
          }),
        sendIdentityAuthorizationErrorCodes.connectionUnavailable,
      );
    },
  );
});
