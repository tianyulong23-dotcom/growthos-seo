import { z } from "zod";

import {
  BacklinkError,
  backlinkErrorCodes,
  isBacklinkError,
  type BacklinkErrorCode,
} from "../domain/errors/backlink-error.js";

export const backlinkProblemContentType = "application/problem+json";

export type BacklinkHttpStatus = 400 | 401 | 403 | 404 | 409 | 429 | 500;

type ProblemDefinition = Readonly<{
  status: BacklinkHttpStatus;
  title: string;
  type: string;
}>;

function defineProblem(
  status: BacklinkHttpStatus, title: string, slug: string,
): ProblemDefinition {
  return { status, title, type: `urn:growthos:problem:backlinks:${slug}` };
}

const problemDefinitions = {
  [backlinkErrorCodes.invalidRequest]: defineProblem(400, "Invalid request", "invalid-request"),
  [backlinkErrorCodes.authenticationRequired]: defineProblem(401, "Authentication required", "authentication-required"),
  [backlinkErrorCodes.accessDenied]: defineProblem(403, "Access denied", "access-denied"),
  [backlinkErrorCodes.notFound]: defineProblem(404, "Resource not found", "not-found"),
  [backlinkErrorCodes.conflict]: defineProblem(409, "Conflict", "conflict"),
  [backlinkErrorCodes.rateLimited]: defineProblem(429, "Rate limit exceeded", "rate-limited"),
  [backlinkErrorCodes.gmailConnectionNotSelected]: defineProblem(409, "Gmail connection not selected", "gmail-connection-not-selected"),
  [backlinkErrorCodes.gmailReauthRequired]: defineProblem(409, "Gmail reauthorization required", "gmail-reauth-required"),
  [backlinkErrorCodes.gmailSendDisabled]: defineProblem(409, "Gmail send disabled", "gmail-send-disabled"),
  [backlinkErrorCodes.gmailScopeInsufficient]: defineProblem(409, "Gmail scope insufficient", "gmail-scope-insufficient"),
  [backlinkErrorCodes.gmailWorkerUnavailable]: defineProblem(409, "Gmail worker unavailable", "gmail-worker-unavailable"),
  [backlinkErrorCodes.contactVersionStale]: defineProblem(409, "Contact version stale", "contact-version-stale"),
  [backlinkErrorCodes.draftVersionStale]: defineProblem(409, "Draft version stale", "draft-version-stale"),
  [backlinkErrorCodes.sendPolicyRejected]: defineProblem(409, "Send policy rejected", "send-policy-rejected"),
  [backlinkErrorCodes.internal]: defineProblem(500, "Internal server error", "internal-error"),
} satisfies Record<BacklinkErrorCode, ProblemDefinition>;

const backlinkErrorCodeSchema = z.union([
  z.literal(backlinkErrorCodes.invalidRequest),
  z.literal(backlinkErrorCodes.authenticationRequired),
  z.literal(backlinkErrorCodes.accessDenied),
  z.literal(backlinkErrorCodes.notFound),
  z.literal(backlinkErrorCodes.conflict),
  z.literal(backlinkErrorCodes.rateLimited),
  z.literal(backlinkErrorCodes.gmailConnectionNotSelected),
  z.literal(backlinkErrorCodes.gmailReauthRequired),
  z.literal(backlinkErrorCodes.gmailSendDisabled),
  z.literal(backlinkErrorCodes.gmailScopeInsufficient),
  z.literal(backlinkErrorCodes.gmailWorkerUnavailable),
  z.literal(backlinkErrorCodes.contactVersionStale),
  z.literal(backlinkErrorCodes.draftVersionStale),
  z.literal(backlinkErrorCodes.sendPolicyRejected),
  z.literal(backlinkErrorCodes.internal),
]);

export const backlinkProblemDetailsSchema = z
  .object({
    type: z.string().min(1),
    title: z.string().min(1),
    status: z.union([
      z.literal(400),
      z.literal(401),
      z.literal(403),
      z.literal(404),
      z.literal(409),
      z.literal(429),
      z.literal(500),
    ]),
    detail: z.string().min(1),
    code: backlinkErrorCodeSchema,
    message: z.string().min(1),
    requestId: z.string().min(1),
    retryable: z.boolean(),
    fieldErrors: z
      .array(
        z
          .object({
            field: z.string().min(1),
            message: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type BacklinkProblemDetails = z.output<
  typeof backlinkProblemDetailsSchema
>;

export function toBacklinkProblemDetails(
  error: unknown,
  requestId: string,
): BacklinkProblemDetails {
  const normalized =
    isBacklinkError(error)
      ? error
      : new BacklinkError({
          code: backlinkErrorCodes.internal,
          message: "An unexpected error occurred.",
        });
  const definition = problemDefinitions[normalized.code];
  const message =
    normalized.code === backlinkErrorCodes.internal
      ? "An unexpected error occurred."
      : normalized.message;
  const problem = {
    ...definition,
    detail: message,
    code: normalized.code,
    message,
    requestId,
    retryable: normalized.retryable,
  };

  return backlinkProblemDetailsSchema.parse(
    normalized.fieldErrors === undefined
      ? problem
      : { ...problem, fieldErrors: normalized.fieldErrors },
  );
}
