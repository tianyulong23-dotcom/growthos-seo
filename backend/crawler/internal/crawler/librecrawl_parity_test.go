package crawler

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

type concurrentFetcher struct {
	delay    time.Duration
	resource Resource
	active   atomic.Int32
	peak     atomic.Int32
}

func (f *concurrentFetcher) Fetch(ctx context.Context, rawURL string) (Resource, error) {
	current := f.active.Add(1)
	defer f.active.Add(-1)
	for {
		previous := f.peak.Load()
		if current <= previous || f.peak.CompareAndSwap(previous, current) {
			break
		}
	}
	timer := time.NewTimer(f.delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return Resource{URL: rawURL, FinalURL: rawURL}, ctx.Err()
	case <-timer.C:
	}
	resource := f.resource
	resource.URL = rawURL
	resource.FinalURL = rawURL
	return resource, nil
}

func TestRequestLimiterSpacesRequestsAndHonorsCancellation(t *testing.T) {
	limiter := NewRequestLimiter(40*time.Millisecond, 0)
	if err := limiter.Wait(context.Background()); err != nil {
		t.Fatalf("first Wait() returned an error: %v", err)
	}
	startedAt := time.Now()
	if err := limiter.Wait(context.Background()); err != nil {
		t.Fatalf("second Wait() returned an error: %v", err)
	}
	if elapsed := time.Since(startedAt); elapsed < 30*time.Millisecond {
		t.Fatalf("request interval = %s, want at least 30ms", elapsed)
	}

	cancelLimiter := NewRequestLimiter(time.Second, 0)
	if err := cancelLimiter.Wait(context.Background()); err != nil {
		t.Fatalf("initial cancellation Wait() returned an error: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	if err := cancelLimiter.Wait(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cancelled Wait() error = %v", err)
	}
}

func TestHybridFetcherLimitsHTTPAndBrowserConcurrency(t *testing.T) {
	httpFetcher := &concurrentFetcher{
		delay: 50 * time.Millisecond,
		resource: Resource{
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><body><div id="root"></div><script src="/app.js"></script></body></html>`),
		},
	}
	browserFetcher := &concurrentFetcher{
		delay: 50 * time.Millisecond,
		resource: Resource{
			StatusCode:  200,
			ContentType: "text/html",
			Rendered:    true,
		},
	}
	fetcher := HybridFetcher{
		HTTP:               httpFetcher,
		Browser:            browserFetcher,
		HTTPConcurrency:    5,
		BrowserConcurrency: 3,
	}
	urls := make([]string, 6)
	for index := range urls {
		urls[index] = fmt.Sprintf("https://example.com/page-%d", index)
	}

	outcomes := fetcher.FetchMany(context.Background(), urls)
	for index, outcome := range outcomes {
		if outcome.Err != nil {
			t.Fatalf("outcome %d error = %v", index, outcome.Err)
		}
		if !outcome.Resource.Rendered {
			t.Fatalf("outcome %d was not rendered", index)
		}
	}
	if httpFetcher.peak.Load() != 5 {
		t.Fatalf("HTTP peak concurrency = %d, want 5", httpFetcher.peak.Load())
	}
	if browserFetcher.peak.Load() != 3 {
		t.Fatalf("browser peak concurrency = %d, want 3", browserFetcher.peak.Load())
	}
}

func TestHTTPFetcherRecordsRedirectChain(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		switch request.URL.Path {
		case "/start":
			response.Header().Set("Location", "http://1.1.1.1/middle")
			response.WriteHeader(http.StatusMovedPermanently)
		case "/middle":
			response.Header().Set("Location", "http://1.1.1.1/final")
			response.WriteHeader(http.StatusFound)
		case "/final":
			response.Header().Set("Content-Type", "text/html")
			_, _ = response.Write([]byte("<html><body>done</body></html>"))
		default:
			http.NotFound(response, request)
		}
	}))
	defer proxy.Close()

	fetcher, err := NewHTTPFetcher(Config{
		RequestTimeout:  time.Second,
		MaxBodyBytes:    1024,
		MaxRetries:      1,
		PrimaryProxyURL: proxy.URL,
	})
	if err != nil {
		t.Fatalf("NewHTTPFetcher() returned an error: %v", err)
	}
	resource, err := fetcher.Fetch(context.Background(), "http://1.1.1.1/start")
	if err != nil {
		t.Fatalf("Fetch() returned an error: %v", err)
	}
	if len(resource.Redirects) != 2 {
		t.Fatalf("redirects = %#v", resource.Redirects)
	}
	if resource.Redirects[0].FromURL != "http://1.1.1.1/start" ||
		resource.Redirects[0].URL != "http://1.1.1.1/middle" ||
		resource.Redirects[0].StatusCode != http.StatusMovedPermanently {
		t.Fatalf("first redirect = %#v", resource.Redirects[0])
	}
	if resource.Redirects[1].FromURL != "http://1.1.1.1/middle" ||
		resource.Redirects[1].URL != "http://1.1.1.1/final" ||
		resource.Redirects[1].StatusCode != http.StatusFound {
		t.Fatalf("second redirect = %#v", resource.Redirects[1])
	}
}

func TestHTTPFetcherRecordsRedirectBeforeSSRFRejection(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		response.Header().Set("Location", "http://127.0.0.1/private")
		response.WriteHeader(http.StatusFound)
	}))
	defer proxy.Close()

	fetcher, err := NewHTTPFetcher(Config{
		RequestTimeout:  time.Second,
		MaxBodyBytes:    1024,
		MaxRetries:      1,
		PrimaryProxyURL: proxy.URL,
	})
	if err != nil {
		t.Fatalf("NewHTTPFetcher() returned an error: %v", err)
	}
	resource, err := fetcher.Fetch(context.Background(), "http://1.1.1.1/start")
	if err == nil {
		t.Fatal("Fetch() allowed a redirect to a loopback address")
	}
	if len(resource.Redirects) != 1 {
		t.Fatalf("redirects = %#v", resource.Redirects)
	}
	redirect := resource.Redirects[0]
	if redirect.FromURL != "http://1.1.1.1/start" ||
		redirect.URL != "http://127.0.0.1/private" ||
		redirect.StatusCode != http.StatusFound {
		t.Fatalf("redirect = %#v", redirect)
	}
}

func TestTechnicalAuditBatchesWithoutExceedingMaxPages(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := auditDiscoveryFetcher()
	pageFetcher := &fakeBatchFetcher{fakeFetcher: &fakeFetcher{
		resources: map[string]Resource{
			"https://example.com/": htmlResource(
				"https://example.com/",
				`<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>`,
				now,
			),
			"https://example.com/a": htmlResource("https://example.com/a", "", now),
			"https://example.com/b": htmlResource("https://example.com/b", "", now),
			"https://example.com/c": htmlResource("https://example.com/c", "", now),
		},
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 20},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), technicalAuditTask("batch", 3))
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 3 {
		t.Fatalf("page count = %d, want 3", len(result.Pages))
	}
	if len(pageFetcher.batches) != 1 || len(pageFetcher.batches[0]) != 2 {
		t.Fatalf("batches = %#v", pageFetcher.batches)
	}
	if pageFetcher.callCount("https://example.com/c") != 0 {
		t.Fatal("batch exceeded MaxPages")
	}
}

func TestTechnicalAuditReportsLinkCheckingBeforeCompletion(t *testing.T) {
	now := time.Now().UTC()
	const externalURL = "https://external.example/resource"
	discoveryFetcher := auditDiscoveryFetcher()
	discoveryFetcher.resources[externalURL] = Resource{
		URL:         externalURL,
		FinalURL:    externalURL,
		StatusCode:  http.StatusNoContent,
		ContentType: "text/plain",
		FetchedAt:   now,
	}
	httpFetcher := &fakeStatusFetcher{
		fakeFetcher: discoveryFetcher,
	}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": htmlResource(
			"https://example.com/",
			`<a href="`+externalURL+`">External</a>`,
			now,
		),
	}}
	stages := make([]ProgressStage, 0, 8)
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 20},
		httpFetcher,
		pageFetcher,
		ProgressReporterFunc(func(progress Progress) {
			stages = append(stages, progress.Stage)
		}),
	)

	_, err := engine.Run(context.Background(), technicalAuditTask("progress-order", 1))
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}

	checkingIndex := -1
	completedIndex := -1
	for index, stage := range stages {
		if stage == StageCheckingLinks {
			checkingIndex = index
		}
		if stage == StageCompleted {
			completedIndex = index
		}
	}
	if checkingIndex == -1 {
		t.Fatalf("stages = %#v, missing %q", stages, StageCheckingLinks)
	}
	if completedIndex != len(stages)-1 {
		t.Fatalf("stages = %#v, completed stage was not last", stages)
	}
	if checkingIndex >= completedIndex {
		t.Fatalf("stages = %#v, link checking did not precede completion", stages)
	}
	if httpFetcher.statusCallCount(externalURL) != 0 {
		t.Fatal("external resource unexpectedly used the status-only request")
	}
	if httpFetcher.fakeFetcher.callCount(externalURL) != 1 {
		t.Fatal("external resource was not fetched exactly once")
	}
}

func TestTechnicalAuditUsesBreadthFirstOrderAndKeepsResultOrder(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := auditDiscoveryFetcher()
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": htmlResource(
			"https://example.com/",
			`<a href="/about">About</a><a href="/zzz">Z</a>`,
			now,
		),
		"https://example.com/about": htmlResource(
			"https://example.com/about",
			`<a href="/products/deep">Product</a>`,
			now,
		),
		"https://example.com/zzz": htmlResource("https://example.com/zzz", "", now),
		"https://example.com/products/deep": htmlResource(
			"https://example.com/products/deep",
			"",
			now,
		),
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 20},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), technicalAuditTask("bfs", 4))
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	want := []string{
		"https://example.com/",
		"https://example.com/about",
		"https://example.com/zzz",
		"https://example.com/products/deep",
	}
	for index, rawURL := range want {
		if result.Pages[index].URL != rawURL {
			t.Fatalf("page %d = %q, want %q", index, result.Pages[index].URL, rawURL)
		}
	}
}

func TestTechnicalAuditStopsAtDepthThreeAndSkipsFiles(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := auditDiscoveryFetcher()
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": htmlResource(
			"https://example.com/",
			`<a href="/d1">D1</a><a href="/guide.pdf">PDF</a><a href="/hero.jpg">Image</a>`,
			now,
		),
		"https://example.com/d1": htmlResource(
			"https://example.com/d1",
			`<a href="/d2">D2</a>`,
			now,
		),
		"https://example.com/d2": htmlResource(
			"https://example.com/d2",
			`<a href="/d3">D3</a>`,
			now,
		),
		"https://example.com/d3": htmlResource(
			"https://example.com/d3",
			`<a href="/d4">D4</a>`,
			now,
		),
		"https://example.com/d4":        htmlResource("https://example.com/d4", "", now),
		"https://example.com/guide.pdf": {URL: "https://example.com/guide.pdf"},
		"https://example.com/hero.jpg":  {URL: "https://example.com/hero.jpg"},
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 20},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), technicalAuditTask("depth-files", 10))
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 4 || result.Pages[3].Depth != 3 {
		t.Fatalf("pages = %#v", result.Pages)
	}
	for _, rawURL := range []string{
		"https://example.com/d4",
		"https://example.com/guide.pdf",
		"https://example.com/hero.jpg",
	} {
		if pageFetcher.callCount(rawURL) != 0 {
			t.Fatalf("excluded URL was fetched: %s", rawURL)
		}
	}
}

func TestTechnicalAuditSkipsDisallowedHomepageButContinuesFromSitemap(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			URL:        "https://example.com/robots.txt",
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 200,
			Body:       []byte("User-agent: *\nDisallow: /\nAllow: /public\n"),
		},
		"https://example.com/sitemap.xml": {
			URL:         "https://example.com/sitemap.xml",
			FinalURL:    "https://example.com/sitemap.xml",
			StatusCode:  200,
			ContentType: "application/xml",
			Body: []byte(
				`<urlset><url><loc>https://example.com/public</loc></url></urlset>`,
			),
		},
	}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/":       htmlResource("https://example.com/", "", now),
		"https://example.com/public": htmlResource("https://example.com/public", "", now),
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 20},
		httpFetcher,
		pageFetcher,
		nil,
	)
	task := technicalAuditTask("robots-homepage", 1)

	result, err := engine.Run(context.Background(), task)
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 1 || result.Pages[0].URL != "https://example.com/public" {
		t.Fatalf("pages = %#v", result.Pages)
	}
	if pageFetcher.callCount("https://example.com/") != 0 {
		t.Fatal("robots-disallowed homepage was fetched")
	}
}

func TestDefaultSitemapURLsIncludesLibreCrawlLocations(t *testing.T) {
	root, err := parsedURL("https://example.com/path")
	if err != nil {
		t.Fatalf("parsedURL() returned an error: %v", err)
	}
	values := defaultSitemapURLs(root, []string{"https://cdn.example.com/custom.xml"})
	want := []string{
		"https://cdn.example.com/custom.xml",
		"https://example.com/sitemap.xml",
		"https://example.com/sitemap_index.xml",
		"https://example.com/sitemaps.xml",
		"https://example.com/sitemap/sitemap.xml",
	}
	if len(values) != len(want) {
		t.Fatalf("sitemaps = %#v", values)
	}
	for index := range want {
		if values[index] != want[index] {
			t.Fatalf("sitemap %d = %q, want %q", index, values[index], want[index])
		}
	}
}

func TestSitemapRecursionStopsAtDepthTen(t *testing.T) {
	scope, _, err := NewScope("https://example.com")
	if err != nil {
		t.Fatalf("NewScope() returned an error: %v", err)
	}
	resources := make(map[string]Resource)
	for depth := 1; depth <= 10; depth++ {
		current := fmt.Sprintf("https://example.com/sitemap-%d.xml", depth)
		next := fmt.Sprintf("https://example.com/sitemap-%d.xml", depth+1)
		resources[current] = Resource{
			URL:         current,
			FinalURL:    current,
			StatusCode:  200,
			ContentType: "application/xml",
			Body: []byte(fmt.Sprintf(
				`<sitemapindex><sitemap><loc>%s</loc></sitemap></sitemapindex>`,
				next,
			)),
		}
	}
	resources["https://example.com/sitemap-11.xml"] = Resource{
		URL:         "https://example.com/sitemap-11.xml",
		FinalURL:    "https://example.com/sitemap-11.xml",
		StatusCode:  200,
		ContentType: "application/xml",
		Body: []byte(
			`<urlset><url><loc>https://example.com/too-deep</loc></url></urlset>`,
		),
	}
	fetcher := &fakeFetcher{resources: resources}

	candidates, err := DiscoverSitemapURLs(
		context.Background(),
		fetcher,
		scope,
		[]string{"https://example.com/sitemap-1.xml"},
		100,
	)
	if err != nil {
		t.Fatalf("DiscoverSitemapURLs() returned an error: %v", err)
	}
	if len(candidates) != 0 {
		t.Fatalf("candidates = %#v", candidates)
	}
	if fetcher.callCount("https://example.com/sitemap-11.xml") != 0 {
		t.Fatal("sitemap recursion exceeded depth 10")
	}
}

func auditDiscoveryFetcher() *fakeFetcher {
	return &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			URL:        "https://example.com/robots.txt",
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: http.StatusNotFound,
		},
	}}
}

func htmlResource(rawURL, links string, fetchedAt time.Time) Resource {
	return Resource{
		URL:         rawURL,
		FinalURL:    rawURL,
		StatusCode:  http.StatusOK,
		ContentType: "text/html",
		Body: []byte(
			`<html><head><title>Page ` + rawURL + `</title></head><body>` +
				links + `<h1>Page</h1></body></html>`,
		),
		FetchedAt: fetchedAt,
	}
}

func technicalAuditTask(runID string, maxPages int) Task {
	return Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          runID,
		Type:           TaskTechnicalAudit,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       maxPages,
	}
}
