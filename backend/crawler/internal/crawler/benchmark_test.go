package crawler

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

var benchmarkPageCounts = []int{100, 500, 1_000, 5_000}

const syntheticAuditRootURL = "https://example.com/"

func BenchmarkTechnicalAuditPipeline(b *testing.B) {
	for _, pageCount := range benchmarkPageCounts {
		b.Run(fmt.Sprintf("pages_%d", pageCount), func(b *testing.B) {
			httpFetcher, pageFetcher := syntheticAuditFetchers(pageCount)
			task := syntheticAuditTask(pageCount)
			config := Config{
				UserAgent:       "SEOPlatformBot/1.0",
				DiscoveryLimit:  pageCount,
				HTTPConcurrency: 16,
				MaxRetries:      1,
			}

			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				engine := NewEngine(config, httpFetcher, pageFetcher, nil)
				result, err := engine.Run(context.Background(), task)
				if err != nil {
					b.Fatalf("Run() returned an error: %v", err)
				}
				if len(result.Pages) != pageCount {
					b.Fatalf("page count = %d, want %d", len(result.Pages), pageCount)
				}
			}
			b.StopTimer()
			elapsed := b.Elapsed()
			b.ReportMetric(float64(pageCount*b.N)/elapsed.Seconds(), "pages/s")
		})
	}
}

func BenchmarkResultEncodingAndStorage(b *testing.B) {
	for _, pageCount := range benchmarkPageCounts {
		b.Run(fmt.Sprintf("pages_%d", pageCount), func(b *testing.B) {
			result := syntheticAuditResult(pageCount)
			task := syntheticAuditTask(pageCount)

			b.ReportAllocs()
			b.ResetTimer()
			for range b.N {
				store := newProductionStore(&fakeCrawlRepository{}, &fakeObjectStore{})
				if _, err := store.SaveResult(context.Background(), task, result); err != nil {
					b.Fatalf("SaveResult() returned an error: %v", err)
				}
			}
			b.StopTimer()
			elapsed := b.Elapsed()
			b.ReportMetric(float64(pageCount*b.N)/elapsed.Seconds(), "pages/s")
		})
	}
}

func syntheticAuditTask(pageCount int) Task {
	return Task{
		OrganizationID: "benchmark-org",
		ProjectID:      "benchmark-project",
		RunID:          "benchmark-run",
		Type:           TaskTechnicalAudit,
		TargetURL:      syntheticAuditRootURL,
		Country:        "US",
		Language:       "en",
		MaxPages:       pageCount,
		Rendering:      RenderingOff,
	}
}

func syntheticAuditFetchers(pageCount int) (*fakeStatusFetcher, *fakeBatchFetcher) {
	now := time.Now().UTC()
	pageResources := make(map[string]Resource, pageCount)
	rootLinks := make([]string, 0, pageCount-1)
	for index := 1; index < pageCount; index++ {
		rootLinks = append(
			rootLinks,
			fmt.Sprintf(`<a href="/page-%d">Page %d</a>`, index, index),
		)
	}
	pageResources[syntheticAuditRootURL] = syntheticPageResource(
		syntheticAuditRootURL,
		0,
		strings.Join(rootLinks, ""),
		now,
	)
	for index := 1; index < pageCount; index++ {
		rawURL := fmt.Sprintf("%spage-%d", syntheticAuditRootURL, index)
		pageResources[rawURL] = syntheticPageResource(
			rawURL,
			index,
			`<a href="/">Home</a>`,
			now,
		)
	}

	httpResources := map[string]Resource{
		syntheticAuditRootURL + "robots.txt": {
			URL:         syntheticAuditRootURL + "robots.txt",
			FinalURL:    syntheticAuditRootURL + "robots.txt",
			StatusCode:  404,
			ContentType: "text/plain",
			FetchedAt:   now,
		},
		syntheticAuditRootURL + "sitemap.xml": {
			URL:         syntheticAuditRootURL + "sitemap.xml",
			FinalURL:    syntheticAuditRootURL + "sitemap.xml",
			StatusCode:  404,
			ContentType: "application/xml",
			FetchedAt:   now,
		},
	}
	httpFetcher := &fakeStatusFetcher{
		fakeFetcher: &fakeFetcher{resources: httpResources},
		statuses:    make(map[string]int, pageCount),
	}
	for rawURL := range pageResources {
		httpFetcher.statuses[rawURL] = 200
	}
	pageFetcher := &fakeBatchFetcher{
		fakeFetcher: &fakeFetcher{resources: pageResources},
	}
	return httpFetcher, pageFetcher
}

func syntheticPageResource(
	rawURL string,
	index int,
	links string,
	fetchedAt time.Time,
) Resource {
	title := fmt.Sprintf("Synthetic audit page %d with a unique useful title", index)
	description := fmt.Sprintf(
		"Synthetic description for page %d with enough detail to satisfy the audit thresholds and remain unique.",
		index,
	)
	body := fmt.Sprintf(
		`<!doctype html><html lang="en"><head><title>%s</title>`+
			`<meta name="description" content="%s">`+
			`<meta name="viewport" content="width=device-width, initial-scale=1">`+
			`<link rel="canonical" href="%s">`+
			`<meta property="og:title" content="%s">`+
			`<meta name="twitter:card" content="summary">`+
			`<script type="application/ld+json">{"@type":"WebPage"}</script>`+
			`</head><body><h1>Unique heading for page %d</h1><main>%s</main>%s</body></html>`,
		title,
		description,
		rawURL,
		title,
		index,
		strings.Repeat(fmt.Sprintf("content-%d ", index), 300),
		links,
	)
	return Resource{
		URL:         rawURL,
		FinalURL:    rawURL,
		StatusCode:  200,
		ContentType: "text/html; charset=utf-8",
		Body:        []byte(body),
		FetchedAt:   fetchedAt,
	}
}

func syntheticAuditResult(pageCount int) Result {
	pages := make([]Page, pageCount)
	now := time.Now().UTC()
	for index := range pages {
		rawURL := fmt.Sprintf("%spage-%d", syntheticAuditRootURL, index)
		pages[index] = Page{
			URL:            rawURL,
			FinalURL:       rawURL,
			StatusCode:     200,
			ContentType:    "text/html; charset=utf-8",
			Title:          fmt.Sprintf("Synthetic audit page %d", index),
			Description:    fmt.Sprintf("Synthetic description for page %d", index),
			Canonical:      rawURL,
			Language:       "en",
			H1:             []string{fmt.Sprintf("Synthetic heading %d", index)},
			MainText:       strings.Repeat(fmt.Sprintf("content-%d ", index), 300),
			WordCount:      300,
			FetchedAt:      now,
			ResponseTimeMS: 10,
		}
	}
	return Result{
		TaskType:         TaskTechnicalAudit,
		RunID:            "benchmark-run",
		CompletionStatus: CompletionComplete,
		Pages:            pages,
		StartedAt:        now,
		FinishedAt:       now,
	}
}
