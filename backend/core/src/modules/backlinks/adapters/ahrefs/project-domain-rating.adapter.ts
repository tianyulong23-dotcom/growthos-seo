import { z } from "zod";
import { createRecommendationDomainKey } from "../../domain/recommendations/domain-key.js";

export type ProjectDomainRating = Readonly<{
  target: string;
  value: number;
  provider: "ahrefs";
  observedAt: string;
}>;

export class ProjectDomainRatingError extends Error {
  constructor(readonly code: string, readonly retryable: boolean) {
    super(code);
    this.name = "ProjectDomainRatingError";
  }
}

const responseSchema = z.object({
  domain_rating: z.object({ domain_rating: z.number().finite().min(0).max(100) }),
});

export function createProjectDomainRatingAdapter(options: Readonly<{
  resolveApiKey(): Promise<string>;
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}>) {
  const http = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return Object.freeze({
    async get(projectDomain: string): Promise<ProjectDomainRating> {
      const target = createRecommendationDomainKey(projectDomain).registrableDomain;
      let apiKey: string;
      try {
        apiKey = (await options.resolveApiKey()).trim();
        if (!apiKey || /[\r\n]/u.test(apiKey)) throw new Error("invalid");
      } catch {
        throw new ProjectDomainRatingError("AHREFS_CREDENTIAL_UNAVAILABLE", false);
      }
      const url = new URL("https://api.ahrefs.com/v3/public/domain-rating-free");
      url.searchParams.set("target", target);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await http(url, {
            method: "GET",
            headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new ProjectDomainRatingError(
              `AHREFS_HTTP_${response.status}`,
              response.status === 429 || response.status >= 500,
            );
          }
          let body: unknown;
          try {
            body = await response.json();
          } catch {
            throw new ProjectDomainRatingError("AHREFS_RESPONSE_INVALID", false);
          }
          const parsed = responseSchema.safeParse(body);
          if (!parsed.success) {
            throw new ProjectDomainRatingError("AHREFS_RESPONSE_INVALID", false);
          }
          return Object.freeze({
            target,
            value: parsed.data.domain_rating.domain_rating,
            provider: "ahrefs",
            observedAt: now().toISOString(),
          });
        } catch (error) {
          // Never propagate provider bodies, request headers or secret-store causes.
          const failure = error instanceof ProjectDomainRatingError
            ? error
            : new ProjectDomainRatingError("AHREFS_TRANSPORT_FAILED", true);
          if (!failure.retryable || attempt === 2) throw failure;
          await sleep(250 * (attempt + 1));
        }
      }
      throw new ProjectDomainRatingError("AHREFS_TRANSPORT_FAILED", true);
    },
  });
}
