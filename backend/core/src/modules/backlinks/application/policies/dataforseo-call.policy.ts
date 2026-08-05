import type {
  ProviderRequestContext,
} from "../../ports/dataforseo.port.js";
import { backlinksRuntimeContract } from "../../workflows/namespaces.js";

const providerContract = backlinksRuntimeContract.providers.dataForSeo;
const provider = providerContract.providerId;
export type DataForSeoGateDecision = "allow" | "deny";
export const dataForSeoGateErrorCodes = {
  killSwitchActive: "KILL_SWITCH_ACTIVE",
  quotaExceeded: "QUOTA_EXCEEDED",
  budgetExceeded: "BUDGET_EXCEEDED",
  gateUnavailable: "GATE_UNAVAILABLE",
} as const;
export type DataForSeoGateErrorCode =
  (typeof dataForSeoGateErrorCodes)[keyof typeof dataForSeoGateErrorCodes];
export type DataForSeoGateStage = "kill_switch" | "quota" | "budget";
export type DataForSeoCallGateInput = Readonly<{
  context: ProviderRequestContext;
  requestFingerprint: string;
  estimatedCostMicros: number;
}>;
type CostGateInput = Readonly<{
  context: ProviderRequestContext;
  provider: typeof provider;
  estimatedCostMicros: number;
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
  checkKillSwitch(
    input: KillSwitchGateInput,
  ): Promise<DataForSeoGateDecision>;
  checkQuota(input: CostGateInput): Promise<DataForSeoGateDecision>;
  reserveBudget(input: BudgetGateInput): Promise<DataForSeoGateDecision>;
}>;
export interface DataForSeoCallGate {
  authorize(input: DataForSeoCallGateInput): Promise<void>;
}
const messages: Record<DataForSeoGateErrorCode, string> = {
  KILL_SWITCH_ACTIVE: "Data provider Kill Switch is active",
  QUOTA_EXCEEDED: "Data provider quota is exceeded",
  BUDGET_EXCEEDED: "Data provider budget is exceeded",
  GATE_UNAVAILABLE: "Data provider gate is unavailable",
};
export class DataForSeoCallBlockedError extends Error {
  readonly code: DataForSeoGateErrorCode;
  readonly stage: DataForSeoGateStage;

  constructor(
    code: DataForSeoGateErrorCode,
    stage: DataForSeoGateStage,
    cause?: unknown,
  ) {
    super(messages[code], { cause });
    this.name = "DataForSeoCallBlockedError";
    this.code = code;
    this.stage = stage;
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

  async authorize(input: DataForSeoCallGateInput): Promise<void> {
    const costInput: CostGateInput = {
      context: input.context,
      provider,
      estimatedCostMicros: input.estimatedCostMicros,
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
    await requireAllowed("budget", dataForSeoGateErrorCodes.budgetExceeded,
      () => this.dependencies.reserveBudget({
        ...costInput,
        requestFingerprint: input.requestFingerprint,
        reservationKey: input.context.budgetReservationId,
      }));
  }
}
