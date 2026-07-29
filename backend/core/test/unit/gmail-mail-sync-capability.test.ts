import { describe, expect, it, vi } from "vitest";

import {
  GmailMailSyncCapabilityError,
  gmailMailSyncCapabilityErrorCodes,
  runAfterGmailMailSyncCapabilityGate,
} from "../../src/modules/backlinks/domain/replies/gmail-mail-sync-capability.js";
import {
  gmailMailReadScope,
  gmailOAuthScopes,
} from "../../src/modules/backlinks/domain/sending/oauth-attempt.js";

const connection = (
  overrides: Partial<
    Parameters<typeof runAfterGmailMailSyncCapabilityGate>[0]
  > = {},
) => ({
  connectionStatus: "CONNECTED" as const,
  grantedScopes: gmailOAuthScopes,
  mailSyncCapability: true,
  ...overrides,
});

describe("BL-AI-124 Gmail mail sync capability", () => {
  it("binds the minimal readonly scope to the persisted capability marker", async () => {
    const operation = vi.fn(async () => "sync-started");

    await expect(
      runAfterGmailMailSyncCapabilityGate(connection(), operation),
    ).resolves.toBe("sync-started");
    expect(operation).toHaveBeenCalledOnce();
    expect(gmailOAuthScopes).toContain(gmailMailReadScope);
  });

  it("fails explicitly before the sync action when readonly scope capability is absent", async () => {
    const operation = vi.fn(async () => "must-not-run");

    await expect(
      runAfterGmailMailSyncCapabilityGate(
        connection({
          grantedScopes: gmailOAuthScopes.filter(
            (scope) => scope !== gmailMailReadScope,
          ),
          mailSyncCapability: false,
        }),
        operation,
      ),
    ).rejects.toMatchObject({
      code: gmailMailSyncCapabilityErrorCodes.scopeMissing,
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it("rejects a connection projection whose marker does not match its granted scopes", async () => {
    const operation = vi.fn(async () => "must-not-run");

    await expect(
      runAfterGmailMailSyncCapabilityGate(
        connection({ mailSyncCapability: false }),
        operation,
      ),
    ).rejects.toBeInstanceOf(GmailMailSyncCapabilityError);
    expect(operation).not.toHaveBeenCalled();
  });
});
