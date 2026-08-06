import { describe, expect, it } from "vitest";

import {
  buildLocalProductGoogleRedirectUri,
  localProductGoogleRedirectUri,
  parseGoogleWebOAuthCredentials,
  updateLocalProductOauthManifest,
} from "../../src/modules/backlinks/runtime/local-product-oauth-bootstrap.js";

const projectKey = "elephtv";
const redirectUri = buildLocalProductGoogleRedirectUri(projectKey);
const credentials = {
  web: {
    client_id: "canary.apps.googleusercontent.com",
    project_id: "growthos-local-canary",
    client_secret: "sensitive-client-secret",
    redirect_uris: [redirectUri],
  },
};

const manifest = {
  schemaVersion: "growthos.live-auth.v1",
  authorization: {
    approvedBy: null,
    approvedAt: null,
    validFrom: null,
    validUntil: null,
  },
  runtime: {
    mode: "LOCAL_PRODUCT_ACCEPTANCE",
    publicBaseUrl: "http://localhost:7200",
    websiteProjectKey: projectKey,
  },
  google: {
    cloudProjectId: null,
    oauthClientId: null,
    oauthClientSecretRef: null,
    redirectUri,
    testUserMaskedId: null,
    secretStoreProvider: "platform-secret-store",
  },
  gmail: {
    syncMode: "polling",
    maxSendCalls: 1,
  },
};

describe("local product OAuth bootstrap", () => {
  it("accepts only a Web client with the exact local callback", () => {
    expect(localProductGoogleRedirectUri).toBe(
      "http://localhost:7200/api/v1/backlinks/gmail-connections/callback",
    );
    expect(parseGoogleWebOAuthCredentials(credentials, redirectUri)).toEqual({
      clientId: credentials.web.client_id,
      clientSecret: credentials.web.client_secret,
      projectId: credentials.web.project_id,
    });
    expect(() => parseGoogleWebOAuthCredentials({
      web: {
        ...credentials.web,
        redirect_uris: ["http://localhost:7200/wrong"],
      },
    }, redirectUri)).toThrow("GOOGLE_OAUTH_REDIRECT_URI_NOT_REGISTERED");
    expect(() => parseGoogleWebOAuthCredentials({
      installed: credentials.web,
    }, redirectUri)).toThrow("GOOGLE_OAUTH_WEB_CREDENTIAL_FILE_INVALID");
  });

  it("writes only the Secret Reference and stable callback", () => {
    const updated = updateLocalProductOauthManifest(manifest, {
      clientId: credentials.web.client_id,
      projectId: credentials.web.project_id,
      websiteProjectKey: projectKey,
      maxSendCalls: 20,
    });
    expect(updated).toMatchObject({
      authorization: {
        approvedBy: null,
        approvedAt: null,
        validFrom: null,
        validUntil: null,
      },
      runtime: {
        mode: "LOCAL_PRODUCT",
        websiteProjectKey: projectKey,
      },
      google: {
        cloudProjectId: credentials.web.project_id,
        oauthClientId: credentials.web.client_id,
        oauthClientSecretRef:
          "secret://growthos/local-product/google/oauth-client-secret/v1",
        redirectUri,
      },
      gmail: {
        syncMode: "polling",
        maxSendCalls: 20,
      },
    });
    expect(JSON.stringify(updated)).not.toContain(
      credentials.web.client_secret,
    );
  });
});
