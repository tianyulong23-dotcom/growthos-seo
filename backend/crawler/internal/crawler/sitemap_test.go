package crawler

import (
	"context"
	"strings"
	"testing"
)

func TestDiscoverSitemapURLsResolvesRelativeNestedSitemap(t *testing.T) {
	scope, _, err := NewScope("https://example.com")
	if err != nil {
		t.Fatalf("NewScope() returned an error: %v", err)
	}
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 200,
			Body: []byte(`<?xml version="1.0"?>
				<sitemapindex><sitemap><loc>nested/pages.xml</loc></sitemap></sitemapindex>`),
		},
		"https://example.com/nested/pages.xml": {
			FinalURL:   "https://example.com/nested/pages.xml",
			StatusCode: 200,
			Body: []byte(`<?xml version="1.0"?>
				<urlset><url><loc>/products/widget</loc><priority>0.9</priority></url></urlset>`),
		},
	}}

	candidates, err := DiscoverSitemapURLs(
		context.Background(),
		fetcher,
		scope,
		[]string{"https://example.com/sitemap.xml"},
		10,
	)
	if err != nil {
		t.Fatalf("DiscoverSitemapURLs() returned an error: %v", err)
	}
	if len(candidates) != 1 || candidates[0].URL.String() != "https://example.com/products/widget" {
		t.Fatalf("candidates = %#v", candidates)
	}
}

func TestDiscoverSitemapURLsPrioritizesPreferredLocaleWithinDocumentBudget(
	t *testing.T,
) {
	scope, _, err := NewScope("https://example.com")
	if err != nil {
		t.Fatalf("NewScope() returned an error: %v", err)
	}
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/landing-index.xml": {
			FinalURL:   "https://example.com/landing-index.xml",
			StatusCode: 200,
			Body: []byte(`<?xml version="1.0"?>
				<sitemapindex>
					<sitemap><loc>landing-de-at.xml</loc></sitemap>
					<sitemap><loc>landing-en-us.xml</loc></sitemap>
				</sitemapindex>`),
		},
		"https://example.com/landing-de-at.xml": {
			FinalURL:   "https://example.com/landing-de-at.xml",
			StatusCode: 200,
			Body: []byte(`<?xml version="1.0"?>
				<urlset><url><loc>/at/mission</loc></url></urlset>`),
		},
		"https://example.com/landing-en-us.xml": {
			FinalURL:   "https://example.com/landing-en-us.xml",
			StatusCode: 200,
			Body: []byte(`<?xml version="1.0"?>
				<urlset><url><loc>/mission</loc></url></urlset>`),
		},
	}}

	candidates, err := discoverSitemapURLs(
		context.Background(),
		fetcher,
		scope,
		[]string{"https://example.com/landing-index.xml"},
		10,
		2,
		[]string{"en-US"},
	)
	if err != nil {
		t.Fatalf("discoverSitemapURLs() returned an error: %v", err)
	}
	if len(candidates) != 1 ||
		candidates[0].URL.String() != "https://example.com/mission" {
		t.Fatalf("candidates = %#v", candidates)
	}
	if fetcher.callCount("https://example.com/landing-de-at.xml") != 0 {
		t.Fatal("non-matching locale sitemap was fetched within the document budget")
	}
}

func TestSitemapPriorityDoesNotTreatSlugSuffixAsLocale(t *testing.T) {
	aboutPriority := sitemapPriority(
		"https://example.com/about-us/sitemap.xml",
		[]string{"us"},
	)
	neutralPriority := sitemapPriority(
		"https://example.com/company/sitemap.xml",
		[]string{"us"},
	)
	if aboutPriority != neutralPriority {
		t.Fatalf(
			"about-us priority = %d, neutral priority = %d",
			aboutPriority,
			neutralPriority,
		)
	}
}

func TestSitemapURLSetPrioritizesPreferredLocaleBeforeCandidateLimit(t *testing.T) {
	scope, _, err := NewScope("https://example.com")
	if err != nil {
		t.Fatalf("NewScope() returned an error: %v", err)
	}
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/sitemap.xml": {
			URL:         "https://example.com/sitemap.xml",
			FinalURL:    "https://example.com/sitemap.xml",
			StatusCode:  200,
			ContentType: "application/xml",
			Body: []byte(`<?xml version="1.0" encoding="UTF-8"?>
				<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
					<url><loc>https://example.com/en</loc></url>
					<url><loc>https://example.com/en/about</loc></url>
					<url><loc>https://example.com/en/products</loc></url>
					<url><loc>https://example.com/fr</loc></url>
					<url><loc>https://example.com/fr/about</loc></url>
					<url><loc>https://example.com/fr/products</loc></url>
				</urlset>`),
		},
	}}

	candidates, err := discoverSitemapURLs(
		context.Background(),
		fetcher,
		scope,
		[]string{"https://example.com/sitemap.xml"},
		3,
		1,
		[]string{"fr-FR", "fr"},
	)
	if err != nil {
		t.Fatalf("discoverSitemapURLs() returned an error: %v", err)
	}
	if len(candidates) != 3 {
		t.Fatalf("candidate count = %d, want 3", len(candidates))
	}
	for _, candidate := range candidates {
		if !strings.HasPrefix(candidate.URL.Path, "/fr") {
			t.Fatalf("selected non-French candidate: %s", candidate.URL)
		}
	}
}
