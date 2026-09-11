import { createHash } from "node:crypto";

import {
  BacklinkError,
  backlinkErrorCodes,
} from "../../domain/errors/backlink-error.js";
import {
  decideRecommendationSecondRound,
  recommendationDiscoveryBudgetPolicyVersion,
  type RecommendationDiscoveryRequestPlan,
  type RecommendationDiscoveryStopReason,
  type RecommendationDiscoveryWindow,
} from "../../domain/recommendations/recommendation-pool-v2-policy.js";
import type {
  RecommendationDiscoveryGenerationLineage,
  RecommendationDiscoveryPersistedState,
  RecommendationDiscoveryRequestIntent,
  RecommendationDiscoveryRoundFact,
  RecommendationDiscoveryRoundFactInput,
  RecommendationDiscoveryTerminalFact,
  RecommendationDiscoveryTerminalFactInput,
  RecommendationPoolV2DiscoveryLedgerRepository,
} from "../../db/repositories/recommendation-pool-v2-discovery-ledger.repository.js";

type ChangedDimension =
  RecommendationDiscoveryRoundFactInput["changedDimensions"][number];

export type RecommendationPoolV2ProposedRound2Path =
  RecommendationDiscoveryRequestPlan &
    Readonly<{
      canonicalPathFingerprint: string;
    }>;

export type RecommendationPoolV2DiscoveryCompletionRound = Readonly<{
  roundNumber: 1 | 2;
  requestPlan: RecommendationDiscoveryRequestPlan;
  canonicalRequestFingerprints: readonly string[];
  canonicalPathFingerprints: readonly string[];
  completedWindowCount: number;
  completedRequestCount: number;
  rawCandidateCount: number;
  effectiveCandidateCount: number;
  newUniqueCount: number;
  duplicateCount: number;
  authorizedCostMicros: number;
  settledCostMicros: number | null;
  chargeState: "SETTLED" | "UNKNOWN_CHARGE";
  completedAt: string;
}>;

export type RecommendationPoolV2DiscoveryCompletionState = Readonly<{
  policyVersion: string;
  activeRound: 1 | 2;
  rounds: readonly RecommendationPoolV2DiscoveryCompletionRound[];
  completedWindows: readonly RecommendationDiscoveryWindow[];
  canonicalRequestSetFingerprint: string;
}>;

export type RecommendationPoolV2DiscoveryCompletionDecision =
  | Readonly<{
      kind: "START_ROUND_2";
      policyVersion: typeof recommendationDiscoveryBudgetPolicyVersion;
      round: 2;
      authorizedCostMicros: number;
      canonicalRequestFingerprint: string;
      canonicalPathFingerprint: string;
      changedDimensions: readonly ChangedDimension[];
    }>
  | Readonly<{
      kind: "STOP";
      policyVersion: typeof recommendationDiscoveryBudgetPolicyVersion;
      reason: RecommendationDiscoveryStopReason;
    }>;

export type RecommendationPoolV2DiscoveryFinalizationResult =
  | Readonly<{
      kind: "START_ROUND_2";
      policyVersion: typeof recommendationDiscoveryBudgetPolicyVersion;
      round: 2;
      authorizedCostMicros: number;
      canonicalRequestFingerprint: string;
      canonicalPathFingerprint: string;
      changedDimensions: readonly ChangedDimension[];
      roundFact: RecommendationDiscoveryRoundFact;
      terminalFact: null;
    }>
  | Readonly<{
      kind: "TERMINAL";
      policyVersion: typeof recommendationDiscoveryBudgetPolicyVersion;
      reason: RecommendationDiscoveryStopReason;
      roundFact: RecommendationDiscoveryRoundFact;
      terminalFact: RecommendationDiscoveryTerminalFact;
    }>;

const finalizerCreatedBy = "recommendation-discovery-finalizer.v1";

function conflict(message: string): BacklinkError {
  return new BacklinkError({
    code: backlinkErrorCodes.conflict,
    message,
  });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function maxDate(values: readonly string[]): string {
  const latest = Math.max(...values.map((value) => new Date(value).getTime()));
  if (!Number.isFinite(latest)) {
    throw conflict("Persisted discovery completion time is invalid.");
  }
  return new Date(latest).toISOString();
}

function fingerprint(values: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...values].sort()))
    .digest("hex");
}

function semanticUuid(namespace: string, value: unknown): string {
  const hash = createHash("sha256")
    .update(`${namespace}:${JSON.stringify(value)}`)
    .digest("hex");
  const variants = ["8", "9", "a", "b"] as const;
  const variant =
    variants[Number.parseInt(hash.charAt(16), 16) % variants.length];
  if (variant === undefined) {
    throw conflict("Unable to derive a semantic discovery fact identifier.");
  }
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(
    13,
    16,
  )}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function changedDimensions(
  from: RecommendationDiscoveryRequestPlan,
  to: RecommendationDiscoveryRequestPlan,
): readonly ChangedDimension[] {
  const changed: ChangedDimension[] = [];
  if (from.keywordFingerprint !== to.keywordFingerprint) {
    changed.push("KEYWORD");
  }
  if (from.competitorFingerprint !== to.competitorFingerprint) {
    changed.push("COMPETITOR");
  }
  if (from.sourceType !== to.sourceType) {
    changed.push("SOURCE");
  }
  if (from.pageType !== to.pageType) {
    changed.push("PAGE");
  }
  if (from.strategyVersion !== to.strategyVersion) {
    changed.push("STRATEGY");
  }
  return Object.freeze(changed);
}

function protectedScopeChanged(
  from: RecommendationDiscoveryRequestPlan,
  to: RecommendationDiscoveryRequestPlan,
): boolean {
  return (
    from.countryCode !== to.countryCode ||
    from.languageCode !== to.languageCode ||
    from.businessDirectionFingerprint !== to.businessDirectionFingerprint
  );
}

function activeCompletionRound(
  state: RecommendationPoolV2DiscoveryCompletionState,
): RecommendationPoolV2DiscoveryCompletionRound {
  const active = state.rounds.find(
    (round) => round.roundNumber === state.activeRound,
  );
  if (active === undefined) {
    throw conflict("Persisted discovery state has no active completed round.");
  }
  return active;
}

export function decideRecommendationPoolV2DiscoveryCompletion(
  input: Readonly<{
    state: RecommendationPoolV2DiscoveryCompletionState;
    proposedRound2Path: RecommendationPoolV2ProposedRound2Path | null;
    contextSuperseded: boolean;
  }>,
): RecommendationPoolV2DiscoveryCompletionDecision {
  const active = activeCompletionRound(input.state);
  const proposedRound2Path = input.proposedRound2Path;
  const generationUniqueCount = sum(
    input.state.rounds.map((round) => round.newUniqueCount),
  );
  const generationSettledCostMicros = sum(
    input.state.rounds.map((round) => round.settledCostMicros ?? 0),
  );
  const chargeState = input.state.rounds.some(
    (round) => round.chargeState === "UNKNOWN_CHARGE",
  )
    ? "unknown_charge"
    : "settled";
  const existingRequestFingerprints = new Set(
    input.state.rounds.flatMap((round) => round.canonicalRequestFingerprints),
  );
  const existingPathFingerprints = new Set(
    input.state.rounds.flatMap((round) => round.canonicalPathFingerprints),
  );

  let round2Request: RecommendationDiscoveryRequestPlan | null =
    input.state.activeRound === 1 ? proposedRound2Path : null;
  let pathsExhausted =
    input.state.activeRound === 2 || proposedRound2Path === null;
  if (
    round2Request !== null &&
    proposedRound2Path !== null &&
    !protectedScopeChanged(active.requestPlan, round2Request) &&
    (existingRequestFingerprints.has(
      round2Request.canonicalRequestFingerprint,
    ) ||
      existingPathFingerprints.has(
        proposedRound2Path.canonicalPathFingerprint,
      ) ||
      changedDimensions(active.requestPlan, round2Request).length === 0)
  ) {
    round2Request = null;
    pathsExhausted = true;
  }

  const decision = decideRecommendationSecondRound({
    policyVersion: input.state.policyVersion,
    round1UniqueCandidateCount: generationUniqueCount,
    round1SettledCostMicros: active.settledCostMicros ?? 0,
    generationSettledCostMicros,
    chargeState,
    pathsExhausted,
    contextSuperseded: input.contextSuperseded,
    round1Request: active.requestPlan,
    round2Request,
    completedWindows: input.state.completedWindows,
  });
  if (decision.kind === "STOP") {
    return Object.freeze({
      kind: "STOP",
      policyVersion: recommendationDiscoveryBudgetPolicyVersion,
      reason: decision.reason,
    });
  }

  const proposal = input.proposedRound2Path;
  if (proposal === null) {
    throw conflict("Round 2 policy started without a persisted proposal.");
  }
  return Object.freeze({
    ...decision,
    canonicalPathFingerprint: proposal.canonicalPathFingerprint,
    changedDimensions: changedDimensions(active.requestPlan, proposal),
  });
}

function requestPlan(
  request: RecommendationDiscoveryRequestIntent,
  authorizedCostMicros: number,
): RecommendationDiscoveryRequestPlan {
  const keywordFingerprint =
    request.seedKind === "SEO_COMPETITOR"
      ? "seed-dimension:not-applicable"
      : request.seedFingerprint;
  const competitorFingerprint =
    request.seedKind === "SEO_COMPETITOR"
      ? request.seedFingerprint
      : "seed-dimension:not-applicable";
  return Object.freeze({
    canonicalRequestFingerprint: request.canonicalRequestFingerprint,
    keywordFingerprint,
    competitorFingerprint,
    sourceType: request.discoverySource,
    pageType: request.pageType,
    strategyVersion: request.requestType,
    countryCode: request.countryCode,
    languageCode: request.languageCode,
    businessDirectionFingerprint: request.businessDirectionFingerprint,
    authorizedCostMicros,
  });
}

function deriveCompletionState(
  persisted: RecommendationDiscoveryPersistedState,
): RecommendationPoolV2DiscoveryCompletionState {
  const outcomesByRequest = new Map(
    persisted.requestOutcomes.map((outcome) => [
      outcome.requestIntentId,
      outcome,
    ]),
  );
  const roundNumbers = [
    ...new Set(persisted.requestIntents.map((intent) => intent.roundNumber)),
  ].sort();
  if (roundNumbers.length === 0) {
    throw conflict("Discovery generation has no persisted request facts.");
  }

  const rounds = roundNumbers.map((roundNumber) => {
    const intents = persisted.requestIntents.filter(
      (intent) => intent.roundNumber === roundNumber,
    );
    const outcomes = intents.map((intent) => {
      const outcome = outcomesByRequest.get(intent.id);
      if (outcome === undefined) {
        throw conflict(
          "Discovery generation contains an incomplete Provider request.",
        );
      }
      return outcome;
    });
    const windows = persisted.windowFacts.filter(
      (window) => window.roundNumber === roundNumber,
    );
    if (windows.length === 0) {
      throw conflict("Discovery generation has no completed window facts.");
    }

    const rawCandidateCount = sum(
      outcomes.map((outcome) => outcome.rawCandidateCount),
    );
    const effectiveCandidateCount = sum(
      outcomes.map((outcome) => outcome.effectiveCandidateCount),
    );
    const newUniqueCount = sum(
      outcomes.map((outcome) => outcome.newUniqueCount),
    );
    const duplicateCount = sum(
      outcomes.map((outcome) => outcome.duplicateCount),
    );
    const authorizedCostMicros = sum(
      intents.map((intent) => intent.authorizedCostMicros),
    );
    const windowTotals = {
      requests: sum(windows.map((window) => window.completedRequestCount)),
      raw: sum(windows.map((window) => window.rawCandidateCount)),
      effective: sum(windows.map((window) => window.effectiveCandidateCount)),
      fresh: sum(windows.map((window) => window.newUniqueCount)),
      duplicate: sum(windows.map((window) => window.duplicateCount)),
      authorized: sum(
        windows.map((window) => window.windowAuthorizedCostMicros),
      ),
    };
    if (
      windowTotals.requests !== intents.length ||
      windowTotals.raw !== rawCandidateCount ||
      windowTotals.effective !== effectiveCandidateCount ||
      windowTotals.fresh !== newUniqueCount ||
      windowTotals.duplicate !== duplicateCount ||
      windowTotals.authorized !== authorizedCostMicros
    ) {
      throw conflict(
        "Discovery request outcomes and completed windows do not agree.",
      );
    }

    const unknownCharge =
      outcomes.some((outcome) => outcome.chargeState === "UNKNOWN_CHARGE") ||
      windows.some((window) => window.chargeState === "UNKNOWN_CHARGE");
    const firstIntent = intents[0];
    if (firstIntent === undefined) {
      throw conflict(`Discovery Round ${roundNumber} has no request intent.`);
    }
    return Object.freeze({
      roundNumber,
      requestPlan: requestPlan(firstIntent, authorizedCostMicros),
      canonicalRequestFingerprints: Object.freeze(
        intents.map((intent) => intent.canonicalRequestFingerprint),
      ),
      canonicalPathFingerprints: Object.freeze(
        intents.map((intent) => intent.canonicalPathFingerprint),
      ),
      completedWindowCount: windows.length,
      completedRequestCount: intents.length,
      rawCandidateCount,
      effectiveCandidateCount,
      newUniqueCount,
      duplicateCount,
      authorizedCostMicros,
      settledCostMicros: unknownCharge
        ? null
        : sum(outcomes.map((outcome) => outcome.actualCostMicros ?? 0)),
      chargeState: unknownCharge
        ? ("UNKNOWN_CHARGE" as const)
        : ("SETTLED" as const),
      completedAt: maxDate(windows.map((window) => window.completedAt)),
    });
  });
  const activeRound = Math.max(...roundNumbers) as 1 | 2;

  return Object.freeze({
    policyVersion: persisted.lineage.discoveryBudgetPolicyVersion,
    activeRound,
    rounds: Object.freeze(rounds),
    completedWindows: Object.freeze(
      persisted.windowFacts.map((window) =>
        Object.freeze({
          completed: true,
          rawCandidateCount: window.rawCandidateCount,
          canonicalCandidateCount: window.effectiveCandidateCount,
          newUniqueCount: window.newUniqueCount,
        }),
      ),
    ),
    canonicalRequestSetFingerprint: fingerprint(
      persisted.requestIntents.map(
        (intent) => intent.canonicalRequestFingerprint,
      ),
    ),
  });
}

function roundFactInput(
  lineage: RecommendationDiscoveryGenerationLineage,
  state: RecommendationPoolV2DiscoveryCompletionState,
  decision: RecommendationPoolV2DiscoveryCompletionDecision,
  semanticId: string,
): RecommendationDiscoveryRoundFactInput {
  const active = activeCompletionRound(state);
  const prior = state.rounds.find((round) => round.roundNumber === 1);
  let changed: readonly ChangedDimension[] = [];
  if (active.roundNumber === 2) {
    if (prior === undefined) {
      throw conflict("Persisted Round 2 is missing its completed Round 1.");
    }
    changed = changedDimensions(prior.requestPlan, active.requestPlan);
  }
  if (active.roundNumber === 2 && changed.length === 0) {
    throw conflict("Persisted Round 2 does not change its discovery path.");
  }
  const cumulativeSettledCostMicros = state.rounds.some(
    (round) => round.chargeState === "UNKNOWN_CHARGE",
  )
    ? null
    : sum(state.rounds.map((round) => round.settledCostMicros ?? 0));
  const terminalReason = decision.kind === "STOP" ? decision.reason : null;

  return Object.freeze({
    ...lineage,
    id: semanticId,
    roundNumber: active.roundNumber,
    completedWindowCount: active.completedWindowCount,
    completedRequestCount: active.completedRequestCount,
    rawCandidateCount: active.rawCandidateCount,
    effectiveCandidateCount: active.effectiveCandidateCount,
    newUniqueCount: active.newUniqueCount,
    duplicateCount: active.duplicateCount,
    newUniqueRateNumerator: active.newUniqueCount,
    newUniqueRateDenominator: active.effectiveCandidateCount,
    roundAuthorizedCostMicros: active.authorizedCostMicros,
    roundSettledCostMicros: active.settledCostMicros,
    cumulativeSettledCostMicros,
    chargeState: active.chargeState,
    pathsExhausted: terminalReason === "PATHS_EXHAUSTED",
    changedDimensions: changed,
    canonicalRequestSetFingerprint: fingerprint(
      active.canonicalRequestFingerprints,
    ),
    policyDecision:
      decision.kind === "START_ROUND_2" ? "START_ROUND_2" : "STOP",
    terminalReason,
    completedAt: active.completedAt,
    createdBy: finalizerCreatedBy,
  });
}

function terminalFactInput(
  lineage: RecommendationDiscoveryGenerationLineage,
  state: RecommendationPoolV2DiscoveryCompletionState,
  decision: Extract<
    RecommendationPoolV2DiscoveryCompletionDecision,
    { kind: "STOP" }
  >,
  semanticId: string,
): RecommendationDiscoveryTerminalFactInput {
  const unknownCharge = state.rounds.some(
    (round) => round.chargeState === "UNKNOWN_CHARGE",
  );
  return Object.freeze({
    ...lineage,
    id: semanticId,
    effectiveUniqueCandidateCount: sum(
      state.rounds.map((round) => round.newUniqueCount),
    ),
    terminalReason: decision.reason,
    totalSettledCostMicros: unknownCharge
      ? null
      : sum(state.rounds.map((round) => round.settledCostMicros ?? 0)),
    chargeState: unknownCharge ? "UNKNOWN_CHARGE" : "SETTLED",
    completedRoundCount: state.activeRound,
    completedWindowCount: state.completedWindows.length,
    canonicalRequestSetFingerprint: state.canonicalRequestSetFingerprint,
    completedAt: maxDate(state.rounds.map((round) => round.completedAt)),
    createdBy: finalizerCreatedBy,
  });
}

export function createRecommendationPoolV2DiscoveryFinalizer(
  repository: RecommendationPoolV2DiscoveryLedgerRepository,
): Readonly<{
  finalize(
    input: Readonly<{
      lineage: RecommendationDiscoveryGenerationLineage;
      proposedRound2Path: RecommendationPoolV2ProposedRound2Path | null;
    }>,
  ): Promise<RecommendationPoolV2DiscoveryFinalizationResult>;
}> {
  return Object.freeze({
    async finalize(input) {
      const finalized = await repository.finalizeGeneration(
        input.lineage,
        (persisted) => {
          const state = deriveCompletionState(persisted);
          const decision = decideRecommendationPoolV2DiscoveryCompletion({
            state,
            proposedRound2Path: input.proposedRound2Path,
            contextSuperseded: false,
          });
          const identity = {
            lineage: input.lineage,
            stateFingerprint: state.canonicalRequestSetFingerprint,
            activeRound: state.activeRound,
            proposedRound2Path: input.proposedRound2Path,
            decision,
          };
          const roundFact = roundFactInput(
            input.lineage,
            state,
            decision,
            semanticUuid("recommendation-discovery-round", identity),
          );
          const terminalFact =
            decision.kind === "STOP"
              ? terminalFactInput(
                  input.lineage,
                  state,
                  decision,
                  semanticUuid("recommendation-discovery-terminal", identity),
                )
              : null;
          return Object.freeze({
            result: decision,
            roundFact,
            terminalFact,
          });
        },
      );

      if (finalized.result.kind === "START_ROUND_2") {
        return Object.freeze({
          ...finalized.result,
          roundFact: finalized.roundFact,
          terminalFact: null,
        });
      }
      if (finalized.terminalFact === null) {
        throw conflict("Terminal discovery decision was not persisted.");
      }
      return Object.freeze({
        kind: "TERMINAL",
        policyVersion: finalized.result.policyVersion,
        reason: finalized.result.reason,
        roundFact: finalized.roundFact,
        terminalFact: finalized.terminalFact,
      });
    },
  });
}
