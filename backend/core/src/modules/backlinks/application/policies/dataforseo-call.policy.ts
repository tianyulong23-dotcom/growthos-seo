import type {
  ProviderRequestContext,
} from "../../ports/dataforseo.port.js";
import { backlinksRuntimeContract } from "../../workflows/namespaces.js";

const providerContract = backlinksRuntimeContract.providers.dataForSeo;
const provider = providerContract.providerId;
export type DataForSeoGateDecision = "allow" | "deny";
export type DataForSeoAvailabilityDecision =
  | Readonly<{ decision: "allow" }>
  | Readonly<{
    decision: "deny";
    reasonCode: string;
    recoveryAction: string;
  }>;
export const dataForSeoGateErrorCodes = {
  providerUnavailable: "PROVIDER_UNAVAILABLE",
  killSwitchActive: "KILL_SWITCH_ACTIVE",
  quotaExceeded: "QUOTA_EXCEEDED",
  budgetExceeded: "BUDGET_EXCEEDED",
  gateUnavailable: "GATE_UNAVAILABLE",
} as const;
export type DataForSeoGateErrorCode =
  (typeof dataForSeoGateErrorCodes)[keyof typeof dataForSeoGateErrorCodes];
export type DataForSeoGateStage =
  | "availability"
  | "kill_switch"
  | "quota"
  | "budget";
export type DataForSeoCallGateInput = Readonly<{
  context: ProviderRequestContext;
  requestFingerprint: string;
  estimatedCostMicros: number;
  requiredRemainingPaidCalls?: number;
  requiredRemainingCostMicros?: number;
}>;
type CostGateInput = Readonly<{
  context: ProviderRequestContext;
  provider: typeof provider;
  estimatedCostMicros: number;
  requiredRemainingPaidCalls: number;
  requiredRemainingCostMicros: number;
}>;
type BudgetGateInput = CostGateInput & Readonly<{
  requestFingerprint: string;
  reservationKey: string;
}>;
type KillSwitchGateInput = Readonly<{
  context: ProviderRequestContext;
  moduleId: typeof backlinksRuntimeContract.moduleId;
  providerId: typeof providerContract.providerId;
  killSwitchKey: typeof providerContract.killSwitch;
}>;
export type DataForSeoCallPolicyDependencies = Readonly<{
  checkAvailability?(): Promise<DataForSeoAvailabilityDecision>;
  checkKillSwitch(
    input: KillSwitchGateInput,
  ): Promise<DataForSeoGateDecision>;
  checkQuota(input: CostGateInput): Promise<DataForSeoGateDecision>;
  reserveBudget(input: BudgetGateInput): Promise<DataForSeoGateDecision>;
}>;
export interface DataForSeoCallGate {
  preflight(input: DataForSeoCallGateInput): Promise<void>;
  authorize(input: DataForSeoCallGateInput): Promise<void>;
}
const messages: Record<DataForSeoGateErrorCode, string> = {
  PROVIDER_UNAVAILABLE: "Data provider is unavailable",
  KILL_SWITCH_ACTIVE: "Data provider Kill Switch is active",
  QUOTA_EXCEEDED: "Data provider quota is exceeded",
  BUDGET_EXCEEDED: "Data provider budget is exceeded",
  GATE_UNAVAILABLE: "Data provider gate is unavailable",
};
export class DataForSeoCallBlockedError extends Error {
  readonly code: DataForSeoGateErrorCode;
  readonly stage: DataForSeoGateStage;
  readonly reasonCode: string | null;
  readonly recoveryAction: string | null;

  constructor(
    code: DataForSeoGateErrorCode,
    stage: DataForSeoGateStage,
    cause?: unknown,
    details?: Readonly<{
      reasonCode: string;
      recoveryAction: string;
    }>,
  ) {
    const detailMessage = details === undefined
      ? ""
      : `: ${details.reasonCode}; recovery=${details.recoveryAction}`;
    super(`${messages[code]}${detailMessage}`, { cause });
    this.name = "DataForSeoCallBlockedError";
    this.code = code;
    this.stage = stage;
    this.reasonCode = details?.reasonCode ?? null;
    this.recoveryAction = details?.recoveryAction ?? null;
  }
}
async function requireProviderAvailable(
  check: (() => Promise<DataForSeoAvailabilityDecision>) | undefined,
): Promise<void> {
  if (check === undefined) return;
  let decision: DataForSeoAvailabilityDecision;
  try {
    decision = await check();
  } catch (cause) {
    throw new DataForSeoCallBlockedError(
      dataForSeoGateErrorCodes.gateUnavailable,
      "availability",
      cause,
    );
  }
  if (decision.decision === "deny") {
    throw new DataForSeoCallBlockedError(
      dataForSeoGateErrorCodes.providerUnavailable,
      "availability",
      undefined,
      decision,
    );
  }
}
async function requireAllowed(
  stage: DataForSeoGateStage,
  deniedCode: DataForSeoGateErrorCode,
  check: () => Promise<DataForSeoGateDecision>,
): Promise<void> {
  let decision: DataForSeoGateDecision;
  try {
    decision = await check();
  } catch (cause) {
    throw new DataForSeoCallBlockedError(
      dataForSeoGateErrorCodes.gateUnavailable,
      stage,
      cause,
    );
  }
  if (decision !== "allow") {
    throw new DataForSeoCallBlockedError(deniedCode, stage);
  }
}
export class DataForSeoCallPolicy implements DataForSeoCallGate {
  constructor(private readonly dependencies: DataForSeoCallPolicyDependencies) {}

  async preflight(input: DataForSeoCallGateInput): Promise<void> {
    const requiredRemainingPaidCalls = input.requiredRemainingPaidCalls ?? 0;
    const requiredRemainingCostMicros = input.requiredRemainingCostMicros ?? 0;
    if (
      !Number.isSafeInteger(requiredRemainingPaidCalls)
      || requiredRemainingPaidCalls < 0
      || !Number.isSafeInteger(requiredRemainingCostMicros)
      || requiredRemainingCostMicros < 0
    ) {
      throw new TypeError("Data provider remaining operation capacity is invalid");
    }
    await requireProviderAvailable(this.dependencies.checkAvailability);
    const costInput: CostGateInput = {
      context: input.context,
      provider,
      estimatedCostMicros: input.estimatedCostMicros,
      requiredRemainingPaidCalls,
      requiredRemainingCostMicros,
    };
    await requireAllowed("kill_switch",
      dataForSeoGateErrorCodes.killSwitchActive,
      () => this.dependencies.checkKillSwitch({
        context: input.context,
        moduleId: backlinksRuntimeContract.moduleId,
        providerId: providerContract.providerId,
        killSwitchKey: providerContract.killSwitch,
      }));
    await requireAllowed("quota", dataForSeoGateErrorCodes.quotaExceeded,
      () => this.dependencies.checkQuota(costInput));
  }

  async authorize(input: DataForSeoCallGateInput): Promise<void> {
    await this.preflight(input);
    const costInput: CostGateInput = {
      context: input.context,
      provider,
      estimatedCostMicros: input.estimatedCostMicros,
      requiredRemainingPaidCalls: input.requiredRemainingPaidCalls ?? 0,
      requiredRemainingCostMicros: input.requiredRemainingCostMicros ?? 0,
    };
    await requireAllowed("budget", dataForSeoGateErrorCodes.budgetExceeded,
      () => this.dependencies.reserveBudget({
        ...costInput,
        requestFingerprint: input.requestFingerprint,
        reservationKey: input.context.budgetReservationId,
      }));
  }
}
