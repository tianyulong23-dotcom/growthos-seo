import { resolve } from "node:path";

import { z } from "zod";

import {
  localProductGmailCanaryRecipientReference,
  parseLocalProductSecretReference,
} from "../adapters/security/local-product-secret-store-client.js";
import { secretKinds } from "../ports/secret-store.port.js";
import {
  localProductDataForSeoEndpointAllowlistSchema,
} from "./local-product-dataforseo-bootstrap.js";
import { localProductGoogleRedirectUri } from "./local-product-oauth-bootstrap.js";

const booleanStringSchema = z.enum(["true", "false"]);
const localProductStageSchema = z.enum(["LIVE-003", "LIVE-004"]);
const requiredTextSchema = z.string().trim().min(1);

export type BacklinksLiveCapabilities = Readonly<{
  mode: "DISABLED" | "LOCAL_PRODUCT_ACCEPTANCE" | "LOCAL_PRODUCT";
  stage: "LIVE-003" | "LIVE-004" | null;
  googleOauthEnabled: boolean;
  gmailSendEnabled: boolean;
  gmailSyncEnabled: boolean;
  gmailRolling24HourSendLimit: number;
  gmailMinimumIntervalSeconds: number;
  gmailPollingIntervalSeconds: number;
  dataForSeoEnabled: boolean;
  aiProviderEnabled: boolean;
  browserProviderEnabled: boolean;
  browserWorkerEndpoint: string | null;
  browserWorkerTimeoutMs: number;
  contactEnrichmentFetchTimeoutMs: number;
  contactEnrichmentMaxPages: number;
  contactEnrichmentMaxDepth: number;
  contactEnrichmentMaxAttempts: number;
  secretStoreEnabled: boolean;
  googleOauthClientId: string | null;
  googleOauthClientSecretReference: string | null;
  gmailRecipientSecretReference: string | null;
  googleOauthRedirectUri: string | null;
  secretStoreRoot: string | null;
}>;

const providerFlagNames = [
  "GMAIL_SEND_ENABLED",
  "GMAIL_SYNC_ENABLED",
  "DATAFORSEO_ENABLED",
  "AI_PROVIDER_ENABLED",
  "BROWSER_PROVIDER_ENABLED",
] as const;

const defaultContactEnrichmentConfiguration = Object.freeze({
  browserWorkerEndpoint: null,
  browserWorkerTimeoutMs: 20_000,
  contactEnrichmentFetchTimeoutMs: 12_000,
  contactEnrichmentMaxPages: 8,
  contactEnrichmentMaxDepth: 2,
  contactEnrichmentMaxAttempts: 3,
});
const defaultGmailSendConfiguration = Object.freeze({
  gmailRolling24HourSendLimit: 5,
  gmailMinimumIntervalSeconds: 300,
  gmailPollingIntervalSeconds: 60,
});

const requiredDisabledFlag = (
  environment: NodeJS.ProcessEnv,
  name: (typeof providerFlagNames)[number],
): boolean => {
  const value = booleanStringSchema.safeParse(environment[name]);
  if (!value.success || value.data !== "false") {
    throw new Error(`BACKLINKS_PROVIDER_MUST_REMAIN_DISABLED:${name}`);
  }
  return false;
};

const readBooleanFlag = (
  environment: NodeJS.ProcessEnv,
  name: string,
): boolean => {
  const parsed = booleanStringSchema.safeParse(environment[name]);
  if (!parsed.success) {
    throw new Error(`BACKLINKS_LIVE_CAPABILITY_INVALID:${name}`);
  }
  return parsed.data === "true";
};

const requireEnvironmentText = (
  environment: NodeJS.ProcessEnv,
  name: string,
): string => {
  const parsed = requiredTextSchema.safeParse(environment[name]);
  if (!parsed.success) {
    throw new Error(`BACKLINKS_LIVE_CONFIGURATION_MISSING:${name}`);
  }
  return parsed.data;
};

const readProviderFlags = (environment: NodeJS.ProcessEnv) => ({
  gmailSendEnabled: readBooleanFlag(environment, "GMAIL_SEND_ENABLED"),
  gmailSyncEnabled: readBooleanFlag(environment, "GMAIL_SYNC_ENABLED"),
  dataForSeoEnabled: readBooleanFlag(environment, "DATAFORSEO_ENABLED"),
  aiProviderEnabled: readBooleanFlag(environment, "AI_PROVIDER_ENABLED"),
  browserProviderEnabled: readBooleanFlag(
    environment,
    "BROWSER_PROVIDER_ENABLED",
  ),
});

const readSecretStoreConfiguration = (
  environment: NodeJS.ProcessEnv,
): Readonly<{ secretStoreRoot: string }> => {
  if (
    requireEnvironmentText(environment, "PLATFORM_SECRET_STORE_PROVIDER")
    !== "platform-secret-store"
  ) {
    throw new Error("BACKLINKS_SECRET_STORE_PROVIDER_INVALID");
  }
  const localAppData = resolve(requireEnvironmentText(
    environment,
    "LOCALAPPDATA",
  ));
  const secretStoreRoot = resolve(requireEnvironmentText(
    environment,
    "PLATFORM_SECRET_STORE_ROOT",
  ));
  const allowedRoot = resolve(localAppData, "GrowthOS");
  const relativeRoot = secretStoreRoot.slice(allowedRoot.length);
  if (
    secretStoreRoot !== allowedRoot
    && (
      !secretStoreRoot.startsWith(`${allowedRoot}\\`)
      || relativeRoot.includes("..")
    )
  ) {
    throw new Error("BACKLINKS_SECRET_STORE_ROOT_INVALID");
  }
  return { secretStoreRoot };
};

const readGoogleOauthConfiguration = (
  environment: NodeJS.ProcessEnv,
  expectedRedirectUri: string | null,
) => {
  const googleOauthClientId = requireEnvironmentText(
    environment,
    "GOOGLE_OAUTH_CLIENT_ID",
  );
  if (!googleOauthClientId.endsWith(".apps.googleusercontent.com")) {
    throw new Error("BACKLINKS_GOOGLE_OAUTH_CLIENT_ID_INVALID");
  }
  const clientSecretReference = requireEnvironmentText(
    environment,
    "GOOGLE_OAUTH_CLIENT_SECRET_REF",
  );
  try {
    parseLocalProductSecretReference(
      clientSecretReference,
      secretKinds.googleOauthClientSecret,
    );
  } catch {
    throw new Error("BACKLINKS_GOOGLE_OAUTH_CLIENT_SECRET_REF_INVALID");
  }
  const redirectUri = requireEnvironmentText(
    environment,
    "GOOGLE_OAUTH_REDIRECT_URI",
  );
  if (
    expectedRedirectUri === null
      ? !isLocalProductGoogleRedirectUri(redirectUri)
      : redirectUri !== expectedRedirectUri
  ) {
    throw new Error("BACKLINKS_GOOGLE_OAUTH_REDIRECT_URI_INVALID");
  }
  return {
    googleOauthClientId,
    clientSecretReference,
    redirectUri,
  };
};

const isLocalProductGoogleRedirectUri = (value: string): boolean => {
  let redirectUri: URL;
  try {
    redirectUri = new URL(value);
  } catch {
    return false;
  }
  return (
    redirectUri.protocol === "http:"
    && redirectUri.hostname === "localhost"
    && redirectUri.port === "7200"
    && redirectUri.username.length === 0
    && redirectUri.password.length === 0
    && redirectUri.search.length === 0
    && redirectUri.hash.length === 0
    && /^\/api\/v1\/projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/backlinks\/gmail-connections\/callback$/u
      .test(redirectUri.pathname)
  );
};

const readDataForSeoInteger = (
  environment: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
  errorCode?: string,
): number => {
  const value = requireEnvironmentText(environment, name);
  const parsed = /^[1-9][0-9]*$/u.test(value) ? Number(value) : Number.NaN;
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    throw new Error(
      errorCode ?? `BACKLINKS_DATAFORSEO_CONFIGURATION_INVALID:${name}`,
    );
  }
  return parsed;
};

const readOptionalInteger = (
  environment: NodeJS.ProcessEnv,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
  errorCode?: string,
): number => {
  const raw = environment[name];
  if (raw === undefined || raw.trim().length === 0) return defaultValue;
  const parsed = /^[0-9]+$/u.test(raw) ? Number(raw) : Number.NaN;
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    throw new Error(
      errorCode ?? `BACKLINKS_CONTACT_CONFIGURATION_INVALID:${name}`,
    );
  }
  return parsed;
};

const readContactEnrichmentConfiguration = (
  environment: NodeJS.ProcessEnv,
  browserProviderEnabled: boolean,
) => {
  let browserWorkerEndpoint: string | null = null;
  if (browserProviderEnabled) {
    const rawEndpoint = requireEnvironmentText(
      environment,
      "BROWSER_WORKER_ENDPOINT",
    );
    let parsed: URL;
    try {
      parsed = new URL(rawEndpoint);
    } catch {
      throw new Error("BACKLINKS_BROWSER_WORKER_ENDPOINT_INVALID");
    }
    if (
      parsed.protocol !== "http:"
      || !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)
      || parsed.username.length > 0
      || parsed.password.length > 0
    ) {
      throw new Error("BACKLINKS_BROWSER_WORKER_ENDPOINT_INVALID");
    }
    browserWorkerEndpoint = parsed.toString();
  }
  return {
    browserWorkerEndpoint,
    browserWorkerTimeoutMs: readOptionalInteger(
      environment,
      "BROWSER_WORKER_TIMEOUT_MS",
      defaultContactEnrichmentConfiguration.browserWorkerTimeoutMs,
      1_000,
      120_000,
    ),
    contactEnrichmentFetchTimeoutMs: readOptionalInteger(
      environment,
      "CONTACT_ENRICHMENT_FETCH_TIMEOUT_MS",
      defaultContactEnrichmentConfiguration.contactEnrichmentFetchTimeoutMs,
      1_000,
      120_000,
    ),
    contactEnrichmentMaxPages: readOptionalInteger(
      environment,
      "CONTACT_ENRICHMENT_MAX_PAGES",
      defaultContactEnrichmentConfiguration.contactEnrichmentMaxPages,
      1,
      50,
    ),
    contactEnrichmentMaxDepth: readOptionalInteger(
      environment,
      "CONTACT_ENRICHMENT_MAX_DEPTH",
      defaultContactEnrichmentConfiguration.contactEnrichmentMaxDepth,
      0,
      5,
    ),
    contactEnrichmentMaxAttempts: readOptionalInteger(
      environment,
      "CONTACT_ENRICHMENT_MAX_ATTEMPTS",
      defaultContactEnrichmentConfiguration.contactEnrichmentMaxAttempts,
      1,
      10,
    ),
  };
};

const assertDataForSeoConfiguration = (
  environment: NodeJS.ProcessEnv,
): void => {
  try {
    parseLocalProductSecretReference(
      requireEnvironmentText(
        environment,
        "DATAFORSEO_CREDENTIAL_SECRET_REF",
      ),
      secretKinds.dataForSeoCredential,
    );
  } catch {
    throw new Error("BACKLINKS_DATAFORSEO_CREDENTIAL_SECRET_REF_INVALID");
  }
  let endpoints: unknown;
  try {
    endpoints = JSON.parse(requireEnvironmentText(
      environment,
      "DATAFORSEO_ENDPOINT_ALLOWLIST",
    ));
  } catch {
    throw new Error("BACKLINKS_DATAFORSEO_ENDPOINT_ALLOWLIST_INVALID");
  }
  if (
    !localProductDataForSeoEndpointAllowlistSchema.safeParse(endpoints)
      .success
  ) {
    throw new Error("BACKLINKS_DATAFORSEO_ENDPOINT_ALLOWLIST_INVALID");
  }
  readDataForSeoInteger(
    environment,
    "DATAFORSEO_MAX_PAID_CALLS",
    1,
    1_000,
    "BACKLINKS_DATAFORSEO_CALL_LIMIT_INVALID",
  );
  const estimatedCostMicros = readDataForSeoInteger(
    environment,
    "DATAFORSEO_ESTIMATED_COST_MICROS",
    1,
    100_000_000,
  );
  readDataForSeoInteger(
    environment,
    "DATAFORSEO_ABSOLUTE_BUDGET_MICROS",
    estimatedCostMicros,
    100_000_000,
  );
  readDataForSeoInteger(
    environment,
    "DATAFORSEO_REQUEST_TIMEOUT_MS",
    1,
    120_000,
  );
  readDataForSeoInteger(
    environment,
    "DATAFORSEO_CANDIDATE_LIMIT",
    10,
    100,
  );
};

export function readBacklinksLiveCapabilities(
  environment: NodeJS.ProcessEnv = process.env,
): BacklinksLiveCapabilities {
  const mode = environment.BACKLINKS_RUNTIME_MODE ?? "DISABLED";
  if (mode === "DISABLED") {
    for (const name of providerFlagNames) {
      requiredDisabledFlag(environment, name);
    }
    if (
      environment.GOOGLE_OAUTH_ENABLED === "true"
      || environment.PLATFORM_SECRET_STORE_ENABLED === "true"
    ) {
      throw new Error("BACKLINKS_LOCAL_PRODUCT_MODE_REQUIRED");
    }
    return {
      mode,
      stage: null,
      googleOauthEnabled: false,
      gmailSendEnabled: false,
      gmailSyncEnabled: false,
      ...defaultGmailSendConfiguration,
      dataForSeoEnabled: false,
      aiProviderEnabled: false,
      browserProviderEnabled: false,
      ...defaultContactEnrichmentConfiguration,
      secretStoreEnabled: false,
      googleOauthClientId: null,
      googleOauthClientSecretReference: null,
      gmailRecipientSecretReference: null,
      googleOauthRedirectUri: null,
      secretStoreRoot: null,
    };
  }
  if (
    mode !== "LOCAL_PRODUCT_ACCEPTANCE"
    && mode !== "LOCAL_PRODUCT"
  ) {
    throw new Error("BACKLINKS_RUNTIME_MODE_UNSUPPORTED");
  }

  if (mode === "LOCAL_PRODUCT") {
    if (environment.BACKLINKS_LIVE_CANARY_STAGE !== undefined) {
      throw new Error("BACKLINKS_LOCAL_PRODUCT_STAGE_FORBIDDEN");
    }
    const googleOauthEnabled = readBooleanFlag(
      environment,
      "GOOGLE_OAUTH_ENABLED",
    );
    const secretStoreEnabled = readBooleanFlag(
      environment,
      "PLATFORM_SECRET_STORE_ENABLED",
    );
    const providerFlags = readProviderFlags(environment);
    const needsGoogleOauth = (
      providerFlags.gmailSendEnabled
      || providerFlags.gmailSyncEnabled
    );
    const needsSecretStore = (
      googleOauthEnabled
      || needsGoogleOauth
      || providerFlags.dataForSeoEnabled
      || providerFlags.aiProviderEnabled
    );
    if (
      (needsGoogleOauth && !googleOauthEnabled)
      || (needsSecretStore && !secretStoreEnabled)
    ) {
      throw new Error("BACKLINKS_LOCAL_PRODUCT_CAPABILITY_DEPENDENCY_VIOLATION");
    }

    let secretStoreRoot: string | null = null;
    if (secretStoreEnabled) {
      secretStoreRoot = readSecretStoreConfiguration(
        environment,
      ).secretStoreRoot;
    }

    let googleOauthClientId: string | null = null;
    let clientSecretReference: string | null = null;
    let redirectUri: string | null = null;
    if (googleOauthEnabled) {
      const oauth = readGoogleOauthConfiguration(
        environment,
        localProductGoogleRedirectUri,
      );
      googleOauthClientId = oauth.googleOauthClientId;
      clientSecretReference = oauth.clientSecretReference;
      redirectUri = oauth.redirectUri;
    }
    if (providerFlags.dataForSeoEnabled) {
      assertDataForSeoConfiguration(environment);
    }
    const contactEnrichment = readContactEnrichmentConfiguration(
      environment,
      providerFlags.browserProviderEnabled,
    );
    const gmailSendConfiguration = {
      gmailRolling24HourSendLimit: readOptionalInteger(
        environment,
        "GMAIL_ROLLING_24_HOUR_SEND_LIMIT",
        defaultGmailSendConfiguration.gmailRolling24HourSendLimit,
        1,
        1_000,
        "BACKLINKS_GMAIL_SEND_LIMIT_INVALID",
      ),
      gmailMinimumIntervalSeconds: readOptionalInteger(
        environment,
        "GMAIL_MINIMUM_INTERVAL_SECONDS",
        defaultGmailSendConfiguration.gmailMinimumIntervalSeconds,
        0,
        86_400,
        "BACKLINKS_GMAIL_MINIMUM_INTERVAL_INVALID",
      ),
      gmailPollingIntervalSeconds: readOptionalInteger(
        environment,
        "GMAIL_POLLING_INTERVAL_SECONDS",
        defaultGmailSendConfiguration.gmailPollingIntervalSeconds,
        15,
        3_600,
        "BACKLINKS_GMAIL_POLLING_INTERVAL_INVALID",
      ),
    };

    return {
      mode,
      stage: null,
      googleOauthEnabled,
      secretStoreEnabled,
      googleOauthClientId,
      googleOauthClientSecretReference: clientSecretReference,
      gmailRecipientSecretReference: null,
      googleOauthRedirectUri: redirectUri,
      secretStoreRoot,
      ...providerFlags,
      ...contactEnrichment,
      ...gmailSendConfiguration,
    };
  }

  const stage = localProductStageSchema.safeParse(
    environment.BACKLINKS_LIVE_CANARY_STAGE,
  );
  if (!stage.success) {
    throw new Error("BACKLINKS_LIVE_STAGE_UNSUPPORTED");
  }
  const googleOauthEnabled = readBooleanFlag(
    environment,
    "GOOGLE_OAUTH_ENABLED",
  );
  const secretStoreEnabled = readBooleanFlag(
    environment,
    "PLATFORM_SECRET_STORE_ENABLED",
  );
  const {
    gmailSendEnabled,
    gmailSyncEnabled,
    dataForSeoEnabled,
    aiProviderEnabled,
    browserProviderEnabled,
  } = readProviderFlags(environment);

  const expected = stage.data === "LIVE-003"
    ? { gmailSendEnabled: false, gmailSyncEnabled: false }
    : { gmailSendEnabled: true, gmailSyncEnabled: true };
  if (
    !googleOauthEnabled
    || !secretStoreEnabled
    || gmailSendEnabled !== expected.gmailSendEnabled
    || gmailSyncEnabled !== expected.gmailSyncEnabled
    || dataForSeoEnabled
    || aiProviderEnabled
    || browserProviderEnabled
  ) {
    throw new Error(`BACKLINKS_LIVE_CAPABILITY_MATRIX_VIOLATION:${stage.data}`);
  }

  const expectedRedirectUri = localProductGoogleRedirectUri;
  const {
    googleOauthClientId,
    clientSecretReference,
    redirectUri,
  } = readGoogleOauthConfiguration(environment, expectedRedirectUri);
  const localAppData = requireEnvironmentText(environment, "LOCALAPPDATA");
  const secretStoreRoot = resolve(requireEnvironmentText(
    environment,
    "PLATFORM_SECRET_STORE_ROOT",
  ));
  const expectedSecretStoreRoot = resolve(
    localAppData,
    "GrowthOS",
    "live001",
    "secrets",
  );
  if (secretStoreRoot !== expectedSecretStoreRoot) {
    throw new Error("BACKLINKS_SECRET_STORE_ROOT_INVALID");
  }
  if (requireEnvironmentText(
    environment,
    "PLATFORM_SECRET_STORE_PROVIDER",
  ) !== "platform-secret-store") {
    throw new Error("BACKLINKS_SECRET_STORE_PROVIDER_INVALID");
  }
  const gmailRecipientSecretReference = stage.data === "LIVE-004"
    ? requireEnvironmentText(
        environment,
        "GMAIL_CANARY_RECIPIENT_SECRET_REF",
      )
    : null;
  if (
    gmailRecipientSecretReference !== null
    && gmailRecipientSecretReference
      !== localProductGmailCanaryRecipientReference
  ) {
    throw new Error("BACKLINKS_GMAIL_RECIPIENT_SECRET_REF_INVALID");
  }

  return {
    mode,
    stage: stage.data,
    googleOauthEnabled,
    gmailSendEnabled,
    gmailSyncEnabled,
    ...defaultGmailSendConfiguration,
    dataForSeoEnabled,
    aiProviderEnabled,
    browserProviderEnabled,
    ...defaultContactEnrichmentConfiguration,
    secretStoreEnabled,
    googleOauthClientId,
    googleOauthClientSecretReference: clientSecretReference,
    gmailRecipientSecretReference,
    googleOauthRedirectUri: redirectUri,
    secretStoreRoot,
  };
}
