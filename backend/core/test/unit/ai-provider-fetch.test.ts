import { describe, expect, it, vi } from "vitest";

import {
  selectAiProviderFetch,
} from "../../src/modules/backlinks/adapters/ai/ai-provider-fetch.js";

describe("AI Provider fetch isolation", () => {
  it("uses the direct transport by default", () => {
    const directFetch = vi.fn() as unknown as typeof globalThis.fetch;
    const inheritedFetch = vi.fn() as unknown as typeof globalThis.fetch;

    expect(selectAiProviderFetch("direct", {
      directFetch,
      inheritedFetch,
    })).toBe(directFetch);
  });

  it("inherits the process fetch only when explicitly configured", () => {
    const directFetch = vi.fn() as unknown as typeof globalThis.fetch;
    const inheritedFetch = vi.fn() as unknown as typeof globalThis.fetch;

    expect(selectAiProviderFetch("inherit", {
      directFetch,
      inheritedFetch,
    })).toBe(inheritedFetch);
  });
});
