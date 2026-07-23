package crawler

import (
	"context"
	"testing"
)

func TestResolveSiteIconUsesManifestBeforeRootFavicon(t *testing.T) {
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/site.webmanifest": {
			URL:         "https://example.com/site.webmanifest",
			FinalURL:    "https://example.com/site.webmanifest",
			StatusCode:  200,
			ContentType: "application/manifest+json",
			Body: []byte(`{
				"icons": [
					{"src": "/icon-64.png", "sizes": "64x64"},
					{"src": "/icon-192.png", "sizes": "192x192"}
				]
			}`),
		},
		"https://example.com/icon-192.png": imageResource(
			"https://example.com/icon-192.png",
		),
	}}
	pages := []Page{{
		URL:         "https://example.com/",
		FinalURL:    "https://example.com/",
		ManifestURL: "https://example.com/site.webmanifest",
	}}

	icon := resolveSiteIcon(context.Background(), fetcher, pages)

	if icon.URL != "https://example.com/icon-192.png" {
		t.Fatalf("icon URL = %q", icon.URL)
	}
	if icon.ContentType != "image/png" || len(icon.Body) == 0 {
		t.Fatalf("icon resource = %#v", icon)
	}
	if fetcher.callCount("https://example.com/favicon.ico") != 0 {
		t.Fatal("root favicon was fetched after a valid manifest icon")
	}
}

func TestResolveSiteIconFallsBackToRootFavicon(t *testing.T) {
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/favicon.ico": imageResource(
			"https://example.com/favicon.ico",
		),
	}}
	pages := []Page{{
		URL:      "https://example.com/",
		FinalURL: "https://example.com/",
	}}

	icon := resolveSiteIcon(context.Background(), fetcher, pages)

	if icon.URL != "https://example.com/favicon.ico" {
		t.Fatalf("icon URL = %q", icon.URL)
	}
}

func TestResolveSiteIconFallsBackToOfficialLogo(t *testing.T) {
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/favicon.ico": {
			URL:         "https://example.com/favicon.ico",
			FinalURL:    "https://example.com/favicon.ico",
			StatusCode:  404,
			ContentType: "text/html",
		},
		"https://cdn.example.org/brand-mark.svg": {
			URL:         "https://cdn.example.org/brand-mark.svg",
			FinalURL:    "https://cdn.example.org/brand-mark.svg",
			StatusCode:  200,
			ContentType: "image/svg+xml",
			Body: []byte(
				`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"></svg>`,
			),
		},
	}}
	pages := []Page{{
		URL:      "https://example.com/",
		FinalURL: "https://example.com/",
		LogoURL:  "https://cdn.example.org/brand-mark.svg",
	}}

	icon := resolveSiteIcon(context.Background(), fetcher, pages)

	if icon.URL != "https://cdn.example.org/brand-mark.svg" {
		t.Fatalf("icon URL = %q", icon.URL)
	}
}

func TestResolveSiteIconRejectsHorizontalWordmarkLogo(t *testing.T) {
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/favicon.ico": {
			URL:         "https://example.com/favicon.ico",
			FinalURL:    "https://example.com/favicon.ico",
			StatusCode:  404,
			ContentType: "text/html",
		},
		"https://example.com/wordmark.svg": {
			URL:         "https://example.com/wordmark.svg",
			FinalURL:    "https://example.com/wordmark.svg",
			StatusCode:  200,
			ContentType: "image/svg+xml",
			Body: []byte(
				`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"></svg>`,
			),
		},
	}}
	pages := []Page{{
		URL:      "https://example.com/",
		FinalURL: "https://example.com/",
		LogoURL:  "https://example.com/wordmark.svg",
	}}

	if icon := resolveSiteIcon(context.Background(), fetcher, pages); icon.URL != "" {
		t.Fatalf("icon URL = %q", icon.URL)
	}
}

func TestResolveSiteIconRejectsNonImageResponses(t *testing.T) {
	fetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/favicon.ico": {
			URL:         "https://example.com/favicon.ico",
			FinalURL:    "https://example.com/favicon.ico",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte("<html>not an icon</html>"),
		},
	}}
	pages := []Page{{
		URL:      "https://example.com/",
		FinalURL: "https://example.com/",
	}}

	if icon := resolveSiteIcon(context.Background(), fetcher, pages); icon.URL != "" {
		t.Fatalf("icon URL = %q", icon.URL)
	}
}

func imageResource(rawURL string) Resource {
	return Resource{
		URL:         rawURL,
		FinalURL:    rawURL,
		StatusCode:  200,
		ContentType: "image/png",
		Body:        []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'},
	}
}
