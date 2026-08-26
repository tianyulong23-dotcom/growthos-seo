import { describe, expect, it } from "vitest";

import {
  extractTargetLanguageSearchPhrases,
} from "../../src/modules/backlinks/application/services/target-language-search-phrase.js";

describe("target language search phrase normalization", () => {
  it("extracts target-language fragments from slash, parentheses, and newlines", () => {
    expect(extractTargetLanguageSearchPhrases(
      [
        "直播 / live streaming",
        "影视（film reviews）",
        "中文主题\ncontent marketing",
      ],
      "en",
    )).toEqual([
      "live streaming",
      "film reviews",
      "content marketing",
    ]);
  });

  it("skips pure Chinese values for English discovery", () => {
    expect(extractTargetLanguageSearchPhrases(
      ["直播", "影视", "南非观众"],
      "en",
    )).toEqual([]);
  });

  it("retains Chinese fragments for Chinese discovery", () => {
    expect(extractTargetLanguageSearchPhrases(
      ["直播 / live streaming", "影视（film reviews）"],
      "zh-CN",
    )).toEqual(["直播", "影视"]);
  });

  it("deduplicates target-language fragments without case sensitivity", () => {
    expect(extractTargetLanguageSearchPhrases(
      ["Live Streaming", "live streaming", "LIVE STREAMING"],
      "en",
    )).toEqual(["Live Streaming"]);
  });
});
