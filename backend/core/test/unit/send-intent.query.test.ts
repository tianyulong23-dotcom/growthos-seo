import { describe, expect, it, vi } from "vitest";

import {
  createSendIntentQuery,
} from "../../src/modules/backlinks/application/queries/send-intent.query.js";
import {
  createActorContext,
  createProjectContext,
  createTenantContext,
} from "../../src/modules/backlinks/domain/context/index.js";

const context = {
  actor: createActorContext({
    userId: "user-send-query",
    sessionId: "session-send-query",
    roles: ["member"],
  }),
  tenant: createTenantContext({
    organizationId: "organization-send-query",
    workspaceId: "workspace-send-query",
  }),
  project: createProjectContext({
    websiteProjectId: "project-send-query",
    canonicalDomain: "example.com",
    locale: "en-US",
    countryCode: "US",
    profileVersionId: "profile-send-query",
    promotionTargetVersionId: "target-send-query",
  }),
};

const immutableEnvelopeRow = {
  opportunityId: "018f0000-0000-7000-8000-000000000814",
  approvedDraftVersionId: "018f0000-0000-7000-8000-000000000414",
  messagePurpose: "INITIAL_OUTREACH",
  followUpIndex: 0,
  sendSnapshotId: "018f0000-0000-7000-8000-000000000216",
  gmailConnectionId: "018f0000-0000-7000-8000-000000000514",
  gmailAccountEmail: "account@example.test",
  gmailIdentityId: "018f0000-0000-7000-8000-000000000516",
  fromAddress: "sender@example.test",
  recipient: "recipient@example.test",
  snapshotContactId: "018f0000-0000-7000-8000-000000000614",
  snapshotContactVersion: 3,
  approvalRecordedAt: new Date("2026-08-03T00:59:00.000Z"),
};

describe("Send Intent query", () => {
  it("returns the latest persisted attempt and immutable delivery envelope", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        ...immutableEnvelopeRow,
        sendIntentId: "018f0000-0000-7000-8000-000000000114",
        draftId: "018f0000-0000-7000-8000-000000000314",
        status: "PROVIDER_ACCEPTED",
        version: 3,
        requestedSendAt: new Date("2026-08-03T01:00:00.000Z"),
        updatedAt: new Date("2026-08-03T01:00:02.000Z"),
        attemptId: "018f0000-0000-7000-8000-000000000714",
        attemptNo: 1,
        attemptStatus: "PROVIDER_ACCEPTED",
        rfcMessageId: "<send-114@example.com>",
        providerMessageId: "gmail-message-114",
        providerThreadId: "gmail-thread-114",
        errorCode: null,
        startedAt: new Date("2026-08-03T01:00:01.000Z"),
        completedAt: new Date("2026-08-03T01:00:02.000Z"),
        retryEligibleAt: null,
      }],
    }));

    const result = await createSendIntentQuery(
      { query },
      {
        buildIdentity: "build-phase9",
        workerMode: async () => "normal",
      },
    ).getSendIntent(
      context,
      "018f0000-0000-7000-8000-000000000114",
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("backlink_send_attempts"),
      [
        "organization-send-query",
        "workspace-send-query",
        "project-send-query",
        "018f0000-0000-7000-8000-000000000114",
      ],
    );
    expect(result).toEqual({
      sendIntentId: "018f0000-0000-7000-8000-000000000114",
      opportunityId: "018f0000-0000-7000-8000-000000000814",
      draftId: "018f0000-0000-7000-8000-000000000314",
      approvedDraftVersionId:
        "018f0000-0000-7000-8000-000000000414",
      messagePurpose: "INITIAL_OUTREACH",
      followUpIndex: 0,
      status: "PROVIDER_ACCEPTED",
      queueKind: "WAITING_REPLY",
      version: 3,
      requestedSendAt: "2026-08-03T01:00:00.000Z",
      updatedAt: "2026-08-03T01:00:02.000Z",
      deliveryEnvelope: {
        sendSnapshotId: "018f0000-0000-7000-8000-000000000216",
        gmailConnectionId: "018f0000-0000-7000-8000-000000000514",
        gmailAccountEmail: "account@example.test",
        gmailIdentityId: "018f0000-0000-7000-8000-000000000516",
        fromAddress: "sender@example.test",
        recipient: "recipient@example.test",
        contactId: "018f0000-0000-7000-8000-000000000614",
        contactVersion: 3,
        approvalRecordedAt: "2026-08-03T00:59:00.000Z",
      },
      diagnostics: {
        operationId: "018f0000-0000-7000-8000-000000000114",
        operationCheckpoint: "PROVIDER_ACCEPTANCE_PERSISTED",
        retryable: false,
        resubmittable: false,
        nextRetryAt: null,
        costUncertainty: "NONE",
        workerMode: "normal",
        buildIdentity: "build-phase9",
        primaryNextAction: "START_OR_CONTINUE_SYNC",
      },
      attempt: {
        attemptId: "018f0000-0000-7000-8000-000000000714",
        attemptNo: 1,
        status: "PROVIDER_ACCEPTED",
        rfcMessageId: "<send-114@example.com>",
        providerMessageId: "gmail-message-114",
        providerThreadId: "gmail-thread-114",
        errorCode: null,
        startedAt: "2026-08-03T01:00:01.000Z",
        completedAt: "2026-08-03T01:00:02.000Z",
        retryEligibleAt: null,
      },
    });
  });

  it("lists the project-scoped reconciliation queue with stable pagination", async () => {
    const workerMode = vi.fn(async () => "normal" as const);
    const query = vi.fn(async () => ({
      rows: [
        {
          ...immutableEnvelopeRow,
          sendIntentId: "018f0000-0000-7000-8000-000000000115",
          draftId: "018f0000-0000-7000-8000-000000000315",
          status: "DELIVERY_UNKNOWN",
          version: 3,
          requestedSendAt: new Date("2026-08-18T01:00:00.000Z"),
          updatedAt: new Date("2026-08-18T01:00:02.000Z"),
          attemptId: null,
          attemptNo: null,
          attemptStatus: null,
          rfcMessageId: null,
          providerMessageId: null,
          providerThreadId: null,
          errorCode: null,
          startedAt: null,
          completedAt: null,
          retryEligibleAt: null,
        },
        {
          ...immutableEnvelopeRow,
          sendIntentId: "018f0000-0000-7000-8000-000000000117",
          draftId: "018f0000-0000-7000-8000-000000000317",
          status: "DISPATCHING",
          version: 2,
          requestedSendAt: new Date("2026-08-18T00:00:00.000Z"),
          updatedAt: new Date("2026-08-18T00:00:02.000Z"),
          attemptId: null,
          attemptNo: null,
          attemptStatus: null,
          rfcMessageId: null,
          providerMessageId: null,
          providerThreadId: null,
          errorCode: null,
          startedAt: null,
          completedAt: null,
          retryEligibleAt: null,
        },
      ],
    }));

    const result = await createSendIntentQuery(
      { query },
      { buildIdentity: "build-phase10", workerMode },
    ).listSendIntents(context, {
      queueKind: "RECONCILIATION_REQUIRED",
      limit: 1,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("intent.status IN"),
      [
        "organization-send-query",
        "workspace-send-query",
        "project-send-query",
        "RECONCILIATION_REQUIRED",
        null,
        null,
        null,
        2,
      ],
    );
    expect(workerMode).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sendIntentId: "018f0000-0000-7000-8000-000000000115",
      queueKind: "RECONCILIATION_REQUIRED",
      deliveryEnvelope: {
        fromAddress: "sender@example.test",
        recipient: "recipient@example.test",
      },
      diagnostics: {
        primaryNextAction: "RECONCILE_BEFORE_RETRY",
      },
    });
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toEqual(expect.any(String));
  });

  it("requires reconciliation before retrying an accepted-unknown result", async () => {
    const query = createSendIntentQuery(
      {
        query: async () => ({
          rows: [{
            ...immutableEnvelopeRow,
            sendIntentId: "018f0000-0000-7000-8000-000000000115",
            draftId: "018f0000-0000-7000-8000-000000000315",
            status: "DELIVERY_UNKNOWN",
            version: 3,
            requestedSendAt: new Date("2026-08-18T01:00:00.000Z"),
            updatedAt: new Date("2026-08-18T01:00:02.000Z"),
            attemptId: "018f0000-0000-7000-8000-000000000715",
            attemptNo: 1,
            attemptStatus: "DELIVERY_UNKNOWN",
            rfcMessageId: "<send-115@example.com>",
            providerMessageId: null,
            providerThreadId: null,
            errorCode: "GMAIL_ACCEPTANCE_UNKNOWN",
            startedAt: new Date("2026-08-18T01:00:01.000Z"),
            completedAt: new Date("2026-08-18T01:00:02.000Z"),
            retryEligibleAt: null,
          }],
        }),
      },
      {
        buildIdentity: "build-phase9",
        workerMode: async () => "unavailable",
      },
    );

    const result = await query.getSendIntent(
      context,
      "018f0000-0000-7000-8000-000000000115",
    );

    expect(result.diagnostics).toEqual({
      operationId: "018f0000-0000-7000-8000-000000000115",
      operationCheckpoint: "PROVIDER_RESULT_UNKNOWN",
      retryable: false,
      resubmittable: false,
      nextRetryAt: null,
      costUncertainty: "UNKNOWN",
      workerMode: "unavailable",
      buildIdentity: "build-phase9",
      primaryNextAction: "RECONCILE_BEFORE_RETRY",
    });
  });

  it("publishes the persisted retry time and Worker recovery as one action", async () => {
    const retryEligibleAt = new Date("2026-08-18T01:10:00.000Z");
    const query = createSendIntentQuery(
      {
        query: async () => ({
          rows: [{
            ...immutableEnvelopeRow,
            sendIntentId: "018f0000-0000-7000-8000-000000000116",
            draftId: "018f0000-0000-7000-8000-000000000316",
            status: "FAILED_RETRYABLE",
            version: 4,
            requestedSendAt: new Date("2026-08-18T01:00:00.000Z"),
            updatedAt: new Date("2026-08-18T01:00:02.000Z"),
            attemptId: "018f0000-0000-7000-8000-000000000716",
            attemptNo: 1,
            attemptStatus: "FAILED_RETRYABLE",
            rfcMessageId: "<send-116@example.com>",
            providerMessageId: null,
            providerThreadId: null,
            errorCode: "TEMPORARY_FAILURE",
            startedAt: new Date("2026-08-18T01:00:01.000Z"),
            completedAt: new Date("2026-08-18T01:00:02.000Z"),
            retryEligibleAt,
          }],
        }),
      },
      {
        buildIdentity: "build-phase9",
        workerMode: async () => "quiesced",
      },
    );

    const result = await query.getSendIntent(
      context,
      "018f0000-0000-7000-8000-000000000116",
    );

    expect(result.diagnostics).toMatchObject({
      operationCheckpoint: "RETRY_SCHEDULED",
      retryable: true,
      resubmittable: false,
      nextRetryAt: retryEligibleAt.toISOString(),
      workerMode: "quiesced",
      primaryNextAction: "RESTORE_WORKER",
    });
  });

  it("allows a new preflight after Gmail proves the prior message was not sent", async () => {
    const queryClient = vi.fn(async () => ({
      rows: [{
        ...immutableEnvelopeRow,
        sendIntentId: "018f0000-0000-7000-8000-000000000118",
        draftId: "018f0000-0000-7000-8000-000000000318",
        status: "FAILED_FINAL",
        version: 5,
        requestedSendAt: new Date("2026-08-18T01:00:00.000Z"),
        updatedAt: new Date("2026-08-18T01:05:00.000Z"),
        attemptId: "018f0000-0000-7000-8000-000000000718",
        attemptNo: 1,
        attemptStatus: "FAILED_RETRYABLE",
        rfcMessageId: "<send-118@example.com>",
        providerMessageId: null,
        providerThreadId: null,
        errorCode: "GMAIL_SEND_RFC_MESSAGE_NOT_FOUND",
        startedAt: new Date("2026-08-18T01:00:01.000Z"),
        completedAt: new Date("2026-08-18T01:05:00.000Z"),
        retryEligibleAt: null,
      }],
    }));
    const query = createSendIntentQuery(
      { query: queryClient },
      {
        buildIdentity: "build-resubmission",
        workerMode: async () => "normal",
      },
    );

    const result = await query.getSendIntent(
      context,
      "018f0000-0000-7000-8000-000000000118",
    );

    expect(result.diagnostics).toMatchObject({
      operationCheckpoint: "FAILED_FINAL",
      retryable: false,
      resubmittable: true,
      costUncertainty: "NONE",
      primaryNextAction: "RECHECK_BEFORE_RESUBMIT",
    });
  });

  it("can restore the latest persisted Send Intent for one draft", async () => {
    const queryClient = vi.fn(async () => ({ rows: [] }));
    const query = createSendIntentQuery({ query: queryClient });

    await query.listSendIntents(context, {
      draftId: "018f0000-0000-7000-8000-000000000318",
      limit: 1,
    });

    expect(queryClient).toHaveBeenCalledWith(
      expect.stringContaining("intent.draft_id = $5::uuid"),
      [
        "organization-send-query",
        "workspace-send-query",
        "project-send-query",
        null,
        "018f0000-0000-7000-8000-000000000318",
        null,
        null,
        2,
      ],
    );
  });

  it("returns a tenant-scoped not-found error", async () => {
    const query = createSendIntentQuery({
      query: async () => ({ rows: [] }),
    });

    await expect(query.getSendIntent(
      context,
      "018f0000-0000-7000-8000-000000000999",
    )).rejects.toMatchObject({
      code: "BACKLINK_NOT_FOUND",
    });
  });
});
