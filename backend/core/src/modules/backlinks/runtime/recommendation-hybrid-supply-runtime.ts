import { z } from "zod";
import { createProjectDomainRatingAdapter, ProjectDomainRatingError, type ProjectDomainRating } from "../adapters/ahrefs/project-domain-rating.adapter.js";
import { createSqliteResourceLibraryAdapter } from "../adapters/resource-library/sqlite-resource-library.adapter.js";
import { LocalProductSecretStoreClient, localProductAhrefsCredentialReference, parseLocalProductSecretReference } from "../adapters/security/local-product-secret-store-client.js";
import { createProjectDomainRatingService } from "../application/services/project-domain-rating.service.js";
import { createRecommendationHybridSupplyService, resourceSupplyDeficits } from "../application/services/recommendation-hybrid-supply.service.js";
import { createRecommendationPoolV2CandidateAdmissionService } from "../application/services/recommendation-pool-v2-candidate-admission.service.js";
import type { RecommendationPoolV2WorkflowActivities } from "../application/services/recommendation-pool-v2-workflow.service.js";
import { createRecommendationHybridSupplyRepository } from "../db/repositories/recommendation-hybrid-supply.repository.js";
import { createRecommendationPoolV2CandidateRepository } from "../db/repositories/recommendation-pool-v2-candidate.repository.js";
import { withBacklinkTenantTransaction, type BacklinkTenantPool, type BacklinkTransactionClient } from "../db/tenant-transaction.js";
import { secretKinds } from "../ports/secret-store.port.js";
import { resolveResourceLibraryPath } from "./resource-library-location.js";

export function createRecommendationHybridSupplyRuntime(options: Readonly<{
  pool: BacklinkTenantPool;
  secretStoreRoot: string | null;
  environment?: NodeJS.ProcessEnv;
}>) {
  const environment = options.environment ?? process.env;
  const path = resolveResourceLibraryPath(environment);
  if (path === undefined) return undefined;
  const library = createSqliteResourceLibraryAdapter(path);
  const provider = createProjectDomainRatingAdapter({
    resolveApiKey: async () => {
      const reference = environment.AHREFS_CREDENTIAL_SECRET_REF?.trim() || localProductAhrefsCredentialReference;
      if (!reference || options.secretStoreRoot === null) throw new Error("AHREFS_NOT_CONFIGURED");
      const store = new LocalProductSecretStoreClient({ rootDirectory: options.secretStoreRoot });
      return z.object({ apiKey: z.string().min(1).max(4_096) }).strict().parse(JSON.parse(await store.resolve({
        reference: parseLocalProductSecretReference(reference, secretKinds.ahrefsCredential),
        context: { organizationId: "local-product", subjectProvider: "ahrefs" },
      })) as unknown).apiKey;
    },
  });
  return async (
    input: Parameters<RecommendationPoolV2WorkflowActivities["finalizeGeneration"]>[0],
  ) => {
    // Release the generation connection before acquiring the cache connection.
    const initialFacts = await withBacklinkTenantTransaction(options.pool, input,
      (client) => createRecommendationHybridSupplyRepository(client).load(input));
    let rating: ProjectDomainRating | null = null;
    let ratingError: unknown = new ProjectDomainRatingError("AHREFS_CACHE_NOT_PREPARED", false);
    if (resourceSupplyDeficits(initialFacts).length > 0) {
      const result = await withBacklinkTenantTransaction(options.pool, input, async (cacheClient) => {
        const cache = createRecommendationHybridSupplyRepository(cacheClient);
        await cache.lockProject(input);
        try {
          return { value: await createProjectDomainRatingService({
            read: (domain) => cache.readRating(input, domain),
            save: (value) => cache.saveRating(input, value),
            get: provider.get,
          }).get(initialFacts.projectDomain), error: null };
        } catch (error) {
          return { value: null, error: error instanceof ProjectDomainRatingError
            ? error : new ProjectDomainRatingError("AHREFS_CACHE_UNAVAILABLE", true) };
        }
      }).catch(() => ({
        value: null, error: new ProjectDomainRatingError("AHREFS_CACHE_UNAVAILABLE", true),
      }));
      rating = result.value;
      ratingError = result.error;
    }
    return async (client: BacklinkTransactionClient) => {
      // Recheck under the finalizer's lock; admission and batch persistence commit together.
      const facts = await createRecommendationHybridSupplyRepository(client).load(input);
      return createRecommendationHybridSupplyService({
        library,
        getRating: async () => {
          if (rating === null) throw ratingError;
          return rating;
        },
        ingest: (artifact) => createRecommendationPoolV2CandidateAdmissionService(
          createRecommendationPoolV2CandidateRepository(client),
        ).ingestArtifacts({
          ...input, projectDomain: facts.projectDomain,
          market: "GLOBAL", location: "GLOBAL", language: facts.language,
          createdBy: input.actorId,
          observations: [{
            requestIntentId: `resource-library:${input.generationContractId}`,
            providerOutcome: "SUCCEEDED",
            artifact,
          }],
        }),
      }).prepare(facts);
    };
  };
}
