import { z } from "zod";

import {
  googleOauthClientSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";

export const localProductGoogleRedirectUri =
  "http://localhost:7200/api/v1/backlinks/gmail-connections/callback";
const websiteProjectKeySchema = z.string().trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const boundedSendCallsSchema = z.coerce.number().int().min(1).max(1_000);

export function buildLocalProductGoogleRedirectUri(
  websiteProjectKey: string,
): string {
  websiteProjectKeySchema.parse(websiteProjectKey);
  return localProductGoogleRedirectUri;
}

const googleWebCredentialSchema = z.object({
  web: z.object({
    client_id: z.string().trim().min(1)
      .refine(
        (value) => value.endsWith(".apps.googleusercontent.com"),
        "GOOGLE_OAUTH_CLIENT_ID_INVALID",
      ),
    project_id: z.string().trim().min(1),
    client_secret: z.string().min(1),
    redirect_uris: z.array(z.string().url()).min(1),
  }),
});

const liveAuthManifestSchema = z.object({
  schemaVersion: z.literal("growthos.live-auth.v1"),
  runtime: z.object({
    mode: z.string(),
    publicBaseUrl: z.literal("http://localhost:7200"),
    websiteProjectKey: websiteProjectKeySchema,
  }).passthrough(),
  google: z.object({
    cloudProjectId: z.string().nullable(),
    oauthClientId: z.string().nullable(),
    oauthClientSecretRef: z.string().nullable(),
    redirectUri: z.string(),
    testUserMaskedId: z.string().nullable(),
    secretStoreProvider: z.literal("platform-secret-store"),
  }).passthrough(),
  gmail: z.object({
    syncMode: z.string(),
    maxSendCalls: z.number(),
  }).passthrough(),
}).passthrough();

export type GoogleWebOAuthCredentials = Readonly<{
  clientId: string;
  clientSecret: string;
  projectId: string;
}>;

export function parseGoogleWebOAuthCredentials(
  value: unknown,
  redirectUri: string,
): GoogleWebOAuthCredentials {
  const parsed = googleWebCredentialSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("GOOGLE_OAUTH_WEB_CREDENTIAL_FILE_INVALID");
  }
  if (!parsed.data.web.redirect_uris.includes(redirectUri)) {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI_NOT_REGISTERED");
  }
  return {
    clientId: parsed.data.web.client_id,
    clientSecret: parsed.data.web.client_secret,
    projectId: parsed.data.web.project_id,
  };
}

export function updateLocalProductOauthManifest(
  value: unknown,
  input: Readonly<{
    clientId: string;
    projectId: string;
    websiteProjectKey: string;
    maxSendCalls: number;
  }>,
): Record<string, unknown> {
  const manifest = liveAuthManifestSchema.parse(value);
  const websiteProjectKey = websiteProjectKeySchema.parse(
    input.websiteProjectKey,
  );
  if (manifest.runtime.websiteProjectKey !== websiteProjectKey) {
    throw new Error("LOCAL_PRODUCT_PROJECT_CONTEXT_MISMATCH");
  }
  const maxSendCalls = boundedSendCallsSchema.parse(input.maxSendCalls);
  const redirectUri = buildLocalProductGoogleRedirectUri(websiteProjectKey);
  return {
    ...manifest,
    runtime: {
      ...manifest.runtime,
      mode: "LOCAL_PRODUCT",
      websiteProjectKey,
    },
    google: {
      ...manifest.google,
      cloudProjectId: input.projectId,
      oauthClientId: input.clientId,
      oauthClientSecretRef: googleOauthClientSecretReference,
      redirectUri,
      secretStoreProvider: "platform-secret-store",
    },
    gmail: {
      ...manifest.gmail,
      syncMode: "polling",
      maxSendCalls,
    },
  };
}

export function maskGoogleIdentifier(value: string): string {
  if (value.length <= 12) {
    return `${value.slice(0, 2)}...${value.slice(-2)}`;
  }
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}
