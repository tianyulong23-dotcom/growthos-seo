import { createHash } from "node:crypto";

import type {
  BacklinkSnapshotRequest,
} from "../../ports/dataforseo.port.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    .join(",")}}`;
}

function normalizeTarget(request: BacklinkSnapshotRequest): string {
  const target = request.target.trim();
  if (request.targetType === "page") {
    return target;
  }
  return target.toLowerCase().replace(/\.+$/u, "");
}

export function createProviderArtifactFingerprint(input: Readonly<{
  provider: "dataforseo";
  endpoint: string;
  requestSchemaVersion: number;
  responseSchemaVersion: string;
  locationCode: string;
  languageCode: string;
  request: BacklinkSnapshotRequest;
}>): string {
  const canonicalRequest: JsonValue = {
    endpoint: input.endpoint,
    languageCode: input.languageCode.trim().toLowerCase(),
    limit: input.request.limit,
    locationCode: input.locationCode.trim().toUpperCase(),
    provider: input.provider,
    requestSchemaVersion: input.requestSchemaVersion,
    responseSchemaVersion: input.responseSchemaVersion,
    target: normalizeTarget(input.request),
    targetType: input.request.targetType,
  };
  return createHash("sha256")
    .update(stableJson(canonicalRequest))
    .digest("hex");
}
