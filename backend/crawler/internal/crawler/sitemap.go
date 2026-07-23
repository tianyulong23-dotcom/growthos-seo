package crawler

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/xml"
	"errors"
	"io"
	"net/url"
	"sort"
	"strings"
)

const (
	defaultSitemapDocumentLimit = 1000
	defaultSitemapMaxDepth      = 10
)

type queuedSitemap struct {
	URL   string
	Depth int
}

type sitemapDocument struct {
	URLs     []sitemapURL      `xml:"url"`
	Sitemaps []sitemapLocation `xml:"sitemap"`
}

type sitemapURL struct {
	Location string  `xml:"loc"`
	Priority float64 `xml:"priority"`
}

type sitemapLocation struct {
	Location string `xml:"loc"`
}

func DiscoverSitemapURLs(
	ctx context.Context,
	fetcher Fetcher,
	scope Scope,
	sitemapURLs []string,
	limit int,
) ([]Candidate, error) {
	return discoverSitemapURLs(
		ctx,
		fetcher,
		scope,
		sitemapURLs,
		limit,
		defaultSitemapDocumentLimit,
		nil,
	)
}

func discoverSitemapURLs(
	ctx context.Context,
	fetcher Fetcher,
	scope Scope,
	sitemapURLs []string,
	limit int,
	documentLimit int,
	preferredLocales []string,
) ([]Candidate, error) {
	initialURLs := sortSitemapURLs(uniqueStrings(sitemapURLs), preferredLocales)
	queue := make([]queuedSitemap, 0, len(initialURLs))
	for _, sitemapURL := range initialURLs {
		queue = append(queue, queuedSitemap{URL: sitemapURL, Depth: 1})
	}
	seenSitemaps := make(map[string]struct{})
	candidates := make(map[string]Candidate)

	for len(queue) > 0 && len(seenSitemaps) < documentLimit && len(candidates) < limit {
		current := queue[0]
		queue = queue[1:]
		if current.Depth > defaultSitemapMaxDepth {
			continue
		}
		if _, exists := seenSitemaps[current.URL]; exists {
			continue
		}
		seenSitemaps[current.URL] = struct{}{}

		resource, err := fetcher.Fetch(ctx, current.URL)
		if err != nil && resource.StatusCode == 0 {
			continue
		}
		body, err := sitemapBody(resource)
		if err != nil {
			continue
		}
		var document sitemapDocument
		if err := xml.Unmarshal(body, &document); err != nil {
			continue
		}

		baseURL := resource.FinalURL
		if baseURL == "" {
			baseURL = current.URL
		}
		base, _ := url.Parse(baseURL)
		documentURLs := append([]sitemapURL(nil), document.URLs...)
		sort.SliceStable(documentURLs, func(i, j int) bool {
			left := sitemapURLLocalePriority(
				documentURLs[i].Location,
				base,
				preferredLocales,
			)
			right := sitemapURLLocalePriority(
				documentURLs[j].Location,
				base,
				preferredLocales,
			)
			return left > right
		})
		for _, item := range documentURLs {
			normalized, err := scope.Normalize(item.Location, base)
			if err != nil {
				continue
			}
			value := normalized.String()
			candidate := Candidate{
				URL:             normalized,
				Depth:           0,
				DiscoveredFrom:  current.URL,
				FromSitemap:     true,
				SitemapPriority: item.Priority,
				LocalePriority: sitemapURLLocalePriority(
					item.Location,
					base,
					preferredLocales,
				),
			}
			candidate.Score = ScoreCandidate(candidate)
			if previous, exists := candidates[value]; !exists || candidate.Score > previous.Score {
				candidates[value] = candidate
			}
			if len(candidates) >= limit {
				break
			}
		}
		nestedSitemaps := make([]string, 0, len(document.Sitemaps))
		for _, item := range document.Sitemaps {
			nested, err := scope.Normalize(strings.TrimSpace(item.Location), base)
			if err != nil {
				continue
			}
			nestedSitemaps = append(nestedSitemaps, nested.String())
		}
		if len(nestedSitemaps) > 0 && current.Depth < defaultSitemapMaxDepth {
			nestedSitemaps = sortSitemapURLs(
				uniqueStrings(nestedSitemaps),
				preferredLocales,
			)
			nestedQueue := make([]queuedSitemap, 0, len(nestedSitemaps))
			for _, nestedURL := range nestedSitemaps {
				nestedQueue = append(nestedQueue, queuedSitemap{
					URL:   nestedURL,
					Depth: current.Depth + 1,
				})
			}
			queue = append(nestedQueue, queue...)
		}
	}

	result := make([]Candidate, 0, len(candidates))
	for _, candidate := range candidates {
		result = append(result, candidate)
	}
	SortCandidates(result)
	return result, nil
}

func sortSitemapURLs(values, preferredLocales []string) []string {
	result := append([]string(nil), values...)
	locales := normalizedLocaleTokens(preferredLocales)
	sort.SliceStable(result, func(i, j int) bool {
		left := sitemapPriority(result[i], locales)
		right := sitemapPriority(result[j], locales)
		if left == right {
			return result[i] < result[j]
		}
		return left > right
	})
	return result
}

func sitemapPriority(value string, preferredLocales []string) int {
	normalized := strings.ToLower(value)
	score := 0
	for _, locale := range preferredLocales {
		if sitemapMatchesLocale(normalized, locale) {
			score += 100
			break
		}
	}
	switch {
	case strings.Contains(normalized, "landing"),
		strings.Contains(normalized, "service"),
		strings.Contains(normalized, "solution"):
		score += 40
	case strings.Contains(normalized, "product"),
		strings.Contains(normalized, "category"),
		strings.Contains(normalized, "collection"):
		score += 30
	case strings.Contains(normalized, "help"),
		strings.Contains(normalized, "contact"),
		strings.Contains(normalized, "location"):
		score += 20
	case strings.Contains(normalized, "article"),
		strings.Contains(normalized, "blog"),
		strings.Contains(normalized, "news"):
		score -= 20
	}
	return score
}

func sitemapMatchesLocale(value, locale string) bool {
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	locale = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(locale), "_", "-"))
	if locale == "" {
		return false
	}
	for _, segment := range strings.Split(strings.Trim(parsed.Path, "/"), "/") {
		segment = strings.ToLower(segment)
		withoutExtension := strings.TrimSuffix(segment, pathExtension(segment))
		if withoutExtension == locale {
			return true
		}
		if strings.Contains(locale, "-") &&
			(strings.HasSuffix(withoutExtension, "-"+locale) ||
				strings.HasPrefix(withoutExtension, locale+"-") ||
				strings.Contains(withoutExtension, "-"+locale+"-")) {
			return true
		}
	}
	return false
}

func pathExtension(value string) string {
	if index := strings.LastIndex(value, "."); index >= 0 {
		return value[index:]
	}
	return ""
}

func normalizedLocaleTokens(values []string) []string {
	tokens := make([]string, 0, len(values)*2)
	for _, value := range values {
		normalized := strings.ToLower(strings.TrimSpace(value))
		if normalized == "" {
			continue
		}
		normalized = strings.ReplaceAll(normalized, "_", "-")
		tokens = append(tokens, normalized, strings.ReplaceAll(normalized, "-", "_"))
	}
	return uniqueStrings(tokens)
}

func sitemapBody(resource Resource) ([]byte, error) {
	if len(resource.Body) == 0 {
		return nil, errors.New("empty sitemap")
	}
	if strings.HasSuffix(strings.ToLower(resource.FinalURL), ".gz") ||
		strings.Contains(strings.ToLower(resource.ContentType), "gzip") {
		reader, err := gzip.NewReader(bytes.NewReader(resource.Body))
		if err != nil {
			return nil, err
		}
		defer reader.Close()
		return io.ReadAll(io.LimitReader(reader, 10*1024*1024))
	}
	return resource.Body, nil
}

func pathDepth(value string) int {
	trimmed := strings.Trim(value, "/")
	if trimmed == "" {
		return 0
	}
	return len(strings.Split(trimmed, "/"))
}
