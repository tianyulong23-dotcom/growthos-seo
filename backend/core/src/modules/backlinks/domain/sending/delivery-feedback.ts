export const deliveryFeedbackKinds = Object.freeze({
  hardBounce: "HARD_BOUNCE",
  softBounce: "SOFT_BOUNCE",
  complaint: "COMPLAINT",
  unsubscribe: "UNSUBSCRIBE",
} as const);

export type DeliveryFeedbackKind =
  (typeof deliveryFeedbackKinds)[keyof typeof deliveryFeedbackKinds];

export const softBounceSuppressionPolicy = Object.freeze({
  threshold: 3,
  windowDays: 30,
} as const);

export type DeliveryFeedbackPolicyDecision =
  | Readonly<{
    action: "RECORD_ONLY";
    softBounceThreshold: number;
    softBounceWindowDays: number;
  }>
  | Readonly<{
    action: "SUPPRESS";
    reason: "HARD_BOUNCE" | "COMPLAINT" | "UNSUBSCRIBE"
      | "SOFT_BOUNCE_THRESHOLD";
    softBounceThreshold?: number;
    softBounceWindowDays?: number;
  }>;

const feedbackKinds = new Set<string>(Object.values(deliveryFeedbackKinds));

export const evaluateDeliveryFeedbackPolicy = (input: Readonly<{
  kind: DeliveryFeedbackKind;
  softBounceCount: number;
}>): DeliveryFeedbackPolicyDecision => {
  if (
    !feedbackKinds.has(input.kind)
    || !Number.isSafeInteger(input.softBounceCount)
    || input.softBounceCount < 0
  ) {
    throw new TypeError("Delivery feedback policy input is invalid.");
  }

  if (input.kind === deliveryFeedbackKinds.softBounce) {
    if (input.softBounceCount < softBounceSuppressionPolicy.threshold) {
      return Object.freeze({
        action: "RECORD_ONLY" as const,
        softBounceThreshold: softBounceSuppressionPolicy.threshold,
        softBounceWindowDays: softBounceSuppressionPolicy.windowDays,
      });
    }
    return Object.freeze({
      action: "SUPPRESS" as const,
      reason: "SOFT_BOUNCE_THRESHOLD" as const,
      softBounceThreshold: softBounceSuppressionPolicy.threshold,
      softBounceWindowDays: softBounceSuppressionPolicy.windowDays,
    });
  }

  return Object.freeze({
    action: "SUPPRESS" as const,
    reason: input.kind,
  });
};

export const suppressionReleaseActorRoles = Object.freeze({
  ordinaryUser: "ORDINARY_USER",
  complianceAdministrator: "COMPLIANCE_ADMINISTRATOR",
} as const);

export type SuppressionReleaseActorRole =
  (typeof suppressionReleaseActorRoles)[keyof typeof suppressionReleaseActorRoles];

export const suppressionReleaseErrorCodes = Object.freeze({
  unsubscribeReleaseForbidden: "SUPPRESSION_UNSUBSCRIBE_RELEASE_FORBIDDEN",
} as const);

export class SuppressionReleaseError extends Error {
  readonly code:
    (typeof suppressionReleaseErrorCodes)[keyof typeof suppressionReleaseErrorCodes];

  constructor(
    code:
      (typeof suppressionReleaseErrorCodes)[keyof typeof suppressionReleaseErrorCodes],
  ) {
    super("This suppression release is not authorized.");
    this.name = "SuppressionReleaseError";
    this.code = code;
  }
}

export const assertSuppressionReleaseAllowed = (input: Readonly<{
  reason: string;
  actorRole: SuppressionReleaseActorRole;
}>): void => {
  if (!Object.values(suppressionReleaseActorRoles).includes(input.actorRole)) {
    throw new TypeError("Suppression release actor role is invalid.");
  }

  if (
    input.reason === "UNSUBSCRIBE"
    && input.actorRole !== suppressionReleaseActorRoles.complianceAdministrator
  ) {
    throw new SuppressionReleaseError(
      suppressionReleaseErrorCodes.unsubscribeReleaseForbidden,
    );
  }
};
