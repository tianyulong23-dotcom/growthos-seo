import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createEvidenceValueSchema, discoveryRequestSchema, evidencePortFailureCodes,
  evidencePortFailureSchema, evidenceRequestContextSchema,
  evidenceRequestSchema, evidenceSnapshotSchema, graphRequestSchema,
  siteAuditRequestSchema, type DiscoveryPort, type EvidencePort,
  type GraphPort, type SiteAuditPort,
} from "../../src/modules/backlinks/ports/evidence.port.js";
const context = {
  organizationId: "org-1", workspaceId: "workspace-1",
  websiteProjectId: "project-1", requestId: "request-1",
  dedupeKey: "evidence:project-1:example.com",
  schemaVersion: "open-evidence.v1",
  limits: { timeoutMs: 10_000, maxItems: 100 },
} as const;
const metadata = {
  sourceType: "domain_graph", sourceReleaseId: "release-2026-07",
  confidence: 0.95, observedAt: "2026-07-25T02:00:00.000Z",
  stale: false, evidenceRefs: ["evidence-1"],
} as const;
const observed = { ...metadata, availability: "observed", value: 12 } as const;
const unavailable = {
  ...metadata, availability: "unavailable", confidence: 0,
  evidenceRefs: [], reason: "partial_scan",
} as const;
const snapshot = {
  subject: "example.com", subjectType: "domain",
  fields: [
    { key: "referring_domain_count", result: observed },
    { key: "anchor_texts", result: unavailable },
  ],
} as const;

describe("provider-neutral evidence contracts", () => {
  it("accepts observed, derived, unavailable, and partial results", () => {
    const schema = createEvidenceValueSchema(z.number().finite());
    expect(schema.parse(observed)).toEqual(observed);
    expect(schema.parse({
      ...metadata, availability: "derived", value: 0.72,
      derivationRuleVersion: "centrality.v1",
    })).toMatchObject({ availability: "derived" });
    expect(schema.parse(unavailable)).toEqual(unavailable);
    expect(evidenceSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects missing, unknown, and fake unavailable values", () => {
    const schema = createEvidenceValueSchema(z.number().finite());
    for (const field of [
      "availability", "sourceReleaseId", "confidence",
      "observedAt", "evidenceRefs",
    ]) {
      const candidate: Record<string, unknown> = { ...observed };
      Reflect.deleteProperty(candidate, field);
      expect(schema.safeParse(candidate).success, field).toBe(false);
    }
    expect(schema.safeParse({ ...observed, providerTaskId: "task-1" }).success)
      .toBe(false);
    expect(schema.safeParse({ ...unavailable, value: 0 }).success).toBe(false);
  });

  it("enforces resource limits and normalized timeout retryability", () => {
    expect(evidenceRequestContextSchema.parse(context)).toEqual(context);
    expect(evidenceRequestContextSchema.safeParse({
      ...context, limits: { ...context.limits, timeoutMs: 0 },
    }).success).toBe(false);
    const timeout = {
      code: evidencePortFailureCodes.timeout, requestId: context.requestId,
      message: "Evidence source timed out.", retryable: true,
    } as const;
    expect(evidencePortFailureSchema.parse(timeout)).toEqual(timeout);
    expect(evidencePortFailureSchema.safeParse({
      ...timeout, retryable: false,
    }).success).toBe(false);
  });

  it("exposes strict Evidence, Graph, Discovery, and SiteAudit ports", async () => {
    const evidence: EvidencePort = { collect: async () => snapshot };
    const graph: GraphPort = { query: async () => snapshot };
    const discovery: DiscoveryPort = { discover: async () => snapshot };
    const audit: SiteAuditPort = { audit: async () => snapshot };
    const results = await Promise.all([
      evidence.collect(evidenceRequestSchema.parse({
        context, target: "example.com", targetType: "domain", featureKeys: ["referring_domain_count"],
      })),
      graph.query(graphRequestSchema.parse({ context, target: "example.com", direction: "both" })),
      discovery.discover(discoveryRequestSchema.parse({
        context, target: "example resources", locale: "en-US" })),
      audit.audit(siteAuditRequestSchema.parse({ context, target: "https://example.com/" })),
    ]);
    expect(results).toEqual([snapshot, snapshot, snapshot, snapshot]);
    expect(graphRequestSchema.safeParse({
      context, target: "example.com", direction: "both", provider: "legacy",
    }).success).toBe(false);
  });

  it("keeps Domain and Port source free of legacy provider DTOs", () => {
    const source = [
      "../../src/modules/backlinks/domain/evidence/evidence.ts",
      "../../src/modules/backlinks/ports/evidence.port.ts",
    ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
      .join("\n");
    expect(source).not.toMatch(
      /dataforseo|task_cost|tasks_error|providerTaskId|login|password/i,
    );
  });
});
