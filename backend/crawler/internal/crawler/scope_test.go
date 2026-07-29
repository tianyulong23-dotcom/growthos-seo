package crawler

import (
	"context"
	"net"
	"net/url"
	"testing"
)

func TestScopeAllowsOnlyRootAndWWW(t *testing.T) {
	scope, _, err := NewScope("https://example.com")
	if err != nil {
		t.Fatalf("NewScope() returned an error: %v", err)
	}

	for _, rawURL := range []string{"https://example.com/a", "https://www.example.com/b"} {
		u, _ := url.Parse(rawURL)
		if !scope.Allows(u) {
			t.Fatalf("scope should allow %s", rawURL)
		}
	}

	for _, rawURL := range []string{"https://shop.example.com", "https://example.org"} {
		u, _ := url.Parse(rawURL)
		if scope.Allows(u) {
			t.Fatalf("scope should reject %s", rawURL)
		}
	}
}

func TestScopeAllowsOnlyExplicitAdditionalSubdomains(t *testing.T) {
	scope, _, err := NewScopeWithHosts("https://example.com", []string{"shop.example.com"})
	if err != nil {
		t.Fatalf("NewScopeWithHosts() returned an error: %v", err)
	}
	shop, _ := url.Parse("https://shop.example.com/products")
	api, _ := url.Parse("https://api.example.com/products")
	if !scope.Allows(shop) {
		t.Fatal("scope rejected an explicitly allowed subdomain")
	}
	if scope.Allows(api) {
		t.Fatal("scope accepted an unconfigured subdomain")
	}
}

func TestScopeRejectsAdditionalHostOutsideRootDomain(t *testing.T) {
	if _, _, err := NewScopeWithHosts(
		"https://example.com",
		[]string{"shop.example.org"},
	); err == nil {
		t.Fatal("NewScopeWithHosts() accepted a different root domain")
	}
}

func TestScopeNormalizeRemovesTrackingAndCleansPath(t *testing.T) {
	scope, _, err := NewScope("https://example.com")
	if err != nil {
		t.Fatalf("NewScope() returned an error: %v", err)
	}
	base, _ := url.Parse("https://example.com/products/")
	got, err := scope.Normalize("../about/?utm_source=test&gclid=123&keep=yes#team", base)
	if err != nil {
		t.Fatalf("Normalize() returned an error: %v", err)
	}
	if got.String() != "https://example.com/about?keep=yes" {
		t.Fatalf("Normalize() = %s", got)
	}
}

func TestScopeUsesConfiguredPathsAndIgnoredParameters(t *testing.T) {
	scope, root, err := NewScopeWithOptions(
		"https://example.com",
		nil,
		ScopeDirectory,
		"/blog/",
		[]string{"/blog/guides"},
		[]string{"/blog/guides/private"},
		[]string{"utm_*", "msclkid"},
	)
	if err != nil {
		t.Fatalf("NewScopeWithOptions() returned an error: %v", err)
	}
	if root.String() != "https://example.com/blog" {
		t.Fatalf("root URL = %s", root)
	}

	allowed, _ := url.Parse(
		"https://example.com/blog/guides/start?utm_source=test&msclkid=1&keep=yes",
	)
	normalized, err := scope.Normalize(allowed.String(), nil)
	if err != nil {
		t.Fatalf("Normalize() rejected an allowed path: %v", err)
	}
	if normalized.String() != "https://example.com/blog/guides/start?keep=yes" {
		t.Fatalf("Normalize() = %s", normalized)
	}

	for _, rawURL := range []string{
		"https://example.com/blog/news",
		"https://example.com/blog/guides/private",
	} {
		u, _ := url.Parse(rawURL)
		if scope.Allows(u) {
			t.Fatalf("scope accepted filtered path %s", rawURL)
		}
	}
}

func TestSubdomainScopeAllowsDiscoveredSubdomains(t *testing.T) {
	scope, _, err := NewScopeWithOptions(
		"https://example.com",
		nil,
		ScopeSubdomains,
		"",
		nil,
		nil,
		nil,
	)
	if err != nil {
		t.Fatalf("NewScopeWithOptions() returned an error: %v", err)
	}
	shop, _ := url.Parse("https://shop.example.com/products")
	if !scope.Allows(shop) {
		t.Fatal("subdomain scope rejected a subdomain")
	}
}

func TestDomainScopeSupportsAProjectSubdomain(t *testing.T) {
	scope, _, err := NewScope("https://docs.example.com")
	if err != nil {
		t.Fatalf("NewScope() returned an error: %v", err)
	}
	docs, _ := url.Parse("https://docs.example.com/start")
	shop, _ := url.Parse("https://shop.example.com/products")
	if !scope.Allows(docs) {
		t.Fatal("scope rejected the configured project subdomain")
	}
	if scope.Allows(shop) {
		t.Fatal("scope accepted a sibling subdomain")
	}
}

func TestValidatePublicURLRejectsPrivateAddresses(t *testing.T) {
	for _, rawURL := range []string{
		"http://127.0.0.1",
		"http://10.0.0.1",
		"http://169.254.169.254",
		"http://[::1]",
	} {
		u, _ := url.Parse(rawURL)
		if err := ValidatePublicURL(context.Background(), net.DefaultResolver, u); err == nil {
			t.Fatalf("ValidatePublicURL() accepted %s", rawURL)
		}
	}
}

func TestContextScopeRejectsCrossDomainNavigation(t *testing.T) {
	scope, _, err := NewScope("https://example.com")
	if err != nil {
		t.Fatalf("NewScope() returned an error: %v", err)
	}
	ctx := withScope(context.Background(), scope)
	allowed, _ := url.Parse("https://www.example.com/products")
	blocked, _ := url.Parse("https://example.org/products")

	if err := validateContextScope(ctx, allowed); err != nil {
		t.Fatalf("validateContextScope() rejected an allowed URL: %v", err)
	}
	if err := validateContextScope(ctx, blocked); err == nil {
		t.Fatal("validateContextScope() accepted a cross-domain URL")
	}
}

func TestBrowserFetcherRejectsPrivateTargetBeforeLaunching(t *testing.T) {
	fetcher := NewBrowserFetcher(Config{BrowserEnabled: true})
	if _, err := fetcher.Fetch(context.Background(), "http://127.0.0.1"); err == nil {
		t.Fatal("BrowserFetcher.Fetch() accepted a loopback target")
	}
}
