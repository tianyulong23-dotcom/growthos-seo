import { z } from "zod";

const providerMessageIdSchema = z.string()
  .regex(/^[1-9][0-9]{0,63}$/u);
const providerHistoryIdSchema = z.string()
  .regex(/^[1-9][0-9]*$/u);
const base64Schema = z.string().min(1).max(16_384)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u);
const subscriptionSchema = z.string().trim().min(1).max(1_024)
  .regex(
    /^projects\/[^/\s]+\/subscriptions\/[^/\s]+$/u,
    "A full Google Pub/Sub subscription resource name is required.",
  );

export const gmailPushEnvelopeSchema = z.object({
  message: z.object({
    data: base64Schema,
    messageId: providerMessageIdSchema,
    publishTime: z.string().datetime({ offset: true }).optional(),
  }).strict(),
  subscription: subscriptionSchema,
}).strict();

const gmailPushNotificationSchema = z.object({
  emailAddress: z.string().trim().email().max(320)
    .transform((value) => value.toLowerCase()),
  historyId: providerHistoryIdSchema,
}).strict();

export type GmailPushNotification = Readonly<{
  providerMessageId: string;
  subscription: string;
  emailAddress: string;
  historyId: string;
}>;

const decodeCanonicalBase64 = (encoded: string): Uint8Array => {
  const bytes = Buffer.from(encoded, "base64");
  const unpaddedInput = encoded.replace(/=+$/u, "");
  const unpaddedRoundTrip = bytes.toString("base64").replace(/=+$/u, "");
  if (unpaddedInput !== unpaddedRoundTrip) {
    throw new Error("GMAIL_PUSH_DATA_INVALID_BASE64");
  }
  return bytes;
};

export function decodeGmailPushNotification(
  input: unknown,
): GmailPushNotification {
  const envelope = gmailPushEnvelopeSchema.parse(input);
  const decoded = decodeCanonicalBase64(envelope.message.data);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(decoded).toString("utf8"));
  } catch (error) {
    throw new Error("GMAIL_PUSH_DATA_INVALID_JSON", { cause: error });
  }
  const notification = gmailPushNotificationSchema.parse(value);
  return Object.freeze({
    providerMessageId: envelope.message.messageId,
    subscription: envelope.subscription,
    emailAddress: notification.emailAddress,
    historyId: notification.historyId,
  });
}
