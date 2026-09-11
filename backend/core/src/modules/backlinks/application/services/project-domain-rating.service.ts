import {
  ProjectDomainRatingError,
  type ProjectDomainRating,
} from "../../adapters/ahrefs/project-domain-rating.adapter.js";
import { createRecommendationDomainKey } from "../../domain/recommendations/domain-key.js";

export type ProjectDomainRatingCache = Readonly<{
  target: string;
  value: number | null;
  observedAt: string;
  expiresAt: string;
  failureCode: string | null;
}>;

export function createProjectDomainRatingService(options: Readonly<{
  read(target: string): Promise<ProjectDomainRatingCache | null>;
  save(value: ProjectDomainRatingCache): Promise<void>;
  get(target: string): Promise<ProjectDomainRating>;
  now?: () => Date;
}>) {
  const now = options.now ?? (() => new Date());
  return Object.freeze({
    async get(projectDomain: string): Promise<ProjectDomainRating> {
      const target = createRecommendationDomainKey(projectDomain).registrableDomain;
      const cached = await options.read(target);
      const at = now().getTime();
      if (cached !== null && cached.target === target
        && Date.parse(cached.observedAt) <= at && Date.parse(cached.expiresAt) > at) {
        if (cached.failureCode !== null) throw new ProjectDomainRatingError(cached.failureCode, false);
        if (cached.value !== null && Number.isFinite(cached.value) && cached.value >= 0 && cached.value <= 100) {
          return { target, value: cached.value, provider: "ahrefs", observedAt: cached.observedAt };
        }
      }
      let result: ProjectDomainRating;
      try {
        result = await options.get(target);
      } catch (error) {
        if (!(error instanceof ProjectDomainRatingError)) throw error;
        await options.save({
          target, value: null, observedAt: now().toISOString(),
          expiresAt: new Date(now().getTime() + 10 * 60_000).toISOString(),
          failureCode: error.code,
        });
        throw error;
      }
      if (result.target !== target || !Number.isFinite(result.value) || result.value < 0 || result.value > 100) {
        throw new ProjectDomainRatingError("AHREFS_RESPONSE_INVALID", false);
      }
      await options.save({
        target, value: result.value, observedAt: result.observedAt,
        expiresAt: new Date(Date.parse(result.observedAt) + 30 * 86_400_000).toISOString(),
        failureCode: null,
      });
      return result;
    },
  });
}
