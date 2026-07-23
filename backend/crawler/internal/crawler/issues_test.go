package crawler

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
)

func TestIssueDetectorCoversLibreCrawlRules(t *testing.T) {
	base := Page{
		URL:            "https://example.com/page",
		FinalURL:       "https://example.com/page",
		StatusCode:     200,
		Title:          "A valid page title with enough detail",
		Description:    strings.Repeat("useful description ", 8),
		Canonical:      "https://example.com/page",
		Language:       "en",
		H1:             []string{"A distinct page heading"},
		Viewport:       "width=device-width, initial-scale=1",
		OpenGraph:      map[string]string{"og:title": "Title"},
		TwitterTags:    map[string]string{"card": "summary"},
		StructuredData: []json.RawMessage{json.RawMessage(`{"@type":"WebPage"}`)},
		MainText:       strings.Repeat("content ", 300),
		WordCount:      300,
		SizeBytes:      1024,
		ResponseTimeMS: 500,
	}

	tests := []struct {
		name string
		page Page
		code string
	}{
		{"missing title", mutatePage(base, func(page *Page) { page.Title = "" }), "missing_title"},
		{"title too long", mutatePage(base, func(page *Page) { page.Title = strings.Repeat("t", 61) }), "title_too_long"},
		{"title too short", mutatePage(base, func(page *Page) { page.Title = "short" }), "title_too_short"},
		{"missing description", mutatePage(base, func(page *Page) { page.Description = "" }), "missing_meta_description"},
		{"description too long", mutatePage(base, func(page *Page) { page.Description = strings.Repeat("d", 161) }), "meta_description_too_long"},
		{"description too short", mutatePage(base, func(page *Page) { page.Description = "short" }), "meta_description_too_short"},
		{"missing h1", mutatePage(base, func(page *Page) { page.H1 = nil }), "missing_h1"},
		{"thin content", mutatePage(base, func(page *Page) { page.WordCount = 299 }), "thin_content"},
		{"crawl error", mutatePage(base, func(page *Page) {
			page.StatusCode = 0
			page.Error = "dial timeout"
			page.ErrorType = "timeout"
		}), "crawl_error"},
		{"client error", mutatePage(base, func(page *Page) { page.StatusCode = 404 }), "client_error"},
		{"server error", mutatePage(base, func(page *Page) { page.StatusCode = 500 }), "server_error"},
		{"redirect", mutatePage(base, func(page *Page) { page.StatusCode = 301 }), "redirect"},
		{"missing canonical", mutatePage(base, func(page *Page) { page.Canonical = "" }), "missing_canonical"},
		{"different canonical", mutatePage(base, func(page *Page) { page.Canonical = "https://example.com/other" }), "canonical_different"},
		{"missing viewport", mutatePage(base, func(page *Page) { page.Viewport = "" }), "missing_viewport"},
		{"missing language", mutatePage(base, func(page *Page) { page.Language = "" }), "missing_language"},
		{"missing image alt", mutatePage(base, func(page *Page) {
			page.Images = []SEOImage{{Src: "https://example.com/image.png"}}
		}), "image_missing_alt"},
		{"missing open graph", mutatePage(base, func(page *Page) { page.OpenGraph = nil }), "missing_open_graph"},
		{"missing twitter", mutatePage(base, func(page *Page) { page.TwitterTags = nil }), "missing_twitter_card"},
		{"missing structured data", mutatePage(base, func(page *Page) { page.StructuredData = nil }), "no_structured_data"},
		{"slow response", mutatePage(base, func(page *Page) { page.ResponseTimeMS = 3001 }), "slow_response"},
		{"moderate response", mutatePage(base, func(page *Page) { page.ResponseTimeMS = 1001 }), "moderate_response"},
		{"large page", mutatePage(base, func(page *Page) { page.SizeBytes = 3*1024*1024 + 1 }), "large_page"},
		{"moderate page", mutatePage(base, func(page *Page) { page.SizeBytes = 1024*1024 + 1 }), "moderate_page_size"},
		{"noindex", mutatePage(base, func(page *Page) { page.Robots = "noindex,follow" }), "noindex"},
		{"nofollow", mutatePage(base, func(page *Page) { page.Robots = "index,nofollow" }), "nofollow"},
		{"broken image", mutatePage(base, func(page *Page) {
			page.BrokenImages = []BrokenImage{{URL: "https://example.com/missing.png", StatusCode: 404}}
		}), "broken_image"},
	}

	detector := IssueDetector{}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			issues := detector.Detect([]Page{test.page})
			if !hasIssueCode(issues, test.code) {
				t.Fatalf("issues = %#v, want code %q", issues, test.code)
			}
		})
	}
}

func TestIssueDetectorDoesNotAddNonLibreCrawlRules(t *testing.T) {
	page := Page{
		URL:            "https://example.com/page",
		FinalURL:       "https://example.com/page",
		StatusCode:     200,
		Title:          "The same title and heading with enough detail",
		Description:    strings.Repeat("useful description ", 8),
		Canonical:      "https://example.com/page",
		Language:       "en",
		H1:             []string{"The same title and heading with enough detail", "Second H1"},
		Viewport:       "width=device-width",
		OpenGraph:      map[string]string{"og:title": "Title"},
		TwitterTags:    map[string]string{"card": "summary"},
		StructuredData: []json.RawMessage{json.RawMessage(`{"@type":"WebPage"}`)},
		WordCount:      300,
	}
	issues := (IssueDetector{}).Detect([]Page{page})
	for _, code := range []string{
		"multiple_h1",
		"h1_matches_title",
		"too_many_internal_links",
		"missing_content",
	} {
		if hasIssueCode(issues, code) {
			t.Fatalf("unexpected non-LibreCrawl rule %q: %#v", code, issues)
		}
	}
}

func TestIssueDetectorDuplicateSimilarityWeights(t *testing.T) {
	base := Page{
		URL:         "https://example.com/one",
		FinalURL:    "https://example.com/one",
		StatusCode:  200,
		Title:       "Shared title",
		Description: "Shared description",
		H1:          []string{"First heading"},
		WordCount:   100,
	}
	titleAndDescriptionOnly := base
	titleAndDescriptionOnly.URL = "https://example.com/two"
	titleAndDescriptionOnly.FinalURL = titleAndDescriptionOnly.URL
	titleAndDescriptionOnly.H1 = nil
	titleAndDescriptionOnly.WordCount = 0

	if score := duplicateSimilarity(base, titleAndDescriptionOnly); score != 0.70 {
		t.Fatalf("title + description similarity = %.2f, want 0.70", score)
	}
	if issues := (IssueDetector{}).Detect([]Page{base, titleAndDescriptionOnly}); hasIssueCode(issues, "duplicate_content") {
		t.Fatalf("0.70 similarity unexpectedly emitted duplicate issue: %#v", issues)
	}

	allSignals := titleAndDescriptionOnly
	allSignals.URL = "https://example.com/three"
	allSignals.FinalURL = allSignals.URL
	allSignals.H1 = base.H1
	allSignals.WordCount = base.WordCount
	if score := duplicateSimilarity(base, allSignals); math.Abs(score-1.00) > 1e-9 {
		t.Fatalf("all signal similarity = %.2f, want 1.00", score)
	}
	issues := (IssueDetector{}).Detect([]Page{base, allSignals})
	duplicates := issuesWithCode(issues, "duplicate_content")
	if len(duplicates) != 2 {
		t.Fatalf("duplicate issues = %#v, want one for each URL", duplicates)
	}
}

func TestIssueDetectorKeepsBestDuplicatePerPage(t *testing.T) {
	pages := []Page{
		{
			URL:         "https://example.com/one",
			Title:       "Shared title",
			Description: "Shared description",
			H1:          []string{"Shared heading"},
			WordCount:   100,
		},
		{
			URL:         "https://example.com/two",
			Title:       "Shared title",
			Description: "Shared description",
			H1:          []string{"Shared heading"},
			WordCount:   100,
		},
		{
			URL:         "https://example.com/three",
			Title:       "Shared title",
			Description: "Shared description",
			H1:          []string{"Shared heading"},
			WordCount:   100,
		},
	}

	duplicates := issuesWithCode((IssueDetector{}).Detect(pages), "duplicate_content")
	if len(duplicates) != len(pages) {
		t.Fatalf("duplicate issues = %d, want one per page", len(duplicates))
	}
	for _, issue := range duplicates {
		if issue.RelatedURL == "" || issue.RelatedURL == issue.URL {
			t.Fatalf("invalid duplicate relationship: %#v", issue)
		}
		if math.Abs(issue.Similarity-1) > 1e-9 {
			t.Fatalf("similarity = %f, want 1", issue.Similarity)
		}
	}
}

func TestIssueDetectorMatchesLibreCrawlConfiguration(t *testing.T) {
	base := Page{
		URL:         "https://example.com/page",
		FinalURL:    "https://example.com/final",
		StatusCode:  200,
		Title:       "Shared title",
		Description: "Shared description",
		Canonical:   "https://example.com/page",
		H1:          []string{"Shared heading"},
		WordCount:   100,
	}
	excluded := base
	excluded.URL = "https://example.com/admin/users"
	excluded.FinalURL = excluded.URL

	enabled := false
	issues := (IssueDetector{
		ExclusionPatterns:  []string{"/admin/*"},
		DuplicationEnabled: &enabled,
	}).Detect([]Page{base, excluded})
	if hasIssueCode(issues, "duplicate_content") {
		t.Fatalf("duplication disabled but duplicate issue was emitted: %#v", issues)
	}
	for _, issue := range issues {
		if issue.URL == excluded.URL {
			t.Fatalf("excluded URL emitted issue: %#v", issue)
		}
	}
	if hasIssueCode(issues, "canonical_different") {
		t.Fatalf("canonical should be compared with requested URL: %#v", issues)
	}
}

func TestIssueDetectorUsesUnroundedDuplicateScore(t *testing.T) {
	left := Page{
		URL:         "https://example.com/one",
		Title:       "Same title",
		Description: "Same description",
		H1:          []string{"Same heading"},
		WordCount:   100,
	}
	right := left
	right.URL = "https://example.com/two"
	right.WordCount = 96
	threshold := 0.998

	score := duplicateSimilarity(left, right)
	if score >= threshold {
		t.Fatalf("test setup score = %f, want below %f", score, threshold)
	}
	issues := (IssueDetector{DuplicationLimit: &threshold}).Detect([]Page{left, right})
	if hasIssueCode(issues, "duplicate_content") {
		t.Fatalf("unrounded score unexpectedly emitted duplicate issue: %#v", issues)
	}
}

func TestIssueDetectorComparesEmptyPagesAtZeroThreshold(t *testing.T) {
	left := Page{URL: "https://example.com/one"}
	right := Page{URL: "https://example.com/two"}
	threshold := 0.0

	issues := (IssueDetector{DuplicationLimit: &threshold}).Detect([]Page{left, right})
	duplicates := issuesWithCode(issues, "duplicate_content")
	if len(duplicates) != 2 {
		t.Fatalf("duplicate issues = %#v, want one for each URL", duplicates)
	}
}

func TestIssueDetectorRequiresErrorTypeForNoResponse(t *testing.T) {
	page := Page{URL: "https://example.com/no-response", StatusCode: 0}
	issues := (IssueDetector{}).Detect([]Page{page})
	if hasIssueCode(issues, "crawl_error") {
		t.Fatalf("missing error_type unexpectedly emitted crawl error: %#v", issues)
	}
}

func TestSequenceMatcherSimilarityMatchesPythonAutojunk(t *testing.T) {
	left := "x" + strings.Repeat("a", 300)
	right := "y" + strings.Repeat("a", 300)
	if score := sequenceMatcherSimilarity(left, right); score != 0 {
		t.Fatalf("autojunk similarity = %f, want 0", score)
	}
}

func TestSequenceMatcherSimilarityMatchesPythonRatios(t *testing.T) {
	tests := []struct {
		left  string
		right string
		want  float64
	}{
		{"abcd", "bcde", 0.75},
		{"tide", "diet", 0.25},
		{"diet", "tide", 0.50},
		{"private Thread currentThread;", "private volatile Thread currentThread;", 0.8656716417910447},
		{"qabxcd", "abycdf", 2.0 / 3.0},
	}

	for _, test := range tests {
		got := sequenceMatcherSimilarity(test.left, test.right)
		if math.Abs(got-test.want) > 1e-12 {
			t.Fatalf(
				"sequenceMatcherSimilarity(%q, %q) = %.15f, want %.15f",
				test.left,
				test.right,
				got,
				test.want,
			)
		}
	}
}

func BenchmarkIssueDetectorDuplicatePairTraversal(b *testing.B) {
	for _, pageCount := range benchmarkPageCounts {
		b.Run(fmt.Sprintf("pages_%d", pageCount), func(b *testing.B) {
			pages := make([]Page, pageCount)
			for index := range pages {
				pages[index] = Page{
					URL:       fmt.Sprintf("https://example.com/page-%d", index),
					WordCount: 300,
				}
			}
			b.ReportMetric(
				float64(pageCount*(pageCount-1)/2),
				"pairs/op",
			)
			b.ResetTimer()
			for range b.N {
				_ = (IssueDetector{}).Detect(pages)
			}
		})
	}
}

func mutatePage(page Page, mutate func(*Page)) Page {
	mutate(&page)
	return page
}

func hasIssueCode(issues []Issue, code string) bool {
	return len(issuesWithCode(issues, code)) > 0
}

func issuesWithCode(issues []Issue, code string) []Issue {
	result := make([]Issue, 0)
	for _, issue := range issues {
		if issue.Code == code {
			result = append(result, issue)
		}
	}
	return result
}
