import { describe, expect, it } from "vitest";

import {
  readBacklinksLiveCapabilities,
} from "../../src/modules/backlinks/runtime/live-capabilities.js";

const localAppData = "C:\\Users\\local\\AppData\\Local";
const base = {
  BACKLINKS_RUNTIME_MODE: "LOCAL_PRODUCT_ACCEPTANCE",
  BACKLINKS_LIVE_CANARY_STAGE: "LIVE-003",
  GOOGLE_OAUTH_ENABLED: "true",
  PLATFORM_SECRET_STORE_ENABLED: "true",
  PLATFORM_SECRET_STORE_PROVIDER: "platform-secret-store",
  PLATFORM_SECRET_STORE_ROOT:
    `${localAppData}\\GrowthOS\\live001\\secrets`,
  GOOGLE_OAUTH_CLIENT_ID: "client.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET_REF:
    "secret://growthos/local-product/google/oauth-client-secret/v1",
  GOOGLE_OAUTH_REDIRECT_URI:
    "http://localhost:7200/api/v1/backlinks/gmail-connections/callback",
  GMAIL_SEND_ENABLED: "false",
  GMAIL_SYNC_ENABLED: "false",
  DATAFORSEO_ENABLED: "false",
  AI_PROVIDER_ENABLED: "false",
  BROWSER_PROVIDER_ENABLED: "false",
  LOCALAPPDATA: localAppData,
} as const;
const live004 = {
  ...base,
  BACKLINKS_LIVE_CANARY_STAGE: "LIVE-004",
  GMAIL_SEND_ENABLED: "true",
  GMAIL_SYNC_ENABLED: "true",
  GMAIL_CANARY_RECIPIENT_SECRET_REF:
    "secret://growthos/local-product/gmail/canary-recipient/v1",
} as const;
const localProduct = {
  ...base,
  BACKLINKS_RUNTIME_MODE: "LOCAL_PRODUCT",
  BACKLINKS_LIVE_CANARY_STAGE: undefined,
  LOCAL_PRODUCT_WEBSITE_PROJECT_KEY: "project-real",
  GOOGLE_OAUTH_REDIRECT_URI:
    "http://localhost:7200/api/v1/backlinks/gmail-connections/callback",
  GMAIL_SEND_ENABLED: "true",
  GMAIL_SYNC_ENABLED: "false",
  GMAIL_ROLLING_24_HOUR_SEND_LIMIT: "20",
  GMAIL_MINIMUM_INTERVAL_SECONDS: "120",
  AI_PROVIDER_ENABLED: "true",
} as const;
const localProductDataForSeo = {
  ...localProduct,
  DATAFORSEO_ENABLED: "true",
  DATAFORSEO_CREDENTIAL_SECRET_REF:
    "secret://growthos/local-product/dataforseo/provider-credential/v7",
  DATAFORSEO_ENDPOINT_ALLOWLIST: JSON.stringify([
    "https://api.dataforseo.com/v3/serp/google/organic/task_post",
    "https://api.dataforseo.com/v3/serp/google/organic/tasks_ready",
    "https://api.dataforseo.com/v3/serp/google/organic/task_get/advanced",
    "https://api.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live",
    "https://api.dataforseo.com/v3/backlinks/competitors/live",
    "https://api.dataforseo.com/v3/backlinks/referring_domains/live",
    "https://api.dataforseo.com/v3/backlinks/summary/live",
    "https://api.dataforseo.com/v3/backlinks/backlinks/live",
  ]),
  DATAFORSEO_REQUEST_TIMEOUT_MS: "60000",
  DATAFORSEO_ESTIMATED_COST_MICROS: "1000",
  DATAFORSEO_ABSOLUTE_BUDGET_MICROS: "5000",
  DATAFORSEO_MAX_PAID_CALLS: "25",
  DATAFORSEO_CANDIDATE_LIMIT: "25",
  DATAFORSEO_LOCATION_CODE: "2840",
  DATAFORSEO_LANGUAGE_CODE: "en",
  DATAFORSEO_PROJECT_KEYWORDS_JSON: '["video streaming"]',
  DATAFORSEO_PROJECT_PRODUCTS_JSON: '["streaming platform"]',
  DATAFORSEO_TARGET_URLS_JSON: '["https://elephtv.com/"]',
} as const;

describe("local product capability matrix", () => {
  it("allows only Google OAuth and Secret Store during LIVE-003", () => {
    expect(readBacklinksLiveCapabilities({ ...base })).toMatchObject({
      mode: "LOCAL_PRODUCT_ACCEPTANCE",
      stage: "LIVE-003",
      googleOauthEnabled: true,
      secretStoreEnabled: true,
      gmailSendEnabled: false,
      gmailSyncEnabled: false,
      dataForSeoEnabled: false,
      aiProviderEnabled: false,
      browserProviderEnabled: false,
      gmailRolling24HourSendLimit: 5,
      gmailMinimumIntervalSeconds: 300,
    });
  });

  it("accepts a legal same-kind Google Secret Reference", () => {
    expect(readBacklinksLiveCapabilities({
      ...localProduct,
      GOOGLE_OAUTH_CLIENT_SECRET_REF:
        "secret://growthos/local-product/google/oauth-client-secret/v7",
    })).toMatchObject({
      googleOauthClientSecretReference:
        "secret://growthos/local-product/google/oauth-client-secret/v7",
    });
    expect(() => readBacklinksLiveCapabilities({
      ...localProduct,
      GOOGLE_OAUTH_CLIENT_SECRET_REF:
        "secret://growthos/local-product/ai/provider-credential/v1",
    })).toThrow("BACKLINKS_GOOGLE_OAUTH_CLIENT_SECRET_REF_INVALID");
  });

  it.each([
    ["GMAIL_SEND_ENABLED", "true"],
    ["GMAIL_SYNC_ENABLED", "true"],
    ["DATAFORSEO_ENABLED", "true"],
    ["AI_PROVIDER_ENABLED", "true"],
    ["BROWSER_PROVIDER_ENABLED", "true"],
    ["GOOGLE_OAUTH_ENABLED", "false"],
  ])("fails closed when %s is %s in LIVE-003", (name, value) => {
    expect(() => readBacklinksLiveCapabilities({
      ...base,
      [name]: value,
    })).toThrow("BACKLINKS_LIVE_CAPABILITY_MATRIX_VIOLATION:LIVE-003");
  });

  it("rejects an incorrect redirect URI and Secret Reference", () => {
    expect(() => readBacklinksLiveCapabilities({
      ...base,
      GOOGLE_OAUTH_REDIRECT_URI: `${base.GOOGLE_OAUTH_REDIRECT_URI}/`,
    })).toThrow("BACKLINKS_GOOGLE_OAUTH_REDIRECT_URI_INVALID");
    expect(() => readBacklinksLiveCapabilities({
      ...base,
      GOOGLE_OAUTH_CLIENT_SECRET_REF: "secret://wrong",
    })).toThrow("BACKLINKS_GOOGLE_OAUTH_CLIENT_SECRET_REF_INVALID");
  });

  it("allows only Gmail send and polling sync during LIVE-004", () => {
    expect(readBacklinksLiveCapabilities({ ...live004 })).toMatchObject({
      mode: "LOCAL_PRODUCT_ACCEPTANCE",
      stage: "LIVE-004",
      googleOauthEnabled: true,
      secretStoreEnabled: true,
      gmailSendEnabled: true,
      gmailSyncEnabled: true,
      gmailRecipientSecretReference:
        "secret://growthos/local-product/gmail/canary-recipient/v1",
      dataForSeoEnabled: false,
      aiProviderEnabled: false,
      browserProviderEnabled: false,
    });
  });

  it("fails closed when the LIVE-004 recipient reference is absent or wrong", () => {
    expect(() => readBacklinksLiveCapabilities({
      ...live004,
      GMAIL_CANARY_RECIPIENT_SECRET_REF: undefined,
    }))
      .toThrow(
        "BACKLINKS_LIVE_CONFIGURATION_MISSING:"
          + "GMAIL_CANARY_RECIPIENT_SECRET_REF",
      );
    expect(() => readBacklinksLiveCapabilities({
      ...live004,
      GMAIL_CANARY_RECIPIENT_SECRET_REF: "secret://wrong",
    })).toThrow("BACKLINKS_GMAIL_RECIPIENT_SECRET_REF_INVALID");
  });

  it.each([
    ["GMAIL_SEND_ENABLED", "false"],
    ["GMAIL_SYNC_ENABLED", "false"],
    ["DATAFORSEO_ENABLED", "true"],
    ["AI_PROVIDER_ENABLED", "true"],
    ["BROWSER_PROVIDER_ENABLED", "true"],
    ["GOOGLE_OAUTH_ENABLED", "false"],
  ])("fails closed when %s is %s in LIVE-004", (name, value) => {
    expect(() => readBacklinksLiveCapabilities({
      ...live004,
      [name]: value,
    })).toThrow("BACKLINKS_LIVE_CAPABILITY_MATRIX_VIOLATION:LIVE-004");
  });

  it("preserves the default all-disabled runtime contract", () => {
    expect(readBacklinksLiveCapabilities({
      GMAIL_SEND_ENABLED: "false",
      GMAIL_SYNC_ENABLED: "false",
      DATAFORSEO_ENABLED: "false",
      AI_PROVIDER_ENABLED: "false",
      BROWSER_PROVIDER_ENABLED: "false",
    })).toMatchObject({
      mode: "DISABLED",
      stage: null,
      googleOauthEnabled: false,
    });
  });

  it("allows independent LOCAL_PRODUCT capabilities for the current project", () => {
    expect(readBacklinksLiveCapabilities({ ...localProduct })).toMatchObject({
      mode: "LOCAL_PRODUCT",
      stage: null,
      googleOauthEnabled: true,
      gmailSendEnabled: true,
      gmailSyncEnabled: false,
      dataForSeoEnabled: false,
      aiProviderEnabled: true,
      browserProviderEnabled: false,
      gmailRolling24HourSendLimit: 20,
      gmailMinimumIntervalSeconds: 120,
      gmailRecipientSecretReference: null,
      googleOauthRedirectUri:
        "http://localhost:7200/api/v1/backlinks/gmail-connections/callback",
    });
  });

  it("does not require Google OAuth when all credential-backed providers are off", () => {
    expect(readBacklinksLiveCapabilities({
      BACKLINKS_RUNTIME_MODE: "LOCAL_PRODUCT",
      GOOGLE_OAUTH_ENABLED: "false",
      PLATFORM_SECRET_STORE_ENABLED: "false",
      GMAIL_SEND_ENABLED: "false",
      GMAIL_SYNC_ENABLED: "false",
      DATAFORSEO_ENABLED: "false",
      AI_PROVIDER_ENABLED: "false",
      BROWSER_PROVIDER_ENABLED: "false",
    })).toMatchObject({
      mode: "LOCAL_PRODUCT",
      googleOauthEnabled: false,
      secretStoreEnabled: false,
    });
  });

  it("does not require a default project key for the project-scoped worker", () => {
    expect(readBacklinksLiveCapabilities({
      ...localProduct,
      LOCAL_PRODUCT_WEBSITE_PROJECT_KEY: undefined,
    })).toMatchObject({
      mode: "LOCAL_PRODUCT",
      googleOauthEnabled: true,
      googleOauthRedirectUri:
        "http://localhost:7200/api/v1/backlinks/gmail-connections/callback",
    });
  });

  it("fails closed for a stale stage or mismatched stable redirect", () => {
    expect(() => readBacklinksLiveCapabilities({
      ...localProduct,
      BACKLINKS_LIVE_CANARY_STAGE: "LIVE-004",
    })).toThrow("BACKLINKS_LOCAL_PRODUCT_STAGE_FORBIDDEN");
    expect(() => readBacklinksLiveCapabilities({
      ...localProduct,
      GOOGLE_OAUTH_REDIRECT_URI:
        "http://localhost:7200/api/v1/projects/project-real/backlinks/gmail-connections/callback",
    })).toThrow("BACKLINKS_GOOGLE_OAUTH_REDIRECT_URI_INVALID");
  });

  it("fails closed when Gmail or AI lacks its credential dependency", () => {
    expect(() => readBacklinksLiveCapabilities({
      ...localProduct,
      GOOGLE_OAUTH_ENABLED: "false",
    })).toThrow(
      "BACKLINKS_LOCAL_PRODUCT_CAPABILITY_DEPENDENCY_VIOLATION",
    );
    expect(() => readBacklinksLiveCapabilities({
      ...localProduct,
      GMAIL_SEND_ENABLED: "false",
      AI_PROVIDER_ENABLED: "true",
      PLATFORM_SECRET_STORE_ENABLED: "false",
    })).toThrow(
      "BACKLINKS_LOCAL_PRODUCT_CAPABILITY_DEPENDENCY_VIOLATION",
    );
  });

  it("allows bounded LOCAL_PRODUCT DataForSEO controls", () => {
    expect(readBacklinksLiveCapabilities({
      ...localProductDataForSeo,
      DATAFORSEO_REQUEST_TIMEOUT_MS: "300000",
    })).toMatchObject({
      mode: "LOCAL_PRODUCT",
      dataForSeoEnabled: true,
      secretStoreEnabled: true,
      browserProviderEnabled: false,
    });
  });

  it.each([
    [
      "DATAFORSEO_CREDENTIAL_SECRET_REF",
      "secret://wrong",
      "BACKLINKS_DATAFORSEO_CREDENTIAL_SECRET_REF_INVALID",
    ],
    [
      "DATAFORSEO_ENDPOINT_ALLOWLIST",
      '["https://api.dataforseo.com/v3/backlinks/summary/live"]',
      "BACKLINKS_DATAFORSEO_ENDPOINT_ALLOWLIST_INVALID",
    ],
    [
      "DATAFORSEO_MAX_PAID_CALLS",
      "1001",
      "BACKLINKS_DATAFORSEO_CALL_LIMIT_INVALID",
    ],
    [
      "DATAFORSEO_REQUEST_TIMEOUT_MS",
      "300001",
      "BACKLINKS_DATAFORSEO_CONFIGURATION_INVALID:"
        + "DATAFORSEO_REQUEST_TIMEOUT_MS",
    ],
  ])(
    "fails closed when %s is unsafe",
    (name, value, expectedError) => {
      expect(() => readBacklinksLiveCapabilities({
        ...localProductDataForSeo,
        [name]: value,
      })).toThrow(expectedError);
    },
  );
});
