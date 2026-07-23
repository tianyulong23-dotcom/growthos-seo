package crawler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
)

func TestSelectPagesForPageSpeedUsesHomepageAndTwoTopLevelPages(t *testing.T) {
	pages := []Page{
		{FinalURL: "https://example.com/deep/page", StatusCode: 200},
		{FinalURL: "https://example.com/", StatusCode: 200},
		{FinalURL: "https://example.com/products", StatusCode: 200},
		{FinalURL: "https://example.com/about", StatusCode: 200},
		{FinalURL: "https://example.com/contact", StatusCode: 200},
		{FinalURL: "https://example.com/missing", StatusCode: 404},
	}

	selected := selectPagesForPageSpeed(pages)
	want := []string{
		"https://example.com/",
		"https://example.com/products",
		"https://example.com/about",
	}
	if len(selected) != len(want) {
		t.Fatalf("selected pages = %#v", selected)
	}
	for index := range want {
		if selected[index] != want[index] {
			t.Fatalf("selected pages = %#v, want %#v", selected, want)
		}
	}
}

func TestGooglePageSpeedAnalyzerRunsMobileAndDesktop(t *testing.T) {
	var mutex sync.Mutex
	strategies := make([]string, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		strategies = append(strategies, request.URL.Query().Get("strategy"))
		mutex.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{
			"lighthouseResult": {
				"categories": {
					"performance": {"score": 0.91},
					"accessibility": {"score": 0.88},
					"best-practices": {"score": 0.84},
					"seo": {"score": 0.97}
				},
				"audits": {
					"first-contentful-paint": {"numericValue": 1234},
					"largest-contentful-paint": {"numericValue": 2456},
					"cumulative-layout-shift": {"numericValue": 0.1234}
				}
			}
		}`))
	}))
	defer server.Close()

	analyzer := NewGooglePageSpeedAnalyzer(Config{PageSpeedAPIURL: server.URL})
	results := analyzer.Analyze(context.Background(), []Page{
		{FinalURL: "https://example.com/", StatusCode: 200},
	})

	if len(results) != 2 {
		t.Fatalf("result count = %d", len(results))
	}
	if *results[0].PerformanceScore != 91 || *results[0].SEOScore != 97 {
		t.Fatalf("scores = %#v", results[0])
	}
	if results[0].Metrics["first_contentful_paint"] != 1.23 {
		t.Fatalf("metrics = %#v", results[0].Metrics)
	}
	mutex.Lock()
	defer mutex.Unlock()
	if len(strategies) != 2 || strategies[0] != "mobile" || strategies[1] != "desktop" {
		t.Fatalf("strategies = %#v", strategies)
	}
}

func TestCandidateCheckpointRoundTrip(t *testing.T) {
	original := Candidate{
		URL:             mustURL(t, "https://example.com/products"),
		Depth:           1,
		DiscoveredFrom:  "https://example.com/",
		InNavigation:    true,
		FromSitemap:     true,
		SitemapPriority: 0.8,
		LocalePriority:  95,
		Score:           123,
	}
	restored, err := candidateFromState(candidateState(original))
	if err != nil {
		t.Fatalf("candidateFromState() returned an error: %v", err)
	}
	if restored.URL.String() != original.URL.String() ||
		restored.Depth != original.Depth ||
		restored.LocalePriority != original.LocalePriority ||
		restored.Score != original.Score {
		t.Fatalf("restored candidate = %#v", restored)
	}
}

func mustURL(t *testing.T, value string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
