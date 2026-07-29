import type {
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import {
  GmailPushIdentityError,
  gmailPushIdentityFailureCodes,
} from "../adapters/gmail/sync-push-verifier.js";
import {
  GmailPushWebhookError,
  gmailPushWebhookFailureCodes,
  type GmailPushWebhookHandler,
} from "../application/workflows/mail-push-webhook.js";
import {
  gmailMailPushBodySchema,
  gmailMailPushProblemSchema,
  gmailMailPushResponseSchema,
  type GmailMailPushStatus,
} from "./gmail-mail-push.schema.js";

const problemContentType = "application/problem+json";

type ProblemDefinition = Readonly<{
  status: GmailMailPushStatus;
  title: string;
  slug: string;
}>;

const invalidNotification = {
  status: 400,
  title: "Invalid Gmail Push notification",
  slug: "gmail-push-invalid",
} as const;
const unauthenticated = {
  status: 401,
  title: "Gmail Push authentication failed",
  slug: "gmail-push-unauthenticated",
} as const;
const unauthorizedTarget = {
  status: 403,
  title: "Gmail Push target denied",
  slug: "gmail-push-target-denied",
} as const;
const internal = {
  status: 500,
  title: "Gmail Push processing failed",
  slug: "gmail-push-internal",
} as const;
const disabled = {
  status: 503,
  title: "Gmail Push Webhook unavailable",
  slug: "gmail-push-disabled",
} as const;

const normalizeProblem = (
  error: FastifyError,
): Readonly<{
  definition: ProblemDefinition;
  code: string;
  message: string;
}> => {
  if (error instanceof GmailPushIdentityError) {
    if (
      error.code === gmailPushIdentityFailureCodes.disabled
      || error.code === gmailPushIdentityFailureCodes.misconfigured
    ) {
      return {
        definition: error.code === gmailPushIdentityFailureCodes.disabled
          ? disabled
          : internal,
        code: error.code,
        message: error.message,
      };
    }
    return {
      definition: unauthenticated,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof GmailPushWebhookError) {
    const definition =
      error.code === gmailPushWebhookFailureCodes.disabled
        ? disabled
        : error.code === gmailPushWebhookFailureCodes.invalidNotification
          ? invalidNotification
          : unauthorizedTarget;
    return {
      definition,
      code: error.code,
      message: error.message,
    };
  }
  if (error.validation !== undefined) {
    return {
      definition: invalidNotification,
      code: gmailPushWebhookFailureCodes.invalidNotification,
      message: "Gmail Push notification is invalid.",
    };
  }
  return {
    definition: internal,
    code: "GMAIL_PUSH_INTERNAL_ERROR",
    message: "Gmail Push processing failed.",
  };
};

const sendGmailPushError = (
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void => {
  const normalized = normalizeProblem(error);
  const problem = gmailMailPushProblemSchema.parse({
    type: `urn:growthos:problem:backlinks:${normalized.definition.slug}`,
    title: normalized.definition.title,
    status: normalized.definition.status,
    detail: normalized.message,
    code: normalized.code,
    message: normalized.message,
    requestId: request.id,
    retryable: false,
  });
  void reply
    .code(problem.status)
    .type(problemContentType)
    .send(problem);
};

const errorResponses = {
  400: gmailMailPushProblemSchema,
  401: gmailMailPushProblemSchema,
  403: gmailMailPushProblemSchema,
  500: gmailMailPushProblemSchema,
  503: gmailMailPushProblemSchema,
};

export function registerBacklinksGmailMailPushRoute(
  app: FastifyInstance,
  options: Readonly<{ webhook: GmailPushWebhookHandler }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/api/v1/backlinks/mail/gmail-push",
    {
      schema: {
        operationId: "backlinksReceiveGmailPushV1",
        body: gmailMailPushBodySchema,
        response: {
          202: gmailMailPushResponseSchema,
          ...errorResponses,
        },
      },
      errorHandler: sendGmailPushError,
    },
    async (request, reply) => {
      const authorizationHeader = request.headers.authorization;
      const result = await options.webhook.handle({
        ...(authorizationHeader === undefined
          ? {}
          : { authorizationHeader }),
        body: request.body,
      });
      return reply.code(202).send(result);
    },
  );
}
