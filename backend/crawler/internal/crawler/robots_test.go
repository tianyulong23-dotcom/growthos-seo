package crawler

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"testing"
)

func TestLoadRobotsEnforcesDisallow(t *testing.T) {
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 200,
			Body:       []byte("User-agent: *\nDisallow: /private\nSitemap: https://example.com/sitemap.xml\n"),
		},
	}}
	root, _ := url.Parse("https://example.com/")
	policy, err := LoadRobots(context.Background(), fetcher, root, "SEOPlatformBot/1.0")
	if err != nil {
		t.Fatalf("LoadRobots() returned an error: %v", err)
	}
	privateURL, _ := url.Parse("https://example.com/private/report")
	publicURL, _ := url.Parse("https://example.com/products")
	if policy.Allows(privateURL) {
		t.Fatal("robots policy allowed a disallowed URL")
	}
	if !policy.Allows(publicURL) {
		t.Fatal("robots policy rejected a public URL")
	}
	if len(policy.Sitemaps) != 1 {
		t.Fatalf("sitemaps = %#v", policy.Sitemaps)
	}
}

func TestLoadRobotsAllowsWhenFetchFails(t *testing.T) {
	fetcher := &fakeFetcher{
		resources: map[string]Resource{
			"https://example.com/robots.txt": {},
		},
		errors: map[string]error{
			"https://example.com/robots.txt": errors.New("network unavailable"),
		},
	}
	root, _ := url.Parse("https://example.com/")

	policy, err := LoadRobots(context.Background(), fetcher, root, "SEOPlatformBot/1.0")
	if err != nil {
		t.Fatalf("LoadRobots() returned an error: %v", err)
	}
	pageURL, _ := url.Parse("https://example.com/private")
	if !policy.Allows(pageURL) {
		t.Fatal("network failure unexpectedly blocked crawling")
	}
}

func TestLoadRobotsDisallowsAllOnForbidden(t *testing.T) {
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			StatusCode: http.StatusForbidden,
		},
	}}
	root, _ := url.Parse("https://example.com/")

	policy, err := LoadRobots(context.Background(), fetcher, root, "SEOPlatformBot/1.0")
	if err != nil {
		t.Fatalf("LoadRobots() returned an error: %v", err)
	}
	pageURL, _ := url.Parse("https://example.com/")
	if policy.Allows(pageURL) {
		t.Fatal("403 robots response did not block crawling")
	}
}

func TestLoadRobotsAllowsAllOnServerError(t *testing.T) {
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			StatusCode: http.StatusInternalServerError,
		},
	}}
	root, _ := url.Parse("https://example.com/")

	policy, err := LoadRobots(context.Background(), fetcher, root, "SEOPlatformBot/1.0")
	if err != nil {
		t.Fatalf("LoadRobots() returned an error: %v", err)
	}
	pageURL, _ := url.Parse("https://example.com/private")
	if !policy.Allows(pageURL) {
		t.Fatal("500 robots response unexpectedly blocked crawling")
	}
}

func TestRobotsPolicyCacheUsesEachSubdomainRobots(t *testing.T) {
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://www.example.com/robots.txt": {
			StatusCode: 200,
			Body:       []byte("User-agent: *\nDisallow: /private\n"),
		},
		"https://shop.example.com/robots.txt": {
			StatusCode: 200,
			Body:       []byte("User-agent: *\nAllow: /\n"),
		},
	}}
	cache := NewRobotsPolicyCache(fetcher, "SEOPlatformBot/1.0")
	wwwPrivate, _ := url.Parse("https://www.example.com/private")
	shopPrivate, _ := url.Parse("https://shop.example.com/private")

	allowed, err := cache.Allows(context.Background(), wwwPrivate)
	if err != nil {
		t.Fatalf("www policy returned an error: %v", err)
	}
	if allowed {
		t.Fatal("www robots policy allowed /private")
	}
	allowed, err = cache.Allows(context.Background(), shopPrivate)
	if err != nil {
		t.Fatalf("shop policy returned an error: %v", err)
	}
	if !allowed {
		t.Fatal("shop robots policy rejected /private")
	}
}

func TestRobotsPolicyCacheLoadsOriginOnce(t *testing.T) {
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			StatusCode: 200,
			Body:       []byte("User-agent: *\nAllow: /\n"),
		},
	}}
	cache := NewRobotsPolicyCache(fetcher, "SEOPlatformBot/1.0")
	first, _ := url.Parse("https://example.com/one")
	second, _ := url.Parse("https://example.com/two")

	if _, err := cache.Allows(context.Background(), first); err != nil {
		t.Fatalf("first policy returned an error: %v", err)
	}
	if _, err := cache.Allows(context.Background(), second); err != nil {
		t.Fatalf("second policy returned an error: %v", err)
	}
	if fetcher.callCount("https://example.com/robots.txt") != 1 {
		t.Fatalf(
			"robots fetch count = %d, want 1",
			fetcher.callCount("https://example.com/robots.txt"),
		)
	}
}
