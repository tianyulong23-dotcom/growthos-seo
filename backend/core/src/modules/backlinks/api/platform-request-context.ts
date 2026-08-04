import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import { z } from "zod";

import { createActorContext, type ActorContext } from "../domain/context/index.js";
import {
  BacklinkError,
  backlinkErrorCodes,
} from "../domain/errors/backlink-error.js";
import {
  backlinkProblemContentType,
  toBacklinkProblemDetails,
} from "./problem-details.js";

export const platformContextHeader = "x-growthos-platform-context";
export const platformContextSignatureHeader =
  "x-growthos-platform-context-signature";
export const platformContextVersion = "PlatformRequestContext.v1";
const platformContextIssuer = "growthos-platform-gateway";
const platformContextAudience = "growthos-backlinks-core";
const maximumLifetimeMs = 60_000;
const allowedClockSkewMs = 5_000;

const nonBlankIdentifier = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim(), "Must not have surrounding whitespace");
const uniqueIdentifiers = (maximum: number) =>
  z
    .array(nonBlankIdentifier)
    .min(1)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, "Must be unique");
const permission = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[a-z][a-z0-9_.-]*:[a-z][a-z0-9_.-]*$/);

export const platformRequestContextSchema = z
  .object({
    version: z.literal(platformContextVersion),
    issuer: z.literal(platformContextIssuer),
    audience: z.literal(platformContextAudience),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    correlationId: nonBlankIdentifier,
    actor: z
      .object({
        userId: nonBlankIdentifier,
        sessionId: nonBlankIdentifier,
        roles: uniqueIdentifiers(32),
      })
      .strict(),
    tenant: z
      .object({
        organizationId: nonBlankIdentifier,
        workspaceId: nonBlankIdentifier,
      })
      .strict(),
    project: z
      .object({
        websiteProjectId: nonBlankIdentifier,
        websiteProjectKey: nonBlankIdentifier,
      })
      .strict(),
    permissions: z
      .array(permission)
      .min(1)
      .max(128)
      .refine((values) => new Set(values).size === values.length, "Must be unique"),
  })
  .strict();

export type PlatformRequestContextV1 = Readonly<{
  version: typeof platformContextVersion;
  issuer: typeof platformContextIssuer;
  audience: typeof platformContextAudience;
  issuedAt: string;
  expiresAt: string;
  correlationId: string;
  actor: Readonly<{
    userId: string;
    sessionId: string;
    roles: readonly string[];
  }>;
  tenant: Readonly<{
    organizationId: string;
    workspaceId: string;
  }>;
  project: Readonly<{
    websiteProjectId: string;
    websiteProjectKey: string;
  }>;
  permissions: readonly string[];
}>;

declare module "fastify" {
  interface FastifyRequest {
    actor: ActorContext;
    platformContext: PlatformRequestContextV1;
  }
}

type ConsumerOptions = Readonly<{
  signingKey: string | Buffer;
  now?: () => Date;
}>;

function authenticationFailure(): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.authenticationRequired,
    message: "A valid internal platform context is required.",
  });
}

function headerValue(
  request: FastifyRequest,
  header: string,
): string {
  const value = request.headers[header];
  if (typeof value !== "string" || value.length === 0) {
    throw authenticationFailure();
  }
  return value;
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw authenticationFailure();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw authenticationFailure();
  }
  return decoded;
}

function verifyIntegrity(
  payload: string,
  signatureHeader: string,
  signingKey: Buffer,
): void {
  if (!signatureHeader.startsWith("v1=")) {
    throw authenticationFailure();
  }
  const supplied = decodeBase64Url(signatureHeader.slice(3));
  const expected = createHmac("sha256", signingKey)
    .update(`${platformContextVersion}.${payload}`)
    .digest();
  if (
    supplied.length !== expected.length
    || !timingSafeEqual(supplied, expected)
  ) {
    throw authenticationFailure();
  }
}

function verifyLifetime(context: PlatformRequestContextV1, now: Date): void {
  const issuedAt = Date.parse(context.issuedAt);
  const expiresAt = Date.parse(context.expiresAt);
  const nowMs = now.getTime();
  if (
    !Number.isFinite(issuedAt)
    || !Number.isFinite(expiresAt)
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > maximumLifetimeMs
    || issuedAt > nowMs + allowedClockSkewMs
    || expiresAt <= nowMs
  ) {
    throw authenticationFailure();
  }
}

function freezeContext(
  context: z.output<typeof platformRequestContextSchema>,
): PlatformRequestContextV1 {
  return Object.freeze({
    ...context,
    actor: Object.freeze({
      ...context.actor,
      roles: Object.freeze([...context.actor.roles]),
    }),
    tenant: Object.freeze({ ...context.tenant }),
    project: Object.freeze({ ...context.project }),
    permissions: Object.freeze([...context.permissions]),
  });
}

function projectKey(request: FastifyRequest): string | undefined {
  if (typeof request.params !== "object" || request.params === null) {
    return undefined;
  }
  const value = (request.params as Record<string, unknown>).websiteProjectKey;
  return typeof value === "string" ? value : undefined;
}

export function verifyPlatformRequestContextV1(
  request: FastifyRequest,
  options: ConsumerOptions,
): PlatformRequestContextV1 {
  const signingKey = Buffer.from(options.signingKey);
  if (signingKey.length < 32) {
    throw new TypeError("Platform context signing key must contain at least 32 bytes");
  }
  const payload = headerValue(request, platformContextHeader);
  if (payload.length > 16_384) {
    throw authenticationFailure();
  }
  verifyIntegrity(
    payload,
    headerValue(request, platformContextSignatureHeader),
    signingKey,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(payload).toString("utf8"));
  } catch {
    throw authenticationFailure();
  }
  const result = platformRequestContextSchema.safeParse(parsed);
  if (!result.success) {
    throw authenticationFailure();
  }
  const context = freezeContext(result.data);
  verifyLifetime(context, options.now?.() ?? new Date());
  const requestedProjectKey = projectKey(request);
  if (
    requestedProjectKey !== undefined
    && requestedProjectKey !== context.project.websiteProjectKey
  ) {
    throw new BacklinkError({
      code: backlinkErrorCodes.accessDenied,
      message: "The platform context is not valid for this project.",
    });
  }
  return context;
}

function sendContextFailure(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const problem = toBacklinkProblemDetails(error, request.id);
  return reply
    .code(problem.status)
    .type(backlinkProblemContentType)
    .send(problem);
}

export function registerBacklinksPlatformContextConsumer(
  app: FastifyInstance,
  options: ConsumerOptions,
): void {
  if (Buffer.byteLength(options.signingKey) < 32) {
    throw new TypeError("Platform context signing key must contain at least 32 bytes");
  }
  app.decorateRequest("actor");
  app.decorateRequest("platformContext");
  app.addHook("preHandler", async (request, reply) => {
    if (projectKey(request) === undefined) {
      return;
    }
    try {
      const context = verifyPlatformRequestContextV1(request, options);
      request.platformContext = context;
      request.actor = createActorContext({
        userId: context.actor.userId,
        sessionId: context.actor.sessionId,
        roles: context.actor.roles,
      });
    } catch (error) {
      return sendContextFailure(error, request, reply);
    }
  });
}
