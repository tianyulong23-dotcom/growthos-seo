import { createHash } from "node:crypto";
import { z } from "zod";

export const archiveEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.uuid(),
  deploymentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u),
  component: z.string().min(1).max(100),
  endpoint: z.string().regex(/^\/v3\/[a-zA-Z0-9/_-]+$/u).max(500),
  method: z.enum(["GET", "POST"]),
  startedAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  requestBody: z.string().nullable(),
  responseBodyBase64: z.string(),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  outcome: z.enum(["response", "transport_error"]),
}).strict();

export type ArchiveEvent = z.infer<typeof archiveEventSchema>;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseEvent(value: unknown): ArchiveEvent {
  const event = archiveEventSchema.parse(value);
  const bytes = Buffer.from(event.responseBodyBase64, "base64");
  if (bytes.toString("base64") !== event.responseBodyBase64 ||
      sha256(bytes) !== event.responseSha256 ||
      event.receivedAt < event.startedAt ||
      event.endpoint.startsWith("/v3/appendix/") ||
      (event.outcome === "response") !== (event.httpStatus !== null) ||
      (event.outcome === "transport_error" && bytes.length !== 0)) {
    throw new Error("ARCHIVE_EVENT_INVALID");
  }
  return event;
}

// The wire format is shared by Node and Python; hash normalized field order.
export function eventDigest(event: ArchiveEvent): string {
  return sha256(JSON.stringify(archiveEventSchema.parse(event)));
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("ARCHIVE_INVALID_NUMBER");
  return parsed;
}
