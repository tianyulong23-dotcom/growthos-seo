import type { EmailSuppressionTarget } from "../../domain/sending/suppression.js";
import {
  assertSuppressionReleaseAllowed,
  type DeliveryFeedbackKind,
  type SuppressionReleaseActorRole,
} from "../../domain/sending/delivery-feedback.js";
import type {
  SuppressionReason,
  SuppressionTenantContext,
} from "../services/send-suppression.repository.js";

export type RecordDeliveryFeedbackInput = SuppressionTenantContext & Readonly<{
  target: EmailSuppressionTarget;
  feedbackId: string;
  kind: DeliveryFeedbackKind;
  observedAt: Date;
  recordedAt: Date;
  actorId: string;
}>;

export type RecordedDeliveryFeedback = Readonly<{
  feedbackId: string;
  action: "RECORD_ONLY" | "SUPPRESS";
  suppressionReason: SuppressionReason | null;
}>;

export type ReleaseEmailSuppressionInput = SuppressionTenantContext & Readonly<{
  suppressionId: string;
  suppressionReason: SuppressionReason;
  actorRole: SuppressionReleaseActorRole;
  releaseReason: string;
  releasedAt: Date;
  actorId: string;
}>;

export type ReleasedEmailSuppression = Readonly<{
  suppressionId: string;
  reason: SuppressionReason;
  status: "RELEASED";
  version: number;
}>;

export interface DeliveryFeedbackRepository {
  record(
    input: RecordDeliveryFeedbackInput,
  ): Promise<RecordedDeliveryFeedback>;
  release(
    input: ReleaseEmailSuppressionInput,
  ): Promise<ReleasedEmailSuppression>;
}

export const recordDeliveryFeedback = (
  repository: DeliveryFeedbackRepository,
  input: RecordDeliveryFeedbackInput,
): Promise<RecordedDeliveryFeedback> => repository.record(input);

export const releaseEmailSuppression = async (
  repository: DeliveryFeedbackRepository,
  input: ReleaseEmailSuppressionInput,
): Promise<ReleasedEmailSuppression> => {
  assertSuppressionReleaseAllowed({
    reason: input.suppressionReason,
    actorRole: input.actorRole,
  });
  return repository.release(input);
};
