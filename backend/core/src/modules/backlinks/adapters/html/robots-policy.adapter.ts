import robotsParser from "robots-parser";
import type { SafeFetchPort } from "../../ports/safe-fetch.port.js";

type ParsedRobots = Readonly<{
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  isDisallowed(url: string, userAgent?: string): boolean | undefined;
  getCrawlDelay(userAgent?: string): number | undefined;
}>;
type RobotsDocument =
  | Readonly<{ status: "parsed"; rules: ParsedRobots }>
  | Readonly<{ status: "unavailable" | "parse_failed" }>;
const parseRobots = robotsParser as unknown as (
  url: string, contents: string,
) => ParsedRobots;

export type CrawlPolicyDecision = "allow" | "disallow" | "unknown";
export type RobotsPolicyReason =
  | "robots_allowed"
  | "robots_disallowed"
  | "robots_unavailable"
  | "robots_parse_failed"
  | "robots_unknown";
export type RobotsPolicyRequest = Readonly<{
  targetUrl: string;
  userAgent: string;
  workspaceId: string;
  websiteProjectId: string;
}>;
export type RobotsEvidence = Readonly<{
  targetUrl: string;
  robotsUrl: string | null;
  userAgent: string;
  decision: CrawlPolicyDecision;
  reason: RobotsPolicyReason;
  crawlDelaySeconds: number | undefined;
}>;

const maxRobotsBytes = 512_000;
const maxRobotsRedirects = 3;
const decoder = new TextDecoder("utf-8", { fatal: true });

function evidence(
  request: RobotsPolicyRequest,
  robotsUrl: string | null,
  decision: CrawlPolicyDecision,
  reason: RobotsPolicyReason,
  crawlDelaySeconds?: number,
): RobotsEvidence {
  return Object.freeze({
    targetUrl: request.targetUrl,
    robotsUrl,
    userAgent: request.userAgent,
    decision,
    reason,
    crawlDelaySeconds,
  });
}

function target(request: RobotsPolicyRequest): {
  targetUrl: string; robotsUrl: string;
} | undefined {
  try {
    const url = new URL(request.targetUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      request.userAgent.trim() === ""
    ) {
      return undefined;
    }
    url.hash = "";
    return {
      targetUrl: url.toString(),
      robotsUrl: new URL("/robots.txt", url.origin).toString(),
    };
  } catch {
    return undefined;
  }
}

export class RobotsPolicyAdapter {
  private readonly documents = new Map<string, Promise<RobotsDocument>>();

  constructor(private readonly safeFetch: SafeFetchPort) {}

  private document(
    request: RobotsPolicyRequest,
    robotsUrl: string,
  ): Promise<RobotsDocument> {
    const key = [
      request.workspaceId,
      request.websiteProjectId,
      robotsUrl,
    ].join(":");
    const existing = this.documents.get(key);
    if (existing !== undefined) return existing;
    const pending = (async (): Promise<RobotsDocument> => {
      let fetched;
      try {
        fetched = await this.safeFetch.fetch({
          url: robotsUrl,
          purpose: "contact-enrichment",
          workspaceId: request.workspaceId,
          websiteProjectId: request.websiteProjectId,
          maxBytes: maxRobotsBytes,
          maxRedirects: maxRobotsRedirects,
        });
      } catch {
        return { status: "unavailable" };
      }
      if (fetched.status < 200 || fetched.status >= 300) {
        return { status: "unavailable" };
      }
      try {
        return {
          status: "parsed",
          rules: parseRobots(robotsUrl, decoder.decode(fetched.body)),
        };
      } catch {
        return { status: "parse_failed" };
      }
    })();
    this.documents.set(key, pending);
    return pending;
  }

  async evaluate(request: RobotsPolicyRequest): Promise<RobotsEvidence> {
    const urls = target(request);
    if (urls === undefined) {
      return evidence(request, null, "unknown", "robots_unavailable");
    }
    const document = await this.document(request, urls.robotsUrl);
    if (document.status !== "parsed") {
      return evidence(
        request,
        urls.robotsUrl,
        "unknown",
        document.status === "parse_failed"
          ? "robots_parse_failed"
          : "robots_unavailable",
      );
    }
    const disallowed = document.rules.isDisallowed(
      urls.targetUrl,
      request.userAgent,
    );
    const allowed = document.rules.isAllowed(urls.targetUrl, request.userAgent);
    const decision = disallowed === true || allowed === false
      ? "disallow"
      : allowed === true || disallowed === false
        ? "allow"
        : "unknown";
    const parsedDelay = document.rules.getCrawlDelay(request.userAgent);
    const delay = Number.isFinite(parsedDelay) && (parsedDelay ?? -1) >= 0
      ? parsedDelay
      : undefined;
    return evidence(
      request,
      urls.robotsUrl,
      decision,
      decision === "disallow"
        ? "robots_disallowed"
        : decision === "allow" ? "robots_allowed" : "robots_unknown",
      delay,
    );
  }
}
