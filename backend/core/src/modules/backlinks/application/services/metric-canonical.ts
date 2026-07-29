import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw new TypeError("Canonical dates must be valid.");
    }
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Canonical numbers must be finite.");
    }
    return value;
  }
  throw new TypeError("Canonical values must be JSON-compatible.");
}

export function canonicalMetricJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function metricSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalMetricJson(value))
    .digest("hex");
}
