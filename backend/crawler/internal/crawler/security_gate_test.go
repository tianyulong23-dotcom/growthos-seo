package crawler

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type fixedResolver struct {
	addresses []net.IPAddr
	err       error
}

func (r fixedResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return r.addresses, r.err
}

type sequenceResolver struct {
	responses [][]net.IPAddr
	index     int
}

func (r *sequenceResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	if r.index >= len(r.responses) {
		return nil, errors.New("unexpected resolver call")
	}
	response := r.responses[r.index]
	r.index++
	return response, nil
}

func TestSafeFetchGoldSetRejectsAmbiguousURLs(t *testing.T) {
	publicResolver := fixedResolver{addresses: []net.IPAddr{{IP: net.ParseIP("1.1.1.1")}}}
	tests := []string{
		"ftp://1.1.1.1/file",
		"http://user:secret@1.1.1.1/",
		"http://1.1.1.1:8080/",
		"http://2130706433/",
		"http://0177.0.0.1/",
		"http://0x7f000001/",
	}
	for _, rawURL := range tests {
		t.Run(rawURL, func(t *testing.T) {
			target, err := url.Parse(rawURL)
			if err != nil {
				t.Fatalf("url.Parse() returned an error: %v", err)
			}
			if err := ValidatePublicURL(context.Background(), publicResolver, target); err == nil {
				t.Fatalf("ValidatePublicURL() accepted %s", rawURL)
			}
		})
	}
}

func TestSafeFetchGoldSetRejectsPrivateIPv4AndIPv6(t *testing.T) {
	for _, rawIP := range []string{
		"127.0.0.1",
		"10.0.0.1",
		"169.254.169.254",
		"::1",
		"fc00::1",
		"fe80::1",
	} {
		t.Run(rawIP, func(t *testing.T) {
			target := &url.URL{Scheme: "https", Host: rawIP}
			if net.ParseIP(rawIP).To4() == nil {
				target.Host = "[" + rawIP + "]"
			}
			resolver := fixedResolver{addresses: []net.IPAddr{{IP: net.ParseIP(rawIP)}}}
			if err := ValidatePublicURL(context.Background(), resolver, target); err == nil {
				t.Fatalf("ValidatePublicURL() accepted %s", rawIP)
			}
		})
	}
}

func TestSafeDialerRejectsDNSRebinding(t *testing.T) {
	resolver := &sequenceResolver{responses: [][]net.IPAddr{
		{{IP: net.ParseIP("1.1.1.1")}},
		{{IP: net.ParseIP("127.0.0.1")}},
	}}
	fetcher := &HTTPFetcher{
		config:   Config{RequestTimeout: time.Second},
		resolver: resolver,
	}
	target, _ := url.Parse("https://example.com/")
	if err := ValidatePublicURL(context.Background(), resolver, target); err != nil {
		t.Fatalf("initial validation failed: %v", err)
	}

	if _, err := fetcher.safeDialer("")(context.Background(), "tcp", "example.com:443"); err == nil {
		t.Fatal("safeDialer() accepted a private rebound address")
	}
}

func TestCrawlerRejectsUnsupportedContentType(t *testing.T) {
	if isAllowedCrawlContentType("application/octet-stream") {
		t.Fatal("application/octet-stream was accepted")
	}
	for _, contentType := range []string{
		"text/html; charset=utf-8",
		"text/plain",
		"application/xml",
		"application/json",
		"image/png",
	} {
		if !isAllowedCrawlContentType(contentType) {
			t.Fatalf("%s was rejected", contentType)
		}
	}
}

func TestHTTPFetcherRejectsOversizedResponseBody(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		response.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = response.Write([]byte(strings.Repeat("x", 256)))
	}))
	defer proxy.Close()

	fetcher, err := NewHTTPFetcher(Config{
		UserAgent:       "GrowthOSCrawler/1.0",
		RequestTimeout:  time.Second,
		MaxBodyBytes:    64,
		MaxRetries:      1,
		PrimaryProxyURL: proxy.URL,
	})
	if err != nil {
		t.Fatalf("NewHTTPFetcher() returned an error: %v", err)
	}

	resource, err := fetcher.Fetch(context.Background(), "http://1.1.1.1/large")
	if err == nil || !strings.Contains(err.Error(), "response body exceeds 64 bytes") {
		t.Fatalf("Fetch() error = %v", err)
	}
	if len(resource.Body) != 64 {
		t.Fatalf("retained body size = %d, want 64", len(resource.Body))
	}
}

func TestRequestLimiterHonorsCancellation(t *testing.T) {
	limiter := NewRequestLimiter(time.Hour, 0)
	if err := limiter.Wait(context.Background()); err != nil {
		t.Fatalf("first Wait() returned an error: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	startedAt := time.Now()
	if err := limiter.Wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("second Wait() error = %v", err)
	}
	if time.Since(startedAt) > 100*time.Millisecond {
		t.Fatal("cancelled limiter wait did not return promptly")
	}
}
