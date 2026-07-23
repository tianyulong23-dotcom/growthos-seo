package crawler

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gocolly/colly/v2"
)

type proxyCapturingFetcher struct {
	proxyURL string
	resource Resource
}

func (f *proxyCapturingFetcher) Fetch(ctx context.Context, _ string) (Resource, error) {
	f.proxyURL, _ = preferredProxyFromContext(ctx)
	return f.resource, nil
}

func TestHybridFetcherUsesHTTPForNormalHTML(t *testing.T) {
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com": {
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte("<html><body>" + string(make([]byte, 400)) + "</body></html>"),
		},
	}}
	browserFetcher := &fakeFetcher{resources: map[string]Resource{}}
	fetcher := HybridFetcher{HTTP: httpFetcher, Browser: browserFetcher}

	if _, err := fetcher.Fetch(context.Background(), "https://example.com"); err != nil {
		t.Fatalf("Fetch() returned an error: %v", err)
	}
	if browserFetcher.callCount("https://example.com") != 0 {
		t.Fatal("normal HTML unexpectedly used the browser")
	}
}

func TestHybridFetcherPassesSuccessfulHTTPProxyToBrowser(t *testing.T) {
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com": {
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><body><div id="root"></div><script src="/app.js"></script></body></html>`),
			ProxyURL:    "http://fallback-proxy:3128",
		},
	}}
	browserFetcher := &proxyCapturingFetcher{
		resource: Resource{StatusCode: 200, Rendered: true},
	}

	if _, err := (HybridFetcher{HTTP: httpFetcher, Browser: browserFetcher}).
		Fetch(context.Background(), "https://example.com"); err != nil {
		t.Fatalf("Fetch() returned an error: %v", err)
	}
	if browserFetcher.proxyURL != "http://fallback-proxy:3128" {
		t.Fatalf("browser proxy = %q", browserFetcher.proxyURL)
	}
}

func TestHybridFetcherUpgradesJavaScriptShell(t *testing.T) {
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com": {
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><body><div id="root"></div><script src="/app.js"></script></body></html>`),
		},
	}}
	browserFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com": {
			StatusCode:  200,
			ContentType: "text/html",
			Rendered:    true,
		},
	}}
	fetcher := HybridFetcher{HTTP: httpFetcher, Browser: browserFetcher}

	resource, err := fetcher.Fetch(context.Background(), "https://example.com")
	if err != nil {
		t.Fatalf("Fetch() returned an error: %v", err)
	}
	if !resource.Rendered || browserFetcher.callCount("https://example.com") != 1 {
		t.Fatal("JavaScript shell was not upgraded to the browser")
	}
}

func TestHybridFetcherKeepsRenderedStatusCode(t *testing.T) {
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com": {
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><body><div id="root"></div><script src="/app.js"></script></body></html>`),
		},
	}}
	browserFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com": {
			StatusCode:  http.StatusNotFound,
			ContentType: "text/html",
			Rendered:    true,
		},
	}}

	resource, err := (HybridFetcher{HTTP: httpFetcher, Browser: browserFetcher}).
		Fetch(context.Background(), "https://example.com")
	if err != nil {
		t.Fatalf("Fetch() returned an error: %v", err)
	}
	if resource.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", resource.StatusCode, http.StatusNotFound)
	}
}

func TestHybridFetcherFallsBackWhenRenderedStatusIsUnknown(t *testing.T) {
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com": {
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><body><div id="root"></div><script src="/app.js"></script></body></html>`),
		},
	}}
	browserFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com": {
			StatusCode:  0,
			ContentType: "text/html",
			Rendered:    true,
		},
	}}

	resource, err := (HybridFetcher{HTTP: httpFetcher, Browser: browserFetcher}).
		Fetch(context.Background(), "https://example.com")
	if err != nil {
		t.Fatalf("Fetch() returned an error: %v", err)
	}
	if resource.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", resource.StatusCode, http.StatusOK)
	}
}

func TestHybridFetcherUpgradesBlockedResponse(t *testing.T) {
	httpFetcher := &fakeFetcher{
		resources: map[string]Resource{
			"https://example.com": {StatusCode: http.StatusForbidden},
		},
		errors: map[string]error{
			"https://example.com": errors.New("forbidden"),
		},
	}
	browserFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com": {StatusCode: 200, Rendered: true},
	}}

	resource, err := (HybridFetcher{HTTP: httpFetcher, Browser: browserFetcher}).
		Fetch(context.Background(), "https://example.com")
	if err != nil {
		t.Fatalf("Fetch() returned an error: %v", err)
	}
	if !resource.Rendered {
		t.Fatal("403 response was not upgraded to the browser")
	}
}

func TestHybridFetcherCanDisableBrowser(t *testing.T) {
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com": {
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><body><div id="root"></div></body></html>`),
		},
	}}
	browserFetcher := &fakeFetcher{resources: map[string]Resource{}}

	if _, err := (HybridFetcher{
		HTTP:    httpFetcher,
		Browser: browserFetcher,
		Mode:    RenderingOff,
	}).Fetch(context.Background(), "https://example.com"); err != nil {
		t.Fatalf("Fetch() returned an error: %v", err)
	}
	if browserFetcher.callCount("https://example.com") != 0 {
		t.Fatal("disabled rendering unexpectedly used the browser")
	}
}

func TestHybridFetcherCanRenderAllHTML(t *testing.T) {
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com": {
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte("<html><body>complete server HTML</body></html>"),
		},
	}}
	browserFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com": {
			StatusCode:  200,
			ContentType: "text/html",
			Rendered:    true,
		},
	}}

	resource, err := (HybridFetcher{
		HTTP:    httpFetcher,
		Browser: browserFetcher,
		Mode:    RenderingAll,
	}).Fetch(context.Background(), "https://example.com")
	if err != nil {
		t.Fatalf("Fetch() returned an error: %v", err)
	}
	if !resource.Rendered || browserFetcher.callCount("https://example.com") != 1 {
		t.Fatal("render-all mode did not use the browser")
	}
}

func TestResourceFromCollyHandlesPartialErrorResponse(t *testing.T) {
	resource := resourceFromColly("https://example.com/robots.txt", &colly.Response{})

	if resource.URL != "https://example.com/robots.txt" {
		t.Fatalf("resource URL = %q", resource.URL)
	}
	if resource.FinalURL != "https://example.com/robots.txt" {
		t.Fatalf("resource final URL = %q", resource.FinalURL)
	}
	if resource.StatusCode != 0 {
		t.Fatalf("resource status = %d", resource.StatusCode)
	}
}

func TestHTTPClientIgnoresAmbientProxyWithoutCrawlerProxy(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:8080")
	fetcher, err := NewHTTPFetcher(Config{})
	if err != nil {
		t.Fatalf("NewHTTPFetcher() returned an error: %v", err)
	}

	client, err := fetcher.client(context.Background(), "", true)
	if err != nil {
		t.Fatalf("client() returned an error: %v", err)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("client transport type = %T", client.Transport)
	}
	if transport.Proxy != nil {
		t.Fatal("client inherited an ambient proxy without crawler proxy configuration")
	}
}

func TestStatusClientAllowsPublicRedirectOutsideCrawlScope(t *testing.T) {
	fetcher, err := NewHTTPFetcher(Config{})
	if err != nil {
		t.Fatalf("NewHTTPFetcher() returned an error: %v", err)
	}
	scope, _, err := NewScope("https://example.com")
	if err != nil {
		t.Fatalf("NewScope() returned an error: %v", err)
	}
	ctx := withScope(context.Background(), scope)
	client, err := fetcher.client(ctx, "", false)
	if err != nil {
		t.Fatalf("client() returned an error: %v", err)
	}
	request, err := http.NewRequest(http.MethodGet, "https://1.1.1.1/", nil)
	if err != nil {
		t.Fatalf("NewRequest() returned an error: %v", err)
	}

	if err := client.CheckRedirect(request, nil); err != nil {
		t.Fatalf("status redirect outside crawl scope was rejected: %v", err)
	}
}

func TestFetchClientRejectsRedirectOutsideCrawlScope(t *testing.T) {
	fetcher, err := NewHTTPFetcher(Config{})
	if err != nil {
		t.Fatalf("NewHTTPFetcher() returned an error: %v", err)
	}
	scope, _, err := NewScope("https://example.com")
	if err != nil {
		t.Fatalf("NewScope() returned an error: %v", err)
	}
	ctx := withScope(context.Background(), scope)
	client, err := fetcher.client(ctx, "", true)
	if err != nil {
		t.Fatalf("client() returned an error: %v", err)
	}
	request, err := http.NewRequest(http.MethodGet, "https://1.1.1.1/", nil)
	if err != nil {
		t.Fatalf("NewRequest() returned an error: %v", err)
	}
	request = request.WithContext(ctx)

	if err := client.CheckRedirect(request, nil); err == nil {
		t.Fatal("fetch redirect outside crawl scope was allowed")
	}
}

func TestStatusClientRejectsPrivateRedirect(t *testing.T) {
	fetcher, err := NewHTTPFetcher(Config{})
	if err != nil {
		t.Fatalf("NewHTTPFetcher() returned an error: %v", err)
	}
	client, err := fetcher.client(context.Background(), "", false)
	if err != nil {
		t.Fatalf("client() returned an error: %v", err)
	}
	request, err := http.NewRequest(http.MethodGet, "http://127.0.0.1/", nil)
	if err != nil {
		t.Fatalf("NewRequest() returned an error: %v", err)
	}

	if err := client.CheckRedirect(request, nil); err == nil {
		t.Fatal("status redirect to private address was allowed")
	}
}

func TestHTTPFetcherRequestUsesCallerContext(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(
		_ http.ResponseWriter,
		request *http.Request,
	) {
		<-request.Context().Done()
	}))
	defer proxy.Close()

	fetcher, err := NewHTTPFetcher(Config{
		UserAgent:       "SEOPlatformBot/1.0",
		RequestTimeout:  2 * time.Second,
		MaxBodyBytes:    1024,
		MaxRetries:      1,
		PrimaryProxyURL: proxy.URL,
	})
	if err != nil {
		t.Fatalf("NewHTTPFetcher() returned an error: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 75*time.Millisecond)
	defer cancel()

	startedAt := time.Now()
	_, err = fetcher.Fetch(ctx, "http://1.1.1.1/context")
	elapsed := time.Since(startedAt)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Fetch() error = %v, want context deadline exceeded", err)
	}
	if elapsed >= 500*time.Millisecond {
		t.Fatalf("Fetch() ignored caller cancellation for %s", elapsed)
	}
}

func TestHTTPFetcherReusesClientForSameProxyAndScope(t *testing.T) {
	fetcher, err := NewHTTPFetcher(Config{RequestTimeout: time.Second})
	if err != nil {
		t.Fatalf("NewHTTPFetcher() returned an error: %v", err)
	}

	first, err := fetcher.client(context.Background(), "", true)
	if err != nil {
		t.Fatalf("first client() returned an error: %v", err)
	}
	second, err := fetcher.client(context.Background(), "", true)
	if err != nil {
		t.Fatalf("second client() returned an error: %v", err)
	}
	if first != second {
		t.Fatal("client() created a new connection pool for the same request mode")
	}
}

func TestHTTPFetcherFetchManyRunsFiveRequestsConcurrently(t *testing.T) {
	var active atomic.Int32
	var peak atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		current := active.Add(1)
		defer active.Add(-1)
		for {
			previous := peak.Load()
			if current <= previous || peak.CompareAndSwap(previous, current) {
				break
			}
		}
		time.Sleep(100 * time.Millisecond)
		response.Header().Set("Content-Type", "text/html")
		_, _ = response.Write([]byte("<html><body>ok</body></html>"))
	}))
	defer proxy.Close()

	fetcher, err := NewHTTPFetcher(Config{
		UserAgent:       "SEOPlatformBot/1.0",
		RequestTimeout:  2 * time.Second,
		MaxBodyBytes:    1024,
		MaxRetries:      1,
		PrimaryProxyURL: proxy.URL,
	})
	if err != nil {
		t.Fatalf("NewHTTPFetcher() returned an error: %v", err)
	}
	batchFetcher, ok := any(fetcher).(BatchFetcher)
	if !ok {
		t.Fatal("HTTPFetcher does not implement BatchFetcher")
	}

	outcomes := batchFetcher.FetchMany(context.Background(), []string{
		"http://1.1.1.1/1",
		"http://1.1.1.1/2",
		"http://1.1.1.1/3",
		"http://1.1.1.1/4",
		"http://1.1.1.1/5",
	})
	for index, outcome := range outcomes {
		if outcome.Err != nil {
			t.Fatalf("outcome %d error = %v", index, outcome.Err)
		}
	}
	if peak.Load() != 5 {
		t.Fatalf("peak concurrency = %d, want 5", peak.Load())
	}
}
