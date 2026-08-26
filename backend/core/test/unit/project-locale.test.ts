import { describe, expect, it } from "vitest";

import {
  resolveDataForSeoProjectLocale,
} from "../../src/modules/backlinks/adapters/dataforseo/project-locale.js";

describe("DataForSEO project locale", () => {
  it("derives provider scope from the Website Project snapshot", () => {
    expect(resolveDataForSeoProjectLocale({
      countryCode: " ZA ",
      locale: "en-ZA",
    })).toEqual({
      countryCode: "ZA",
      locationCode: "2710",
      languageCode: "en",
    });
    expect(resolveDataForSeoProjectLocale({
      countryCode: "us",
      locale: "EN_us",
    })).toEqual({
      countryCode: "US",
      locationCode: "2840",
      languageCode: "en",
    });
    expect(resolveDataForSeoProjectLocale({
      countryCode: "CN",
      locale: "zh-Hans",
    })).toEqual({
      countryCode: "CN",
      locationCode: "2156",
      languageCode: "zh",
    });
  });

  it("fails closed for unsupported persisted project markets", () => {
    expect(() => resolveDataForSeoProjectLocale({
      countryCode: "South Africa",
      locale: "en",
    })).toThrow("DATAFORSEO_PROJECT_COUNTRY_UNSUPPORTED");
    expect(() => resolveDataForSeoProjectLocale({
      countryCode: "ZA",
      locale: "english",
    })).toThrow("DATAFORSEO_PROJECT_LANGUAGE_UNSUPPORTED");
  });
});
