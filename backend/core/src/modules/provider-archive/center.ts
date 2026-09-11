import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { eventDigest, parseEvent, sha256, type ArchiveEvent } from "./contract.js";

export type ArchiveDatabase = {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};

export function archiveRepository(db: ArchiveDatabase) {
  return {
    async append(event: ArchiveEvent): Promise<"stored" | "existing" | "conflict"> {
      const digest = eventDigest(event);
      const result = await db.query(`
        INSERT INTO provider_archive_events
          (deployment_id,event_id,event_digest,received_at,endpoint,event_payload)
        VALUES ($1,$2::uuid,$3,$4::timestamptz,$5,$6::jsonb)
        ON CONFLICT (deployment_id,event_id) DO NOTHING RETURNING event_id
      `, [event.deploymentId, event.eventId, digest, event.receivedAt, event.endpoint, JSON.stringify(event)]);
      if (result.rows.length !== 0) return "stored";
      const existing = await db.query(`
        SELECT event_digest FROM provider_archive_events
        WHERE deployment_id=$1 AND event_id=$2::uuid
      `, [event.deploymentId, event.eventId]);
      return existing.rows[0]?.event_digest === digest ? "existing" : "conflict";
    },
    async history(deploymentId: string | undefined, after: string, limit: number) {
      return (await db.query(`
        SELECT sequence_id::text AS cursor,
          event_payload - 'responseBodyBase64' - 'requestBody' AS event, stored_at
        FROM provider_archive_events
        WHERE sequence_id > $1::bigint AND ($2::text IS NULL OR deployment_id=$2)
        ORDER BY sequence_id LIMIT $3
      `, [after, deploymentId ?? null, limit])).rows;
    },
    async detail(deploymentId: string, eventId: string) {
      return (await db.query(`
        SELECT event_payload AS event FROM provider_archive_events
        WHERE deployment_id=$1 AND event_id=$2::uuid
      `, [deploymentId, eventId])).rows[0];
    },
  };
}

export type ArchiveCredential = Readonly<{
  tokenSha256: string;
  role: "upload" | "admin";
  deploymentId?: string | undefined;
}>;

export function parseCredentials(value: string): readonly ArchiveCredential[] {
  const credentials = z.array(z.object({
    tokenSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    role: z.enum(["upload", "admin"]),
    deploymentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u).optional(),
  }).strict()).min(1).parse(JSON.parse(value));
  if (credentials.some((entry) => entry.role === "upload" && !entry.deploymentId) ||
      new Set(credentials.map((entry) => entry.tokenSha256)).size !== credentials.length) {
    throw new Error("ARCHIVE_INVALID_CREDENTIALS");
  }
  return credentials;
}

export function createArchiveCenter(options: {
  db: ArchiveDatabase;
  credentials: readonly ArchiveCredential[];
  bodyLimit?: number;
}) {
  const app = Fastify({ logger: false, bodyLimit: options.bodyLimit ?? 48 * 1024 * 1024 });
  const repository = archiveRepository(options.db);
  function authorize(header: string | undefined, role: ArchiveCredential["role"]) {
    if (!header?.startsWith("Bearer ")) return undefined;
    const digest = Buffer.from(sha256(header.slice(7)), "hex");
    return options.credentials.find((entry) =>
      timingSafeEqual(Buffer.from(entry.tokenSha256, "hex"), digest) && entry.role === role);
  }
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as { statusCode?: number }).statusCode;
    const status = statusCode === 413 ? 413 : statusCode === 400 ? 400 : 503;
    return reply.code(status).send({ code: "ARCHIVE_REQUEST_FAILED" });
  });
  app.get("/health", async (_request, reply) => {
    try { await options.db.query("SELECT 1"); return { status: "ready" }; }
    catch { return reply.code(503).send({ status: "unavailable" }); }
  });
  app.post("/v1/events", async (request, reply) => {
    const credential = authorize(request.headers.authorization, "upload");
    if (!credential) return reply.code(401).send({ code: "ARCHIVE_UNAUTHORIZED" });
    let event: ArchiveEvent;
    try { event = parseEvent(request.body); }
    catch { return reply.code(400).send({ code: "ARCHIVE_EVENT_INVALID" }); }
    if (event.deploymentId !== credential.deploymentId) {
      return reply.code(403).send({ code: "ARCHIVE_DEPLOYMENT_MISMATCH" });
    }
    const result = await repository.append(event);
    if (result === "conflict") return reply.code(409).send({ code: "ARCHIVE_EVENT_CONFLICT" });
    return reply.code(result === "stored" ? 201 : 200).send({
      eventId: event.eventId, deploymentId: event.deploymentId,
      eventDigest: eventDigest(event), status: result,
    });
  });
  app.get("/v1/events", async (request, reply) => {
    if (!authorize(request.headers.authorization, "admin")) {
      return reply.code(401).send({ code: "ARCHIVE_UNAUTHORIZED" });
    }
    const query = z.object({
      deploymentId: z.string().max(100).optional(),
      after: z.string().regex(/^(0|[1-9][0-9]{0,17})$/u).default("0"),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({ code: "ARCHIVE_QUERY_INVALID" });
    const events = await repository.history(query.data.deploymentId, query.data.after, query.data.limit);
    return { events, nextCursor: events.at(-1)?.cursor ?? query.data.after };
  });
  app.get("/v1/events/:deploymentId/:eventId", async (request, reply) => {
    if (!authorize(request.headers.authorization, "admin")) {
      return reply.code(401).send({ code: "ARCHIVE_UNAUTHORIZED" });
    }
    const params = z.object({
      deploymentId: z.string().max(100), eventId: z.uuid(),
    }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "ARCHIVE_QUERY_INVALID" });
    const record = await repository.detail(params.data.deploymentId, params.data.eventId);
    return record ?? reply.code(404).send({ code: "ARCHIVE_NOT_FOUND" });
  });
  return app;
}
