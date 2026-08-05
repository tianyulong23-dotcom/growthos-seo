import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  InvalidOAuthStateError,
  OAuthAttemptService,
  gmailOAuthScopes,
} from "../../src/modules/backlinks/domain/sending/oauth-attempt.js";
import type {
  NewOAuthAttempt,
  OAuthAttemptCleanupInput,
  OAuthAttemptConsumeInput,
  OAuthAttemptRepository,
  ConsumedOAuthAttempt,
} from "../../src/modules/backlinks/domain/sending/oauth-attempt-repository.js";

type StoredAttempt = {
  readonly creation: NewOAuthAttempt;
  consumedAt: Date | null;
};

class FakeOAuthAttemptRepository implements OAuthAttemptRepository {
  readonly attempts = new Map<string, StoredAttempt>();
  readonly cleanupInputs: OAuthAttemptCleanupInput[] = [];

  async create(input: NewOAuthAttempt): Promise<void> {
    if (this.attempts.has(input.stateHash)) {
      throw new Error("Duplicate OAuth state hash");
    }
    this.attempts.set(input.stateHash, {
      creation: {
        ...input,
        requestedScopes: Object.freeze([...input.requestedScopes]),
      },
      consumedAt: null,
    });
  }

  async cleanupExpired(input: OAuthAttemptCleanupInput): Promise<number> {
    this.cleanupInputs.push(input);
    let cleaned = 0;
    for (const [stateHash, stored] of this.attempts) {
      if (
        stored.creation.organizationId === input.organizationId
        && stored.creation.workspaceId === input.workspaceId
        && stored.creation.websiteProjectId === input.websiteProjectId
        && stored.consumedAt === null
        && stored.creation.expiresAt.getTime() <= input.expiredAt.getTime()
      ) {
        this.attempts.delete(stateHash);
        cleaned += 1;
      }
    }
    return cleaned;
  }

  async consume(
    input: OAuthAttemptConsumeInput,
  ): Promise<ConsumedOAuthAttempt | null> {
    const stored = this.attempts.get(input.stateHash);
    if (
      stored === undefined
      || stored.creation.organizationId !== input.organizationId
      || stored.creation.workspaceId !== input.workspaceId
      || stored.creation.websiteProjectId !== input.websiteProjectId
      || stored.creation.initiatedByUserId !== input.initiatedByUserId
      || stored.creation.sessionBindingHash !== input.sessionBindingHash
      || stored.consumedAt !== null
      || stored.creation.expiresAt.getTime() <= input.consumedAt.getTime()
    ) {
      return null;
    }

    stored.consumedAt = new Date(input.consumedAt);
    return {
      attemptId: stored.creation.id,
      pkceVerifier: stored.creation.pkceVerifier,
      requestedScopes: stored.creation.requestedScopes,
      redirectUri: stored.creation.redirectUri,
      returnPath: stored.creation.returnPath,
    };
  }
}

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const sha256Base64Url = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
const id = (value: number) =>
  `018f0000-0000-7000-8000-${String(value).padStart(12, "0")}`;

const context = {
  organizationId: id(1),
  workspaceId: id(2),
  websiteProjectId: id(3),
  initiatedByUserId: "user-100",
  sessionBinding: "browser-session-100",
} as const;
const redirectUri = "https://app.example.com/api/backlinks/gmail/callback";
const returnPath = "/backlinks/settings/connections";

const setup = () => {
  const repository = new FakeOAuthAttemptRepository();
  let now = new Date("2026-07-27T03:00:00.000Z");
  let nextId = 100;
  const service = new OAuthAttemptService({
    repository,
    now: () => new Date(now),
    newId: () => id(nextId++),
  });

  return {
    repository,
    service,
    setNow(value: string) {
      now = new Date(value);
    },
  };
};

const begin = (service: OAuthAttemptService) =>
  service.begin({ ...context, redirectUri, returnPath });
const expectInvalidState = async (operation: Promise<unknown>) => {
  await expect(operation).rejects.toMatchObject({
    name: "InvalidOAuthStateError",
    code: "INVALID_OAUTH_STATE",
    message: "OAuth state is invalid or unavailable.",
  });
};

describe("BL-AI-100 OAuth attempt", () => {
  it("creates a 256-bit hashed state and S256 PKCE challenge for ten minutes", async () => {
    const { repository, service } = setup();

    const started = await begin(service);
    const stored = [...repository.attempts.values()][0];

    expect(stored).toBeDefined();
    expect(Buffer.from(started.state, "base64url")).toHaveLength(32);
    expect(started.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(started.codeChallengeMethod).toBe("S256");
    expect(started.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(started.expiresAt.toISOString()).toBe("2026-07-27T03:10:00.000Z");
    expect(started.requestedScopes).toEqual(gmailOAuthScopes);
    expect(started).not.toHaveProperty("pkceVerifier");

    expect(stored?.creation.stateHash).toBe(sha256Hex(started.state));
    expect(stored?.creation).not.toHaveProperty("state");
    expect(stored?.creation.sessionBindingHash).toBe(
      sha256Hex(context.sessionBinding),
    );
    expect(stored?.creation).not.toHaveProperty("sessionBinding");
    expect(stored?.creation.pkceVerifier).toMatch(
      /^[A-Za-z0-9_-]{43}$/u,
    );
    expect(started.codeChallenge).toBe(
      sha256Base64Url(stored?.creation.pkceVerifier ?? ""),
    );
    expect(repository.cleanupInputs).toEqual([{
      organizationId: context.organizationId,
      workspaceId: context.workspaceId,
      websiteProjectId: context.websiteProjectId,
      cleanedByUserId: context.initiatedByUserId,
      expiredAt: new Date("2026-07-27T03:00:00.000Z"),
    }]);
  });

  it("rejects forged and replayed state with one non-secret error", async () => {
    const { service } = setup();
    const started = await begin(service);

    await expectInvalidState(service.consume({
      ...context,
      state: "forged-oauth-state",
    }));

    const consumed = await service.consume({
      ...context,
      state: started.state,
    });
    expect(consumed.pkceVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);

    await expectInvalidState(service.consume({
      ...context,
      state: started.state,
    }));
    expect(new InvalidOAuthStateError().message).not.toContain(started.state);
    expect(new InvalidOAuthStateError().message).not.toContain(
      consumed.pkceVerifier,
    );
  });

  it("rejects state at or after its expiry", async () => {
    const { service, setNow } = setup();
    const started = await begin(service);

    setNow("2026-07-27T03:10:00.000Z");

    await expectInvalidState(service.consume({
      ...context,
      state: started.state,
    }));
  });

  it("rejects cross-tenant, cross-user, and cross-session callbacks", async () => {
    const { service } = setup();
    const started = await begin(service);
    const invalidContexts = [
      { ...context, organizationId: id(11) },
      { ...context, workspaceId: id(12) },
      { ...context, websiteProjectId: id(13) },
      { ...context, initiatedByUserId: "user-101" },
      { ...context, sessionBinding: "browser-session-101" },
    ];

    for (const invalidContext of invalidContexts) {
      await expectInvalidState(service.consume({
        ...invalidContext,
        state: started.state,
      }));
    }

    await expect(service.consume({
      ...context,
      state: started.state,
    })).resolves.toMatchObject({
      redirectUri,
      returnPath,
      requestedScopes: gmailOAuthScopes,
    });
  });

  it("keeps parallel attempts independently consumable", async () => {
    const { repository, service } = setup();
    const [first, second] = await Promise.all([
      begin(service),
      begin(service),
    ]);

    expect(first.state).not.toBe(second.state);
    expect(repository.attempts.size).toBe(2);
    await expect(service.consume({
      ...context,
      state: first.state,
    })).resolves.toBeDefined();
    await expect(service.consume({
      ...context,
      state: second.state,
    })).resolves.toBeDefined();
  });

  it("allows only one winner when the same state is consumed concurrently", async () => {
    const { service } = setup();
    const started = await begin(service);

    const results = await Promise.allSettled([
      service.consume({ ...context, state: started.state }),
      service.consume({ ...context, state: started.state }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(InvalidOAuthStateError);
  });
});
