const scriptPatterns = Object.freeze({
  arabic: /\p{Script=Arabic}/u,
  cyrillic: /\p{Script=Cyrillic}/u,
  han: /\p{Script=Han}/u,
  hangul: /\p{Script=Hangul}/u,
  hiragana: /\p{Script=Hiragana}/u,
  katakana: /\p{Script=Katakana}/u,
  latin: /\p{Script=Latin}/u,
});

function languageBase(languageCode: string): string {
  return languageCode.trim().toLowerCase().split(/[-_]/u)[0] ?? "";
}

function normalizedComparisonKey(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, " ");
}

function targetLanguageCompatible(
  value: string,
  languageCode: string,
): boolean {
  if (!/[\p{L}\p{N}]/u.test(value)) {
    return false;
  }
  const language = languageBase(languageCode);
  const requiredScripts = language === "zh"
    ? new Set(["han"])
    : language === "ja"
      ? new Set(["han", "hiragana", "katakana"])
      : language === "ko"
        ? new Set(["hangul"])
        : language === "ru"
          ? new Set(["cyrillic"])
          : language === "ar"
            ? new Set(["arabic"])
            : new Set(["latin"]);
  const allowedScripts = language === "zh"
    ? new Set(["han", "latin"])
    : language === "ja"
      ? new Set(["han", "hiragana", "katakana", "latin"])
      : language === "ko"
        ? new Set(["han", "hangul", "latin"])
        : language === "ru"
          ? new Set(["cyrillic", "latin"])
          : language === "ar"
            ? new Set(["arabic", "latin"])
            : new Set(["latin"]);
  const entries = Object.entries(scriptPatterns);
  return entries.some(([script, pattern]) =>
    requiredScripts.has(script) && pattern.test(value)
  ) && entries.every(([script, pattern]) =>
    !pattern.test(value) || allowedScripts.has(script)
  );
}

function phraseSegments(value: string): readonly string[] {
  const normalized = value.normalize("NFKC");
  const parenthetical: string[] = [];
  const outer = normalized.replace(/\(([^()]*)\)/gu, (_match, inner: string) => {
    parenthetical.push(inner);
    return " ";
  });
  return Object.freeze(
    [outer, ...parenthetical]
      .flatMap((part) => part.split(/[\/\\|;\r\n]+/u))
      .map((part) => part.trim().replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, ""))
      .filter(Boolean),
  );
}

export function extractTargetLanguageSearchPhrases(
  values: readonly string[],
  languageCode: string,
): readonly string[] {
  const phrases: string[] = [];
  const seen = new Set<string>();
  for (const phrase of values.flatMap(phraseSegments)) {
    if (!targetLanguageCompatible(phrase, languageCode)) {
      continue;
    }
    const key = normalizedComparisonKey(phrase);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    phrases.push(phrase);
  }
  return Object.freeze(phrases);
}
