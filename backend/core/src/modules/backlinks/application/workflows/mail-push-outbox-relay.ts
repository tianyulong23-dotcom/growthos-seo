import { z } from "zod";

import type {
  ClaimedOutboxEvent,
  createOutboxRepository,
} from "../../db/repositories/outbox.repository.js";
import type {
  IncrementalMailSyncContext,
} from "../services/mail-incremental-sync.repository.js";
import {
  runGmailIncrementalSyncWorkflow,
  type GmailIncrementalSyncWorkflowDependencies,
  type GmailIncrementalSyncWorkflowOptions,
} from "./mail-incremental-sync-workflow.js";
import {
  GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
} from "./mail-push-webhook.js";

type RelayRepository = Pick<
  ReturnType<typeof createOutboxRepository>,
  "claim" | "mark"
>;
export type IncrementalSyncStarter = Readonly<{
  start(input: IncrementalMailSyncContext): Promise<unknown>;
}>;

const payloadSchema = z.object({
  contractVersion: z.literal(GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED),
  organizationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  websiteProjectId: z.string().uuid(),
  gmailConnectionId: z.string().uuid(),
  trigger: z.literal("GMAIL_PUSH"),
}).strict();

const parseSyncContext = (
  event: ClaimedOutboxEvent,
): IncrementalMailSyncContext => {
  if (
    event.eventType !== GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED
    || event.payloadSchemaVersion !== 1
    || event.aggregateVersion !== 1
  ) {
    throw new Error("GMAIL_PUSH_OUTBOX_EVENT_INVALID");
  }
  const payload = payloadSchema.parse(event.payload);
  if (
    payload.organizationId !== event.organizationId
    || payload.workspaceId !== event.workspaceId
    || payload.websiteProjectId !== event.websiteProjectId
  ) {
    throw new Error("GMAIL_PUSH_OUTBOX_EVENT_SCOPE_CHANGED");
  }
  return {
    organizationId: payload.organizationId,
    workspaceId: payload.workspaceId,
    websiteProjectId: payload.websiteProjectId,
    gmailConnectionId: payload.gmailConnectionId,
    actorId: "gmail-push-webhook",
  };
};

export function createGmailIncrementalSyncStarter(
  options: Readonly<{
    dependencies: GmailIncrementalSyncWorkflowDependencies;
    workflowOptions?: GmailIncrementalSyncWorkflowOptions;
  }>,
): IncrementalSyncStarter {
  return Object.freeze({
    start: (input) => runGmailIncrementalSyncWorkflow(
      input,
      options.dependencies,
      options.workflowOptions,
    ),
  });
}

export function createGmailPushIncrementalSyncOutboxRelay(
  options: Readonly<{
    repository: RelayRepository;
    incrementalSyncStarter: IncrementalSyncStarter;
    retryAt?: () => Date;
  }>,
) {
  const retryAt = options.retryAt ?? (() => new Date(Date.now() + 5_000));
  return {
    async runOnce(input: Readonly<{
      workerId: string;
      limit: number;
      staleClaimBefore: Date;
    }>) {
      const events = await options.repository.claim({
        ...input,
        eventType: GMAIL_PUSH_INCREMENTAL_SYNC_REQUESTED,
      });
      let published = 0;
      let failed = 0;
      for (const event of events) {
        try {
          await options.incrementalSyncStarter.start(parseSyncContext(event));
          const marked = await options.repository.mark({
            eventId: event.eventId,
            workerId: input.workerId,
            outcome: "published",
          });
          if (!marked) throw new Error("GMAIL_PUSH_OUTBOX_CLAIM_LOST");
          published += 1;
        } catch (error) {
          const marked = await options.repository.mark({
            eventId: event.eventId,
            workerId: input.workerId,
            outcome: "failed",
            retryAt: retryAt(),
          });
          if (!marked) throw error;
          failed += 1;
        }
      }
      return { claimed: events.length, published, failed };
    },
  };
}

export function createGmailPushIncrementalSyncWorkflowRelay(
  options: Readonly<{
    repository: RelayRepository;
    workflowDependencies: GmailIncrementalSyncWorkflowDependencies;
    workflowOptions?: GmailIncrementalSyncWorkflowOptions;
    retryAt?: () => Date;
  }>,
) {
  const relayOptions = {
    repository: options.repository,
    incrementalSyncStarter: createGmailIncrementalSyncStarter({
      dependencies: options.workflowDependencies,
      ...(options.workflowOptions === undefined
        ? {}
        : { workflowOptions: options.workflowOptions }),
    }),
  };
  return createGmailPushIncrementalSyncOutboxRelay(
    options.retryAt === undefined
      ? relayOptions
      : { ...relayOptions, retryAt: options.retryAt },
  );
}
