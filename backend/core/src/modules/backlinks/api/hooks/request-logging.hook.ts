import type { FastifyInstance } from "fastify";

declare module "fastify" {
  interface FastifyRequest {
    correlationId: string;
  }
}

const correlationIdHeader = "x-correlation-id";
const requestIdHeader = "x-request-id";
const trackingIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function resolveCorrelationId(
  headerValue: string | string[] | undefined,
  requestId: string,
): string {
  return typeof headerValue === "string" && trackingIdPattern.test(headerValue)
    ? headerValue
    : requestId;
}

export function registerBacklinksRequestLoggingHook(
  app: FastifyInstance,
): void {
  app.decorateRequest("correlationId");

  app.addHook("onRequest", async (request, reply) => {
    request.correlationId = resolveCorrelationId(
      request.headers[correlationIdHeader],
      request.id,
    );
    void reply.header(requestIdHeader, request.id);
    void reply.header(correlationIdHeader, request.correlationId);
  });

  app.addHook("onResponse", async (request, reply) => {
    app.log.info(
      {
        event: "backlinks.request.completed",
        requestId: request.id,
        correlationId: request.correlationId,
        method: request.method,
        route: request.routeOptions.url ?? "unmatched",
        statusCode: reply.statusCode,
      },
      "backlinks.request.completed",
    );
  });
}
