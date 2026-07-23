package crawler

import (
	"net/url"
	"sort"
	"strings"
)

func normalizeLocaleTag(value string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), "_", "-"))
}

func localePrimary(value string) string {
	normalized := normalizeLocaleTag(value)
	if normalized == "" {
		return ""
	}
	return strings.Split(normalized, "-")[0]
}

func localeRegion(value string) string {
	parts := strings.Split(normalizeLocaleTag(value), "-")
	for index := len(parts) - 1; index > 0; index-- {
		part := parts[index]
		if len(part) == 2 && allASCIIAlpha(part) {
			return strings.ToUpper(part)
		}
		if len(part) == 3 && allASCIIDigit(part) {
			return part
		}
	}
	return ""
}

func localeMatchQuality(language, country, actual string) int {
	requestedPrimary := localePrimary(language)
	actualPrimary := localePrimary(actual)
	if requestedPrimary == "" || actualPrimary == "" || requestedPrimary != actualPrimary {
		return 0
	}
	requestedCountry := strings.ToUpper(strings.TrimSpace(country))
	actualCountry := localeRegion(actual)
	if requestedCountry == "" {
		if normalizeLocaleTag(language) == normalizeLocaleTag(actual) {
			return 3
		}
		return 2
	}
	if actualCountry == requestedCountry {
		return 3
	}
	if actualCountry == "" {
		return 2
	}
	return 0
}

func pageMatchesRequestedLocale(task Task, page Page) bool {
	if strings.TrimSpace(page.Language) == "" {
		return true
	}
	return localeMatchQuality(task.Language, task.Country, page.Language) > 0
}

func localizedLanguageRoot(pageURL *url.URL, language string) bool {
	if pageURL == nil || strings.TrimSpace(language) == "" {
		return false
	}
	segments := strings.Split(strings.Trim(pageURL.Path, "/"), "/")
	if len(segments) != 1 || segments[0] == "" {
		return false
	}
	pathLocale := normalizeLocaleTag(segments[0])
	return pathLocale == normalizeLocaleTag(language) || pathLocale == localePrimary(language)
}

func addMatchingHreflangCandidates(
	candidates map[string]Candidate,
	scope Scope,
	page Page,
	task Task,
	limit int,
) {
	if len(candidates) >= limit {
		return
	}
	type localeAlternate struct {
		url     *url.URL
		quality int
	}
	alternates := make([]localeAlternate, 0, len(page.Hreflang))
	for _, alternate := range page.Hreflang {
		quality := localeMatchQuality(task.Language, task.Country, alternate.Language)
		if quality == 0 {
			continue
		}
		normalized, err := scope.Normalize(alternate.URL, nil)
		if err != nil {
			continue
		}
		alternates = append(alternates, localeAlternate{url: normalized, quality: quality})
	}
	sort.SliceStable(alternates, func(i, j int) bool {
		if alternates[i].quality == alternates[j].quality {
			return alternates[i].url.String() < alternates[j].url.String()
		}
		return alternates[i].quality > alternates[j].quality
	})
	for _, alternate := range alternates {
		addCandidate(candidates, Candidate{
			URL:            alternate.url,
			Depth:          pathDepth(alternate.url.Path),
			DiscoveredFrom: defaultString(page.FinalURL, page.URL),
			Placement:      "alternate",
			LocalePriority: alternate.quality * 50,
		})
		if len(candidates) >= limit {
			return
		}
	}
}

func sitemapURLLocalePriority(
	rawURL string,
	base *url.URL,
	preferredLocales []string,
) int {
	resolved, err := base.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return 0
	}
	for index, locale := range preferredLocales {
		if sitemapMatchesLocale(resolved.String(), locale) {
			return max(1, 100-index*5)
		}
	}
	return 0
}
