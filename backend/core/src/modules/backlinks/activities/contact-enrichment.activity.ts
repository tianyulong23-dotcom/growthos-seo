import { randomUUID } from "node:crypto";

import { load } from "cheerio";
import { getDomain } from "tldts";

import type {
  SharedBrowserWorkerPort,
} from "../adapters/browser/shared-browser-worker.adapter.js";
import { SafeFetchAdapter } from "../adapters/http/safe-fetch.adapter.js";
import { RobotsPolicyAdapter } from "../adapters/html/robots-policy.adapter.js";
import {
  ContactDiscoveryService,
} from "../application/services/contact-discovery.service.js";
import {
  synchronizeRecommendationPublication,
} from "../application/services/recommendation-publication.service.js";
import {
  createContactDiscoveryRepository,
} from "../db/repositories/contact-discovery.repository.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
} from "../db/tenant-transaction.js";

export type ContactEnrichmentActivityInput = Readonly<{
  organizationId: string;
  workspaceId: string;
  websiteProjectId: string;
  jobId: string;
  requestVersion: number;
  actorId: string;
}>;

export type ContactEnrichmentActivityResult = Readonly<{
  jobId: string;
  status:
    | "completed"
    | "partially_completed"
    | "no_contact_found"
    | "retry_scheduled"
    | "stale_context";
  pagesVisited: number;
  candidateCount: number;
  evidenceCount: number;
  browserUsed: boolean;
  terminalReasonCode: ContactTerminalReason | null;
  method: ContactEnrichmentMethod;
}>;

type Job = Readonly<{
  id: string;
  batchId: string;
  rootUrl: string;
  prospectId: string;
  recommendationContextVersionId: string;
  registrableDomain: string;
  attemptCount: number;
  maxAttempts: number;
  maxPages: number;
  maxDepth: number;
  browserAllowed: boolean;
}>;

export type ContactTerminalReason =
  | "PUBLIC_EMAIL_FOUND"
  | "CONTACT_FORM_ONLY"
  | "LOGIN_REQUIRED"
  | "CAPTCHA_OR_BOT_CHALLENGE"
  | "ROBOTS_DISALLOWED"
  | "ACCESS_DENIED"
  | "NO_PUBLIC_EMAIL"
  | "SITE_UNREACHABLE"
  | "UNSUPPORTED_CONTENT"
  | "MANUAL_REVIEW_REQUIRED"
  | "COMPLETED_PARTIAL";

type ContactEnrichmentMethod =
  | "none"
  | "static"
  | "browser"
  | "static_and_browser";

type PageSource =
  | "homepage"
  | "common_path"
  | "navigation"
  | "footer"
  | "robots_sitemap"
  | "internal_link";

type QueuedPage = Readonly<{
  url: string;
  depth: number;
  source: PageSource;
}>;

const commonPaths = [
  "/contact",
  "/contact-us",
  "/about",
  "/about-us",
  "/team",
  "/editorial",
  "/advertise",
  "/advertising",
  "/partnership",
  "/partnerships",
  "/write-for-us",
  "/authors",
] as const;
const decoder = new TextDecoder("utf-8", { fatal: false });
const priorityPath =
  /(?:contact|about|team|editor|advert|partner|write-for-us|author|press|media)/iu;

type CrawlSignals = {
  contactForm: boolean;
  loginRequired: boolean;
  challenge: boolean;
  accessDenied: boolean;
  robotsDisallowed: number;
  unsupportedContent: number;
  transportFailures: number;
  parsedPages: number;
};

function inspectHtml(html: string): Readonly<{
  contactForm: boolean;
  loginRequired: boolean;
  challenge: boolean;
}> {
  const $ = load(html);
  const text = $("body").text().replace(/\s+/gu, " ").trim().toLowerCase();
  return {
    contactForm: $("form").filter((_, form) => {
      const node = $(form);
      return node.find(
        "input[type='email'],input[name*='email'],textarea,button[type='submit']",
      ).length > 0;
    }).length > 0,
    loginRequired:
      $("input[type='password']").length > 0
      || /\b(?:sign in|log in|login required|members only|subscribe to continue|paywall)\b/iu
        .test(text),
    challenge:
      $(
        ".g-recaptcha,.h-captcha,[data-sitekey],iframe[src*='recaptcha'],iframe[src*='hcaptcha']",
      ).length > 0
      || /\b(?:captcha|verify you are human|checking your browser|attention required|bot challenge|cloudflare ray id)\b/iu
        .test(text),
  };
}

function normalizePageUrl(value: string, base: string): string | null {
  try {
    const parsed = new URL(value, base);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.hash = "";
    for (const parameter of [...parsed.searchParams.keys()]) {
      if (/^utm_/iu.test(parameter)) parsed.searchParams.delete(parameter);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function sameSite(left: string, right: string): boolean {
  return getDomain(new URL(left).hostname, { allowPrivateDomains: true })
    === getDomain(new URL(right).hostname, { allowPrivateDomains: true });
}

function discoverLinks(
  html: string,
  pageUrl: string,
  depth: number,
): readonly QueuedPage[] {
  const $ = load(html);
  const links = new Map<string, QueuedPage>();
  $("a[href]").each((_, element) => {
    const url = normalizePageUrl($(element).attr("href") ?? "", pageUrl);
    if (url === null || !sameSite(url, pageUrl)) return;
    const parent = $(element).closest("nav,footer");
    const source: PageSource = parent.is("nav")
      ? "navigation"
      : parent.is("footer") ? "footer" : "internal_link";
    links.set(url, { url, depth: depth + 1, source });
  });
  return [...links.values()];
}

function dynamicPage(html: string): boolean {
  const $ = load(html);
  const text = $("body").text().replace(/\s+/gu, " ").trim();
  return text.length < 300
    || $("script[src]").length >= 4
    || $("#__next,#__nuxt,[data-reactroot],[ng-version]").length > 0;
}

async function browserEnabledForProject(
  pool: BacklinkTenantPool,
  input: ContactEnrichmentActivityInput,
): Promise<boolean> {
  return withBacklinkTenantTransaction(pool, input, async (client) => {
    const result = await client.query(
      `SELECT blocked
         FROM backlink_kill_switch_versions
        WHERE organization_id=$1 AND workspace_id=$2
          AND website_project_id=$3
          AND layer='project' AND capability='backlinks.browser.v1'
        ORDER BY version DESC
        LIMIT 1`,
      [input.organizationId, input.workspaceId, input.websiteProjectId],
    );
    return result.rows[0]?.blocked === false;
  });
}

async function recordPage(
  pool: BacklinkTenantPool,
  input: ContactEnrichmentActivityInput,
  page: QueuedPage,
  result: Readonly<{
    status:
      | "fetched"
      | "robots_disallowed"
      | "fetch_failed"
      | "unsupported_content"
      | "browser_fetched"
      | "browser_failed";
    httpStatus?: number;
    browserRendered?: boolean;
    candidateCount?: number;
    contentSha256?: string;
    errorCode?: string;
  }>,
): Promise<void> {
  await withBacklinkTenantTransaction(pool, input, (client) => client.query(
    `INSERT INTO backlink_contact_enrichment_pages (
       id,organization_id,workspace_id,website_project_id,job_id,page_url,
       depth,discovery_source,status,http_status,browser_rendered,
       candidate_count,content_sha256,error_code,created_by
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
     )
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,job_id,page_url
     ) DO UPDATE SET
       status=EXCLUDED.status,http_status=EXCLUDED.http_status,
       browser_rendered=EXCLUDED.browser_rendered,
       candidate_count=EXCLUDED.candidate_count,
       content_sha256=EXCLUDED.content_sha256,
       error_code=EXCLUDED.error_code,observed_at=now()`,
    [
      randomUUID(),
      input.organizationId,
      input.workspaceId,
      input.websiteProjectId,
      input.jobId,
      page.url,
      page.depth,
      page.source,
      result.status,
      result.httpStatus ?? null,
      result.browserRendered ?? false,
      result.candidateCount ?? 0,
      result.contentSha256 ?? null,
      result.errorCode ?? null,
      input.actorId,
    ],
  ));
}

async function claimJob(
  pool: BacklinkTenantPool,
  input: ContactEnrichmentActivityInput,
): Promise<Job | null> {
  return withBacklinkTenantTransaction(pool, input, async (client) => {
    const result = await client.query(
      `UPDATE backlink_contact_enrichment_jobs AS job
          SET status='running',attempt_count=attempt_count+1,
              started_at=now(),retry_after=NULL,
              updated_at=now(),updated_by=$5
        FROM backlink_prospects AS prospect
       WHERE (job.organization_id,job.workspace_id,
              job.website_project_id,job.id)=($1,$2,$3,$4)
         AND job.status IN ('pending','retry_scheduled')
         AND (job.retry_after IS NULL OR job.retry_after<=now())
         AND job.attempt_count<job.max_attempts
         AND (prospect.organization_id,prospect.workspace_id,
              prospect.website_project_id,prospect.id,
              prospect.recommendation_context_version_id)=
             (job.organization_id,job.workspace_id,
              job.website_project_id,job.prospect_id,
              job.recommendation_context_version_id)
       RETURNING job.id,job.batch_id "batchId",job.root_url "rootUrl",
                 job.prospect_id "prospectId",
                 job.recommendation_context_version_id
                   "recommendationContextVersionId",
                 prospect.registrable_domain "registrableDomain",
                 job.attempt_count "attemptCount",
                 job.max_attempts "maxAttempts",job.max_pages "maxPages",
                 job.max_depth "maxDepth",job.browser_allowed "browserAllowed"`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.jobId,
        input.actorId,
      ],
    );
    return (result.rows[0] as Job | undefined) ?? null;
  });
}

async function finishJob(
  pool: BacklinkTenantPool,
  input: ContactEnrichmentActivityInput,
  job: Job,
  outcome: Readonly<{
    pagesVisited: number;
    browserUsed: boolean;
    failures: number;
    retryableFailures: number;
    lastErrorCode: string | null;
    signals: Readonly<CrawlSignals>;
  }>,
): Promise<ContactEnrichmentActivityResult> {
  return withBacklinkTenantTransaction(pool, input, async (client) => {
    const totals = (await client.query(
      `SELECT
         (SELECT count(*)::integer
            FROM backlink_contact_candidates c
           WHERE (c.organization_id,c.workspace_id,c.website_project_id)=
                 ($1,$2,$3)
             AND c.prospect_id=$4
             AND c.recommendation_context_version_id=$5
             AND c.status IN ('candidate','promoted')
             AND c.invalidated_at IS NULL)
           "candidateCount",
         (SELECT count(*)::integer
            FROM backlink_contact_evidence e
            JOIN backlink_contact_candidates c ON
              (c.organization_id,c.workspace_id,c.website_project_id,c.id)=
              (e.organization_id,e.workspace_id,e.website_project_id,
               e.candidate_id)
           WHERE (e.organization_id,e.workspace_id,e.website_project_id)=
                 ($1,$2,$3)
             AND c.prospect_id=$4
             AND c.recommendation_context_version_id=$5
             AND e.invalidated_at IS NULL) "evidenceCount",
         (SELECT count(DISTINCT c.id)::integer
            FROM backlink_contact_candidates c
            JOIN backlink_contact_evidence e ON
              (e.organization_id,e.workspace_id,e.website_project_id,
               e.candidate_id)=
              (c.organization_id,c.workspace_id,c.website_project_id,c.id)
           WHERE (c.organization_id,c.workspace_id,c.website_project_id)=
                 ($1,$2,$3)
             AND c.prospect_id=$4
             AND c.recommendation_context_version_id=$5
             AND c.status IN ('candidate','promoted')
             AND c.invalidated_at IS NULL
             AND c.guessed=false
             AND c.confidence>=80
             AND c.purpose_confidence>=70
             AND c.inferred_purpose IN (
               'editorial','partnerships','advertising','business',
               'marketing','site_owner','general'
             )
             AND split_part(lower(c.normalized_email),'@',1)
               !~ '^(no-?reply|do-?not-?reply|placeholder|example|sample|test|fake|dummy)$'
             AND e.invalidated_at IS NULL
             AND e.expires_at>now()
             AND e.confidence>=80
             AND e.extraction_method IN (
               'mailto','visible_text','obfuscated_text','json_ld'
             )) "eligibleCount"`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        job.prospectId,
        job.recommendationContextVersionId,
      ],
    )).rows[0] ?? {};
    const candidateCount = Number(totals.candidateCount ?? 0);
    const evidenceCount = Number(totals.evidenceCount ?? 0);
    const eligibleCount = Number(totals.eligibleCount ?? 0);
    const retry = eligibleCount === 0
      && outcome.retryableFailures > 0
      && job.attemptCount < job.maxAttempts;
    const status = retry
      ? "retry_scheduled" as const
      : candidateCount > 0 && outcome.failures === 0
        ? "completed" as const
        : candidateCount > 0 || outcome.failures > 0
          ? "partially_completed" as const
          : "no_contact_found" as const;
    const terminalReasonCode: ContactTerminalReason | null = retry
      ? null
      : eligibleCount > 0
        ? "PUBLIC_EMAIL_FOUND"
        : outcome.signals.challenge
          ? "CAPTCHA_OR_BOT_CHALLENGE"
          : outcome.signals.loginRequired
            ? "LOGIN_REQUIRED"
            : outcome.signals.accessDenied
              ? "ACCESS_DENIED"
              : outcome.signals.contactForm
                ? "CONTACT_FORM_ONLY"
                : outcome.signals.robotsDisallowed > 0
                    && outcome.pagesVisited === 0
                  ? "ROBOTS_DISALLOWED"
                  : outcome.signals.unsupportedContent > 0
                      && outcome.signals.parsedPages === 0
                    ? "UNSUPPORTED_CONTENT"
                    : outcome.signals.transportFailures > 0
                        && outcome.pagesVisited === 0
                      ? "SITE_UNREACHABLE"
                      : candidateCount > 0
                        ? "MANUAL_REVIEW_REQUIRED"
                        : outcome.failures > 0
                          ? "COMPLETED_PARTIAL"
                          : "NO_PUBLIC_EMAIL";
    const method: ContactEnrichmentMethod = outcome.browserUsed
      ? outcome.pagesVisited > 0 ? "static_and_browser" : "browser"
      : outcome.pagesVisited > 0 ? "static" : "none";
    const lastErrorCategory = terminalReasonCode === null
      || terminalReasonCode === "PUBLIC_EMAIL_FOUND"
      || terminalReasonCode === "NO_PUBLIC_EMAIL"
      || terminalReasonCode === "CONTACT_FORM_ONLY"
      ? null
      : terminalReasonCode;
    await client.query(
      `UPDATE backlink_contact_enrichment_jobs
          SET status=$5,pages_visited=$6,candidate_count=$7,
              evidence_count=$8,browser_used=$9,last_error_code=$10,
              terminal_reason_code=$12,method=$13,last_error_category=$14,
              completed_at=CASE WHEN $12::text IS NULL THEN NULL ELSE now() END,
              retry_after=CASE WHEN $5='retry_scheduled'
                THEN now()+interval '30 seconds' ELSE NULL END,
              finished_at=CASE WHEN $5='retry_scheduled' THEN NULL ELSE now() END,
              updated_at=now(),updated_by=$11,version=version+1
        WHERE (organization_id,workspace_id,website_project_id,id)=
              ($1,$2,$3,$4)`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        input.jobId,
        status,
        outcome.pagesVisited,
        candidateCount,
        evidenceCount,
        outcome.browserUsed,
        outcome.lastErrorCode,
        input.actorId,
        terminalReasonCode,
        method,
        lastErrorCategory,
      ],
    );
    await synchronizeRecommendationPublication(client, {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      prospectId: job.prospectId,
      recommendationContextVersionId: job.recommendationContextVersionId,
      actorId: input.actorId,
    });
    await client.query(
      `UPDATE backlink_contact_enrichment_batches AS batch
          SET status=CASE WHEN EXISTS (
                SELECT 1
                  FROM backlink_contact_enrichment_jobs AS child
                 WHERE (child.organization_id,child.workspace_id,
                        child.website_project_id,child.batch_id)=
                       (batch.organization_id,batch.workspace_id,
                        batch.website_project_id,batch.id)
                   AND child.status IN (
                     'pending','running','retry_scheduled'
                   )
              ) THEN 'running' ELSE 'completed' END,
              completed_at=CASE WHEN EXISTS (
                SELECT 1
                  FROM backlink_contact_enrichment_jobs AS child
                 WHERE (child.organization_id,child.workspace_id,
                        child.website_project_id,child.batch_id)=
                       (batch.organization_id,batch.workspace_id,
                        batch.website_project_id,batch.id)
                   AND child.status IN (
                     'pending','running','retry_scheduled'
                   )
              ) THEN NULL ELSE now() END,
              updated_at=now(),updated_by=$5,version=version+1
        WHERE (batch.organization_id,batch.workspace_id,
               batch.website_project_id,batch.id)=($1,$2,$3,$4)`,
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        job.batchId,
        input.actorId,
      ],
    );
    return {
      jobId: input.jobId,
      status,
      pagesVisited: outcome.pagesVisited,
      candidateCount,
      evidenceCount,
      browserUsed: outcome.browserUsed,
      terminalReasonCode,
      method,
    };
  });
}

export function createContactEnrichmentActivity(options: Readonly<{
  pool: BacklinkTenantPool;
  browserWorker: SharedBrowserWorkerPort | null;
  fetchTimeoutMs: number;
}>) {
  const safeFetch = new SafeFetchAdapter({ timeoutMs: options.fetchTimeoutMs });
  const discovery = new ContactDiscoveryService({
    safeFetch,
    repository: createContactDiscoveryRepository(options.pool),
    newId: randomUUID,
  });
  return async (
    input: ContactEnrichmentActivityInput,
  ): Promise<ContactEnrichmentActivityResult> => {
    const job = await claimJob(options.pool, input);
    if (job === null) {
      const existing = await withBacklinkTenantTransaction(
        options.pool,
        input,
        async (client) => (await client.query(
          `SELECT status,pages_visited "pagesVisited",
                  candidate_count "candidateCount",
                  evidence_count "evidenceCount",
                  browser_used "browserUsed",
                  terminal_reason_code "terminalReasonCode",method
             FROM backlink_contact_enrichment_jobs
            WHERE (organization_id,workspace_id,website_project_id,id)=
                  ($1,$2,$3,$4)`,
          [
            input.organizationId,
            input.workspaceId,
            input.websiteProjectId,
            input.jobId,
          ],
        )).rows[0],
      );
      if (existing === undefined) throw new Error("CONTACT_JOB_NOT_FOUND");
      return {
        jobId: input.jobId,
        status: existing.status as ContactEnrichmentActivityResult["status"],
        pagesVisited: Number(existing.pagesVisited),
        candidateCount: Number(existing.candidateCount),
        evidenceCount: Number(existing.evidenceCount),
        browserUsed: existing.browserUsed === true,
        terminalReasonCode:
          (existing.terminalReasonCode as ContactTerminalReason | null) ?? null,
        method: existing.method as ContactEnrichmentMethod,
      };
    }

    const robots = new RobotsPolicyAdapter(safeFetch);
    const queue: QueuedPage[] = [
      { url: job.rootUrl, depth: 0, source: "homepage" },
      ...commonPaths.map((path): QueuedPage => ({
        url: new URL(path, job.rootUrl).toString(),
        depth: 1,
        source: "common_path",
      })),
    ];
    const queued = new Set(queue.map((page) => page.url));
    try {
      const robotsPage = await safeFetch.fetch({
        url: new URL("/robots.txt", job.rootUrl).toString(),
        purpose: "contact-enrichment",
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
        maxBytes: 512_000,
        maxRedirects: 3,
      });
      if (robotsPage.status >= 200 && robotsPage.status < 300) {
        const sitemapUrls = decoder.decode(robotsPage.body)
          .split(/\r?\n/gu)
          .flatMap((line) => {
            const match = /^sitemap:\s*(\S+)/iu.exec(line.trim());
            return match?.[1] === undefined ? [] : [match[1]];
          })
          .slice(0, 2);
        for (const sitemapUrl of sitemapUrls) {
          try {
            const sitemap = await safeFetch.fetch({
              url: sitemapUrl,
              purpose: "contact-enrichment",
              workspaceId: input.workspaceId,
              websiteProjectId: input.websiteProjectId,
              maxBytes: 1_000_000,
              maxRedirects: 3,
            });
            const $ = load(decoder.decode(sitemap.body), { xmlMode: true });
            $("loc").slice(0, job.maxPages).each((_, element) => {
              const url = normalizePageUrl($(element).text(), job.rootUrl);
              if (url === null || !sameSite(url, job.rootUrl) || queued.has(url)) {
                return;
              }
              if (!priorityPath.test(url)) {
                return;
              }
              queued.add(url);
              queue.push({ url, depth: 1, source: "robots_sitemap" });
            });
          } catch {
            // Sitemap discovery is optional evidence.
          }
        }
      }
    } catch {
      // Missing robots.txt does not block public contact discovery.
    }

    let pagesVisited = 0;
    let failures = 0;
    let retryableFailures = 0;
    let browserUsed = false;
    let browserAttempted = false;
    let lastErrorCode: string | null = null;
    const signals: CrawlSignals = {
      contactForm: false,
      loginRequired: false,
      challenge: false,
      accessDenied: false,
      robotsDisallowed: 0,
      unsupportedContent: 0,
      transportFailures: 0,
      parsedPages: 0,
    };
    const browserAuthorized = job.browserAllowed
      && options.browserWorker !== null
      && await browserEnabledForProject(options.pool, input);

    while (queue.length > 0 && pagesVisited < job.maxPages) {
      const page = queue.shift();
      if (page === undefined || page.depth > job.maxDepth) continue;
      const policy = await robots.evaluate({
        targetUrl: page.url,
        userAgent: "GrowthOS-SafeFetch/1.0",
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
      });
      if (policy.decision === "disallow") {
        signals.robotsDisallowed += 1;
        await recordPage(options.pool, input, page, {
          status: "robots_disallowed",
          errorCode: "ROBOTS_DISALLOWED",
        });
        continue;
      }
      try {
        const fetched = await safeFetch.fetch({
          url: page.url,
          purpose: "contact-enrichment",
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          maxBytes: 2_000_000,
          maxRedirects: 5,
        });
        if (fetched.status < 200 || fetched.status >= 300) {
          failures += 1;
          lastErrorCode = `HTTP_${fetched.status}`;
          const pageSignals = inspectHtml(decoder.decode(fetched.body));
          signals.challenge ||= pageSignals.challenge;
          signals.loginRequired ||=
            fetched.status === 401 || pageSignals.loginRequired;
          signals.accessDenied ||= fetched.status === 403
            && !pageSignals.challenge;
          await recordPage(options.pool, input, page, {
            status: "fetch_failed",
            httpStatus: fetched.status,
            errorCode: lastErrorCode,
          });
          continue;
        }
        pagesVisited += 1;
        const html = decoder.decode(fetched.body);
        const pageSignals = inspectHtml(html);
        signals.contactForm ||= pageSignals.contactForm;
        signals.loginRequired ||= pageSignals.loginRequired;
        signals.challenge ||= pageSignals.challenge;
        let discovered;
        try {
          discovered = await discovery.discoverFetched({
            organizationId: input.organizationId,
            workspaceId: input.workspaceId,
            websiteProjectId: input.websiteProjectId,
            recommendationContextVersionId:
              job.recommendationContextVersionId,
            prospectId: job.prospectId,
            prospectRegistrableDomain: job.registrableDomain,
            targetUrl: page.url,
            actorId: input.actorId,
          }, fetched);
        } catch (error) {
          signals.unsupportedContent += 1;
          lastErrorCode = error instanceof Error
            ? error.message.slice(0, 200)
            : "UNSUPPORTED_CONTENT";
          await recordPage(options.pool, input, page, {
            status: "unsupported_content",
            httpStatus: fetched.status,
            errorCode: lastErrorCode,
          });
          continue;
        }
        await recordPage(options.pool, input, page, {
          status: "fetched",
          httpStatus: fetched.status,
          candidateCount: discovered.candidateCount,
        });
        signals.parsedPages += 1;
        if (page.depth < job.maxDepth) {
          const prioritized: QueuedPage[] = [];
          const remaining: QueuedPage[] = [];
          for (const link of discoverLinks(html, fetched.finalUrl, page.depth)) {
            if (queued.has(link.url)) continue;
            queued.add(link.url);
            if (
              link.source === "navigation"
              || link.source === "footer"
              || priorityPath.test(link.url)
            ) {
              prioritized.push(link);
            } else {
              remaining.push(link);
            }
          }
          queue.unshift(...prioritized.slice(0, 4));
          queue.push(...remaining);
        }
        if (
          discovered.candidateCount === 0
          && browserAuthorized
          && !browserAttempted
          && !pageSignals.challenge
          && !pageSignals.loginRequired
          && dynamicPage(html)
          && pagesVisited < job.maxPages
        ) {
          browserAttempted = true;
          try {
            const rendered = await options.browserWorker.render({
              url: fetched.finalUrl,
              taskType: "contact_enrichment",
              requestId: randomUUID(),
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
              websiteProjectId: input.websiteProjectId,
              actorId: input.actorId,
            });
            const browserDiscovery = await discovery.discoverFetched({
              organizationId: input.organizationId,
              workspaceId: input.workspaceId,
              websiteProjectId: input.websiteProjectId,
              recommendationContextVersionId:
                job.recommendationContextVersionId,
              prospectId: job.prospectId,
              prospectRegistrableDomain: job.registrableDomain,
              targetUrl: page.url,
              actorId: input.actorId,
            }, rendered);
            browserUsed = true;
            await recordPage(options.pool, input, page, {
              status: "browser_fetched",
              httpStatus: 200,
              browserRendered: true,
              candidateCount: browserDiscovery.candidateCount,
            });
          } catch (error) {
            failures += 1;
            retryableFailures += 1;
            lastErrorCode = "BROWSER_FETCH_FAILED";
            await recordPage(options.pool, input, page, {
              status: "browser_failed",
              browserRendered: true,
              errorCode: error instanceof Error
                ? error.message.slice(0, 200)
                : lastErrorCode,
            });
          }
        }
      } catch (error) {
        failures += 1;
        signals.transportFailures += 1;
        if (
          typeof error === "object"
          && error !== null
          && "retryable" in error
          && error.retryable === true
        ) {
          retryableFailures += 1;
        }
        lastErrorCode = typeof error === "object"
          && error !== null
          && "code" in error
          ? String(error.code)
          : "CONTACT_PAGE_FAILED";
        await recordPage(options.pool, input, page, {
          status: "fetch_failed",
          errorCode: lastErrorCode,
        });
        if (page.depth === 0 && page.url.startsWith("https://")) {
          const fallback = `http://${page.url.slice("https://".length)}`;
          if (!queued.has(fallback)) {
            queued.add(fallback);
            queue.unshift({ ...page, url: fallback });
          }
        }
      }
    }
    return finishJob(options.pool, input, job, {
      pagesVisited,
      browserUsed,
      failures,
      retryableFailures,
      lastErrorCode,
      signals,
    });
  };
}
