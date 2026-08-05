export const killSwitchLayers = [
  "global",
  "organization",
  "workspace",
  "project",
  "provider",
] as const;

export type KillSwitchLayer = (typeof killSwitchLayers)[number];

export type KillSwitchDecision = Readonly<{
  layer: KillSwitchLayer;
  scopeId: string;
  capability: string;
  provider: string | null;
  blocked: boolean;
  version: number;
}>;

export type KillSwitchEvaluation = Readonly<{
  capability: string;
  provider: string | null;
  effectiveBlocked: boolean;
  sourceLayer: KillSwitchLayer | "default" | "authority_unavailable";
  sourceScopeId: string | null;
  sourceVersion: number | null;
}>;

const layerRank = new Map(
  killSwitchLayers.map((layer, index) => [layer, index]),
);

export function evaluateKillSwitch(input: Readonly<{
  capability: string;
  provider: string | null;
  authorityAvailable: boolean;
  decisions: readonly KillSwitchDecision[];
}>): KillSwitchEvaluation {
  if (!input.authorityAvailable) {
    return {
      capability: input.capability,
      provider: input.provider,
      effectiveBlocked: true,
      sourceLayer: "authority_unavailable",
      sourceScopeId: null,
      sourceVersion: null,
    };
  }
  const matching = input.decisions.filter((decision) =>
    decision.capability === input.capability
    && (
      decision.provider === null
      || decision.provider === input.provider
    )
  );
  const blocked = matching
    .filter((decision) => decision.blocked)
    .sort((left, right) =>
      (layerRank.get(left.layer) ?? 0) - (layerRank.get(right.layer) ?? 0)
      || right.version - left.version
    )[0];
  if (blocked !== undefined) {
    return {
      capability: input.capability,
      provider: input.provider,
      effectiveBlocked: true,
      sourceLayer: blocked.layer,
      sourceScopeId: blocked.scopeId,
      sourceVersion: blocked.version,
    };
  }
  const enabled = matching
    .filter((decision) => !decision.blocked)
    .sort((left, right) =>
      (layerRank.get(right.layer) ?? 0) - (layerRank.get(left.layer) ?? 0)
      || right.version - left.version
    )[0];
  if (enabled !== undefined) {
    return {
      capability: input.capability,
      provider: input.provider,
      effectiveBlocked: false,
      sourceLayer: enabled.layer,
      sourceScopeId: enabled.scopeId,
      sourceVersion: enabled.version,
    };
  }
  return {
    capability: input.capability,
    provider: input.provider,
    effectiveBlocked: true,
    sourceLayer: "default",
    sourceScopeId: null,
    sourceVersion: null,
  };
}
