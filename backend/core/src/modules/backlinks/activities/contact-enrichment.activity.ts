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
  reassessStoredContactEvidence,
} from "../application/services/contact-evidence-reassessment.service.js";
import {
  synchronizeRecommendationContactState,
} from "../application/services/recommendation-contact-synchronization.service.js";
import {
  createContactDiscoveryRepository,
} from "../db/repositories/contact-discovery.repository.js";
import {
  isCandidateEmail,
} from "../adapters/html/contact-parser.adapter.js";
import {
  withBacklinkTenantTransaction,
  type BacklinkTenantPool,
  type BacklinkTransactionClient,
} from "../db/tenant-transaction.js";
import {
  classifyContactConvergence,
  isTransientContactHttpStatus,
  shouldAttemptContactBrowserFallback,
  type ContactConvergenceSignals,
  type ContactEnrichmentMethod,
  type ContactTerminalReason,
} from "../domain/contacts/contact-convergence.js";

export type {
  ContactTerminalReason,
} from "../domain/contacts/contact-convergence.js";

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
  timing?: Readonly<{
    startedAt: string;
    durationMs: number;
    spans: readonly Readonly<{
      phase: string;
      startMs: number;
      endMs: number;
    }>[];
  }>;
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
  /(?:contact|contato|fale[-_]conosco|sobre|equipe|anuncie|publicidade|parceria|imprensa|about|team|editor|advert|partner|write-for-us|author|press|media)/iu;
const contactPath = /\/(?:contact|contato|fale[-_]conosco|anuncie|publicidade|parceria|advertis|partner)[^/]*(?:\/|$)/iu;

type CrawlSignals = {
  -readonly [Key in keyof ContactConvergenceSignals]:
    ContactConvergenceSignals[Key];
};

export async function lockContactBatchCompletion(
  client: BacklinkTransactionClient,
  input: ContactEnrichmentActivityInput,
  batchId: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
    [
      [
        input.organizationId,
        input.workspaceId,
        input.websiteProjectId,
        batchId,
        "contact-enrichment-batch-completion",
      ].join(":"),
    ],
  );
}

export function inspectContactHtml(html: string): Readonly<{
  contactForm: boolean;
  loginRequired: boolean;
  challenge: boolean;
}> {
  const $ = load(html);
  const text = $("body").text().replace(/\s+/gu, " ").trim().toLowerCase();
  const loginForm = $("form").filter((_, form) => {
    const node = $(form);
    const action = (node.attr("action") ?? "").toLowerCase();
    const formText = node.text().replace(/\s+/gu, " ").trim().toLowerCase();
    return node.find("input[type='password']").length > 0
      || (
        node.find("input[type='email'],input[name*='email']").length > 0
        && (
          /(?:sign-?in|log-?in|login)/iu.test(action)
          || /\b(?:sign in|log in)\b/iu.test(formText)
        )
      );
  }).length > 0;
  return {
    contactForm: $("form").filter((_, form) => {
      const node = $(form);
      if (node.find("input[type='password']").length > 0) return false;
      return node.find("textarea,input[name*='message'],input[name*='mensagem']").length > 0;
    }).length > 0,
    loginRequired:
      loginForm
      || /\b(?:login required|members only|subscribe to continue|paywall)\b/iu
        .test(text),
    // Public contact forms can embed a CAPTCHA without gating readable content.
    challenge:
      /\b(?:verify you are human|checking your browser|attention required|bot challenge|cloudflare ray id|complete the captcha to continue)\b/iu
        .test(text),
  };
}

function normalizePageUrl(value: string, base: string): string | null {
  try {
    const parsed = new URL(value, base);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (parsed.username || parsed.password) return null;
    parsed.hash = "";
    for (const parameter of [...parsed.searchParams.keys()]) {
      if (/^utm_/iu.test(parameter)) parsed.searchParams.delete(parameter);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function observedContactPage(
  finalUrl: string,
  rootUrl: string,
  status: number,
  signals: ReturnType<typeof inspectContactHtml>,
): Readonly<{ observedPageUrl?: string; contactPageKind?: string }> {
  if (!/^https?:\/\//iu.test(finalUrl)) return {};
  const url = normalizePageUrl(finalUrl, rootUrl);
  if (url === null || !sameSite(url, rootUrl)) return {};
  const kind = signals.challenge ? "CAPTCHA_OR_BOT_CHALLENGE"
    : status === 401 || signals.loginRequired ? "LOGIN_REQUIRED"
    : status === 403 ? "ACCESS_DENIED"
    : status >= 200 && status < 300 && signals.contactForm
      ? "CONTACT_FORM_ONLY" : null;
  return kind === null ? {} : { observedPageUrl: url, contactPageKind: kind };
}

function sameSite(left: string, right: string): boolean {
  const leftHost = new URL(left).hostname;
  const rightHost = new URL(right).hostname;
  return (getDomain(leftHost, { allowPrivateDomains: true }) ?? leftHost)
    === (getDomain(rightHost, { allowPrivateDomains: true }) ?? rightHost);
}

function discoverLinks(
  html: string,
  pageUrl: string,
  depth: number,
): readonly QueuedPage[] {
  const $ = load(html);
  const links = new Map<string, QueuedPage>();
  $("a[href]").each((_, element) => {
    const href = ($(element).attr("href") ?? "").trim();
    if (isCandidateEmail(href)) return;
    const url = normalizePageUrl(href, pageUrl);
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
    observedPageUrl?: string;
    contactPageKind?: string;
  }>,
): Promise<void> {
  await withBacklinkTenantTransaction(pool, input, (client) => client.query(
    `INSERT INTO backlink_contact_enrichment_pages (
       id,organization_id,workspace_id,website_project_id,job_id,page_url,
       depth,discovery_source,status,http_status,browser_rendered,
       candidate_count,content_sha256,error_code,created_by,
       observed_page_url,contact_page_kind
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
     )
     ON CONFLICT (
       organization_id,workspace_id,website_project_id,job_id,page_url
     ) DO UPDATE SET
       status=EXCLUDED.status,http_status=EXCLUDED.http_status,
       browser_rendered=EXCLUDED.browser_rendered,
       candidate_count=EXCLUDED.candidate_count,
       content_sha256=EXCLUDED.content_sha256,
       error_code=EXCLUDED.error_code,
       observed_page_url=CASE WHEN EXCLUDED.http_status IS NOT NULL
         THEN EXCLUDED.observed_page_url
         ELSE backlink_contact_enrichment_pages.observed_page_url END,
       contact_page_kind=CASE WHEN EXCLUDED.http_status IS NOT NULL
         THEN EXCLUDED.contact_page_kind
         ELSE backlink_contact_enrichment_pages.contact_page_kind END,
       observed_at=now()`,
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
      result.observedPageUrl ?? null,
      result.contactPageKind ?? null,
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
    await lockContactBatchCompletion(client, input, job.batchId);
    await reassessStoredContactEvidence(client, {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      websiteProjectId: input.websiteProjectId,
      recommendationContextVersionId: job.recommendationContextVersionId,
      prospectId: job.prospectId,
      actorId: input.actorId,
    });
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
               'press','editorial','partnerships','advertising','business',
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
    const convergence = classifyContactConvergence({
      eligibleCount,
      candidateCount,
      failures: outcome.failures,
      retryableFailures: outcome.retryableFailures,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      pagesVisited: outcome.pagesVisited,
      browserUsed: outcome.browserUsed,
      signals: outcome.signals,
    });
    const {
      status,
      terminalReasonCode,
      method,
      lastErrorCategory,
    } = convergence;
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
    await synchronizeRecommendationContactState(client, {
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
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const spans: { phase: string; startMs: number; endMs: number }[] = [];
    const measure = async <T>(
      phase: string, operation: () => Promise<T>,
    ): Promise<T> => {
      const startMs = performance.now() - started;
      try {
        return await operation();
      } finally {
        spans.push({ phase, startMs, endMs: performance.now() - started });
      }
    };
    const fetchPage = (request: Parameters<SafeFetchAdapter["fetch"]>[0]) =>
      measure("public_http", () => safeFetch.fetch(request));
    const discover = (
      context: Parameters<ContactDiscoveryService["discoverFetched"]>[0],
      page: Parameters<ContactDiscoveryService["discoverFetched"]>[1],
    ) => measure("contact_parse_and_persist",
      () => discovery.discoverFetched(context, page));
    const record = (
      page: QueuedPage, outcome: Parameters<typeof recordPage>[3],
    ) => measure("page_persistence",
      () => recordPage(options.pool, input, page, outcome));
    const job = await measure("job_claim",
      () => claimJob(options.pool, input));
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
      const robotsPage = await fetchPage({
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
            const sitemap = await fetchPage({
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
    let pagesAttempted = 0;
    let failures = 0;
    let retryableFailures = 0;
    let browserUsed = false;
    let browserAttempted = false;
    const browserPages = new Set<string>();
    let browserAvailableForLinks = false;
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
    const browserConfigured = job.browserAllowed
      && await measure("browser_authorization",
        () => browserEnabledForProject(options.pool, input));
    const browserWorker = options.browserWorker;
    const browserAuthorized = browserConfigured && browserWorker !== null;
    const enqueueLinks = (html: string, finalUrl: string, depth: number) => {
      if (depth >= job.maxDepth) return;
      const links = discoverLinks(html, finalUrl, depth)
        .filter(link => sameSite(link.url, job.rootUrl) && !queued.has(link.url));
      const prioritized = links.filter(link => priorityPath.test(link.url)
        || link.source === "navigation" || link.source === "footer")
        .sort((left, right) =>
          (Number(contactPath.test(right.url)) * 2 + Number(priorityPath.test(right.url)))
          - (Number(contactPath.test(left.url)) * 2 + Number(priorityPath.test(left.url))));
      const remaining = links.filter(link => !prioritized.includes(link));
      for (const link of [...prioritized.slice(0, 4), ...remaining]) {
        queued.add(link.url);
      }
      queue.unshift(...prioritized.slice(0, 4));
      queue.push(...remaining);
    };
    const attemptBrowser = async (
      page: QueuedPage,
      targetUrl: string,
    ): Promise<void> => {
      browserAttempted = true;
      if (browserWorker === null || browserPages.has(targetUrl)
        || browserPages.size >= job.maxPages) return;
      browserPages.add(targetUrl);
      try {
        const rendered = await measure("browser_render", () => browserWorker.render({
          url: targetUrl,
          taskType: "contact_enrichment",
          requestId: randomUUID(),
          organizationId: input.organizationId,
          workspaceId: input.workspaceId,
          websiteProjectId: input.websiteProjectId,
          actorId: input.actorId,
        }));
        browserUsed = true;
        const html = decoder.decode(rendered.body);
        const renderedSignals = inspectContactHtml(html);
        const pageEvidence = observedContactPage(
          rendered.finalUrl, job.rootUrl, rendered.status, renderedSignals,
        );
        signals.challenge ||= renderedSignals.challenge;
        signals.loginRequired ||= renderedSignals.loginRequired;
        signals.contactForm ||= renderedSignals.contactForm;
        if (rendered.status < 200 || rendered.status >= 300
          || renderedSignals.challenge || renderedSignals.loginRequired) {
          browserAvailableForLinks = false;
          failures += 1;
          lastErrorCode = `BROWSER_HTTP_${rendered.status}`;
          await record(page, {
            status: "browser_failed", httpStatus: rendered.status,
            browserRendered: true, errorCode: lastErrorCode,
            ...pageEvidence,
          });
          return;
        }
        const browserDiscovery = await discover({
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
        browserAvailableForLinks = true;
        signals.parsedPages += 1;
        enqueueLinks(html, rendered.finalUrl, page.depth);
        await record(page, {
          status: "browser_fetched",
          httpStatus: 200,
          browserRendered: true,
          candidateCount: browserDiscovery.candidateCount,
          ...pageEvidence,
        });
      } catch (error) {
        failures += 1;
        retryableFailures += 1;
        lastErrorCode = "BROWSER_FETCH_FAILED";
        await record(page, {
          status: "browser_failed",
          browserRendered: true,
          errorCode: error instanceof Error
            ? error.message.slice(0, 200)
            : lastErrorCode,
        });
      }
    };

    const maxPageAttempts = job.maxPages * 2;
    while (
      queue.length > 0
      && pagesVisited < job.maxPages
      && pagesAttempted < maxPageAttempts
    ) {
      const page = queue.shift();
      if (page === undefined || page.depth > job.maxDepth) continue;
      pagesAttempted += 1;
      const policy = await measure("robots_policy", () => robots.evaluate({
        targetUrl: page.url,
        userAgent: "GrowthOS-SafeFetch/1.0",
        workspaceId: input.workspaceId,
        websiteProjectId: input.websiteProjectId,
      }));
      if (policy.decision === "disallow") {
        signals.robotsDisallowed += 1;
        await record(page, {
          status: "robots_disallowed",
          errorCode: "ROBOTS_DISALLOWED",
        });
        continue;
      }
      try {
        const fetched = await fetchPage({
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
          if (isTransientContactHttpStatus(fetched.status)) {
            retryableFailures += 1;
            signals.transportFailures += 1;
          }
          const pageSignals = inspectContactHtml(decoder.decode(fetched.body));
          signals.challenge ||= pageSignals.challenge;
          signals.loginRequired ||=
            fetched.status === 401 || pageSignals.loginRequired;
          signals.accessDenied ||= fetched.status === 403
            && !pageSignals.challenge;
          await record(page, {
            status: "fetch_failed",
            httpStatus: fetched.status,
            errorCode: lastErrorCode,
            ...observedContactPage(
              fetched.finalUrl, job.rootUrl, fetched.status, pageSignals,
            ),
          });
          if (shouldAttemptContactBrowserFallback({
            browserAuthorized,
            browserAttempted: browserAttempted && !browserAvailableForLinks,
            status: fetched.status,
            challenge: pageSignals.challenge,
          })) {
            await attemptBrowser(page, fetched.finalUrl);
          }
          continue;
        }
        pagesVisited += 1;
        const html = decoder.decode(fetched.body);
        const pageSignals = inspectContactHtml(html);
        const pageEvidence = observedContactPage(
          fetched.finalUrl, job.rootUrl, fetched.status, pageSignals,
        );
        signals.contactForm ||= pageSignals.contactForm;
        signals.loginRequired ||= pageSignals.loginRequired;
        signals.challenge ||= pageSignals.challenge;
        let discovered;
        try {
          discovered = await discover({
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
          await record(page, {
            status: "unsupported_content",
            httpStatus: fetched.status,
            errorCode: lastErrorCode,
            ...pageEvidence,
          });
          continue;
        }
        await record(page, {
          status: "fetched",
          httpStatus: fetched.status,
          candidateCount: discovered.candidateCount,
          ...pageEvidence,
        });
        signals.parsedPages += 1;
        enqueueLinks(html, fetched.finalUrl, page.depth);
        if (
          discovered.candidateCount === 0
          && browserAuthorized
          && (!browserAttempted || browserAvailableForLinks)
          && !pageSignals.challenge
          && !pageSignals.loginRequired
          && dynamicPage(html)
          && pagesVisited < job.maxPages
        ) {
          await attemptBrowser(page, fetched.finalUrl);
        } else if (
          discovered.candidateCount === 0
          && browserConfigured
          && browserWorker === null
          && !browserAttempted
          && !pageSignals.challenge
          && !pageSignals.loginRequired
          && dynamicPage(html)
        ) {
          browserAttempted = true;
          failures += 1;
          retryableFailures += 1;
          signals.transportFailures += 1;
          lastErrorCode = "BROWSER_UNAVAILABLE";
          await record(page, {
            status: "browser_failed",
            browserRendered: false,
            errorCode: lastErrorCode,
          });
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
        await record(page, {
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
    const result = await measure("job_completion_persistence",
      () => finishJob(options.pool, input, job, {
      pagesVisited,
      browserUsed,
      failures,
      retryableFailures,
      lastErrorCode,
      signals,
      }));
    // Activity results persist in Temporal history, including failed HTTP spans.
    return {
      ...result,
      timing: { startedAt, durationMs: performance.now() - started, spans },
    };
  };
}
