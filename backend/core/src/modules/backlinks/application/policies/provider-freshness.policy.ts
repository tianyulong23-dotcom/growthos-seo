import type {
  DataForSeoRequestIntent,
} from "../../ports/dataforseo.port.js";

const hour = 60 * 60 * 1_000;
const day = 24 * hour;

const windows = {
  DISCOVERY: { freshMs: 7 * day, staleMs: 30 * day },
  CARD_ENRICHMENT: { freshMs: 7 * day, staleMs: 21 * day },
  DEEP_ASSESSMENT: { freshMs: day, staleMs: 3 * day },
  MONITORING: { freshMs: 7 * day, staleMs: 30 * day },
  NEGATIVE: { freshMs: 6 * hour, staleMs: day },
} as const;

export type ProviderArtifactFreshness =
  | "fresh"
  | "stale"
  | "expired";

export type ProviderArtifactFreshnessWindow = Readonly<{
  qualityStatus: "complete" | "negative";
  freshUntil: Date;
  staleUntil: Date;
}>;

function checkedDate(value: number): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("Provider Artifact freshness time is invalid");
  }
  return date;
}

export function createProviderArtifactFreshnessWindow(input: Readonly<{
  intent: DataForSeoRequestIntent;
  observedAt: Date;
  negative: boolean;
}>): ProviderArtifactFreshnessWindow {
  const window = input.negative ? windows.NEGATIVE : windows[input.intent];
  const observedAt = input.observedAt.getTime();
  if (!Number.isFinite(observedAt)) {
    throw new TypeError("Provider Artifact observedAt is invalid");
  }
  return {
    qualityStatus: input.negative ? "negative" : "complete",
    freshUntil: checkedDate(observedAt + window.freshMs),
    staleUntil: checkedDate(observedAt + window.staleMs),
  };
}

export function classifyProviderArtifactFreshness(input: Readonly<{
  now: Date;
  freshUntil: Date;
  staleUntil: Date;
}>): ProviderArtifactFreshness {
  const now = input.now.getTime();
  const freshUntil = input.freshUntil.getTime();
  const staleUntil = input.staleUntil.getTime();
  if (
    ![now, freshUntil, staleUntil].every(Number.isFinite) ||
    freshUntil > staleUntil
  ) {
    throw new TypeError("Provider Artifact freshness window is invalid");
  }
  if (now < freshUntil) {
    return "fresh";
  }
  return now < staleUntil ? "stale" : "expired";
}
