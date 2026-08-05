import { describe, expect, it, vi } from "vitest";

import { dataForSeoClientConfigSchema } from "../../src/modules/backlinks/adapters/dataforseo/config.js";
import {
  DataForSeoClient,
  DataForSeoClientDisabledError,
  DataForSeoClientUnavailableError,
} from "../../src/modules/backlinks/adapters/dataforseo/client.js";
import { DataForSeoRuntimeError } from "../../src/modules/backlinks/adapters/dataforseo/error-mapper.js";

const request = {
  target: "example.com",
  targetType: "domain" as const,
  limit: 100,
};

const enabledConfig = {
  DATAFORSEO_ENABLED: "true" as const,
  DATAFORSEO_CREDENTIAL_SECRET_REF: "secret://growthos/backlinks/dataforseo",
};

describe("DataForSEO client configuration", () => {
  it("defaults to a disabled client with a finite timeout", () => {
    expect(dataForSeoClientConfigSchema.parse({})).toEqual({
      DATAFORSEO_ENABLED: false,
      DATAFORSEO_REQUEST_TIMEOUT_MS: 60_000,
    });
  });

  it.each([
    ["enabled without a secret reference", { DATAFORSEO_ENABLED: "true" }],
    ["zero timeout", { DATAFORSEO_REQUEST_TIMEOUT_MS: "0" }],
    ["decimal timeout", { DATAFORSEO_REQUEST_TIMEOUT_MS: "1.5" }],
    ["excessive timeout", { DATAFORSEO_REQUEST_TIMEOUT_MS: "120001" }],
    ["plaintext login field", { DATAFORSEO_LOGIN: "fixture-login" }],
    ["plaintext password field", { DATAFORSEO_PASSWORD: "fixture-password" }],
  ])("rejects %s", (_name, config) => {
    expect(dataForSeoClientConfigSchema.safeParse(config).success).toBe(false);
  });
});

describe("DataForSEO client shell", () => {
  it("fails closed while disabled without resolving credentials", async () => {
    const resolveSecret = vi.fn();
    const runtimeFactory = vi.fn();
    const client = new DataForSeoClient(
      dataForSeoClientConfigSchema.parse({}),
      resolveSecret,
      runtimeFactory,
    );

    await expect(client.fetchBacklinkSnapshot(request)).rejects.toBeInstanceOf(
      DataForSeoClientDisabledError,
    );
    expect(resolveSecret).not.toHaveBeenCalled();
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("cannot call a provider without an injected runtime", async () => {
    const resolveSecret = vi.fn();
    const client = new DataForSeoClient(
      dataForSeoClientConfigSchema.parse(enabledConfig),
      resolveSecret,
    );

    await expect(client.fetchBacklinkSnapshot(request)).rejects.toBeInstanceOf(
      DataForSeoClientUnavailableError,
    );
    expect(resolveSecret).not.toHaveBeenCalled();
  });

  it("resolves the secret and invokes the injected runtime exactly once", async () => {
    const rawResponse = { version: "fixture", tasks: [] };
    const resolveSecret = vi.fn().mockResolvedValue({
      login: "fixture-login",
      password: "fixture-password",
    });
    const fetchBacklinkSnapshot = vi.fn().mockResolvedValue(rawResponse);
    const runtimeFactory = vi
      .fn()
      .mockReturnValue({ fetchBacklinkSnapshot });
    const client = new DataForSeoClient(
      dataForSeoClientConfigSchema.parse({
        ...enabledConfig,
        DATAFORSEO_REQUEST_TIMEOUT_MS: "60000",
      }),
      resolveSecret,
      runtimeFactory,
    );

    await expect(client.fetchBacklinkSnapshot(request)).resolves.toBe(
      rawResponse,
    );
    expect(resolveSecret).toHaveBeenCalledOnce();
    expect(resolveSecret).toHaveBeenCalledWith(enabledConfig.DATAFORSEO_CREDENTIAL_SECRET_REF);
    expect(runtimeFactory).toHaveBeenCalledOnce();
    expect(runtimeFactory).toHaveBeenCalledWith({
      credentials: {
        login: "fixture-login",
        password: "fixture-password",
      },
      timeoutMs: 60_000,
    });
    expect(fetchBacklinkSnapshot).toHaveBeenCalledOnce();
    expect(fetchBacklinkSnapshot).toHaveBeenCalledWith(request);
  });

  it("does not retry a dispatched paid request after a timeout", async () => {
    const fetchBacklinkSnapshot = vi.fn().mockRejectedValue(
      new DataForSeoRuntimeError({
        kind: "timeout",
        requestDispatched: true,
      }),
    );
    const client = new DataForSeoClient(
      dataForSeoClientConfigSchema.parse(enabledConfig),
      vi.fn().mockResolvedValue({
        login: "fixture-login",
        password: "fixture-password",
      }),
      vi.fn().mockReturnValue({ fetchBacklinkSnapshot }),
    );

    await expect(client.fetchBacklinkSnapshot(request)).rejects.toMatchObject({
      code: "DATAFORSEO_RESULT_UNKNOWN",
      providerRequestStatus: "unknown_charge",
      reconciliationRequired: true,
      retryable: false,
    });
    expect(fetchBacklinkSnapshot).toHaveBeenCalledOnce();
  });

  it("rejects an invalid resolved secret without leaking its value", async () => {
    const leakedValue = "fixture-sensitive-value";
    const runtimeFactory = vi.fn();
    const client = new DataForSeoClient(
      dataForSeoClientConfigSchema.parse(enabledConfig),
      vi.fn().mockResolvedValue({
        login: "fixture-login",
        password: "",
        leakedValue,
      }),
      runtimeFactory,
    );

    const error = await client.fetchBacklinkSnapshot(request).catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(DataForSeoClientUnavailableError);
    expect(String(error)).not.toContain(leakedValue);
    expect(runtimeFactory).not.toHaveBeenCalled();
  });
});
