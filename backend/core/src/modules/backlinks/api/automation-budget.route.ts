import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import type { BacklinksModule } from "../application/backlinks.module.js";
import { recommendationDiscoveryTotalBudgetMicros } from "../domain/recommendations/recommendation-pool-v2-policy.js";
import { toBacklinkProblemDetails, backlinkProblemContentType } from "./problem-details.js";

export function registerBacklinksAutomationBudgetRoute(
  app: FastifyInstance,
  options: Readonly<{ module: BacklinksModule; draftReservationUsd: number | null }>,
): void {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/api/v1/projects/:websiteProjectKey/backlinks/automation-budget",
    {
      schema: {
        params: z.object({ websiteProjectKey: z.string().trim().min(1) }).strict(),
      },
      errorHandler(error, request, reply) {
        const problem = toBacklinkProblemDetails(error, request.id);
        void reply.code(problem.status).type(backlinkProblemContentType).send(problem);
      },
    },
    async (request) => {
      const context = await options.module.projectContext.resolve({
        actor: request.actor,
        websiteProjectKey: request.params.websiteProjectKey,
      });
      const draft = options.draftReservationUsd;
      return {
        // Reservations bound admission; they are not a provider billing receipt.
        accounting: "conservative_reservations",
        recommendationPaidReservationUsd: String(recommendationDiscoveryTotalBudgetMicros / 1_000_000),
        draftModelReservationUsd:
          draft !== null && Number.isFinite(draft) && draft > 0 ? String(draft) : null,
        meta: {
          organizationId: context.tenant.organizationId,
          workspaceId: context.tenant.workspaceId,
          websiteProjectId: context.project.websiteProjectId,
          requestId: request.id,
          schemaVersion: "backlinks.automation-budget.v1",
          generatedAt: new Date().toISOString(),
        },
      };
    },
  );
}
