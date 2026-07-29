package crawler

import (
	"strings"
	"testing"
	"time"
)

func TestParserExtractsPageSignals(t *testing.T) {
	html := `<!doctype html>
<html lang="en">
<head>
  <title>Example Product</title>
  <meta name="description" content="A useful product">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="index,follow">
  <meta name="author" content="Example Author">
  <meta name="keywords" content="example, product">
  <meta name="generator" content="Example CMS">
  <meta name="theme-color" content="#ffffff">
  <meta property="og:title" content="OG Product">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="canonical" href="/product">
  <link rel="icon" type="image/png" href="/favicon-32.png">
  <link rel="alternate" hreflang="en-US" href="/en/product">
  <script type="application/ld+json">{"@type":"Product","name":"Example"}</script>
</head>
<body>
  <header><nav><a href="/pricing">Pricing</a></nav></header>
  <main>
    <h1>Example Product</h1>
    <h2>Features</h2>
    <h3>Fast setup</h3>
    <p>` + strings.Repeat("Useful content. ", 60) + `</p>
    <a href="https://external.example.org/reference">Reference</a>
    <img src="/images/product.png" alt="Product screenshot" title="Product" width="640" height="480" loading="lazy">
    <div itemscope itemtype="https://schema.org/Product">
      <span itemprop="name">Example Product</span>
      <meta itemprop="sku" content="SKU-1">
    </div>
  </main>
</body>
</html>`
	resource := Resource{
		URL:            "https://example.com/product?ref=source",
		FinalURL:       "https://example.com/product",
		StatusCode:     200,
		ContentType:    "text/html",
		Body:           []byte(html),
		ResponseTimeMS: 125,
		SizeBytes:      4096,
		Redirects: []Redirect{
			{URL: "https://example.com/product?ref=source", StatusCode: 301},
		},
		Error:     "partial response",
		ErrorType: "http_error",
		FetchedAt: time.Now().UTC(),
	}

	page, err := (Parser{}).Parse(resource, 1, "https://example.com/")
	if err != nil {
		t.Fatalf("Parse() returned an error: %v", err)
	}
	if page.Title != "Example Product" || page.Description != "A useful product" {
		t.Fatalf("unexpected metadata: title=%q description=%q", page.Title, page.Description)
	}
	if page.Canonical != "/product" {
		t.Fatalf("canonical = %q", page.Canonical)
	}
	if page.FaviconURL != "https://example.com/favicon-32.png" {
		t.Fatalf("favicon URL = %q", page.FaviconURL)
	}
	if len(page.H1) != 1 || page.H1[0] != "Example Product" {
		t.Fatalf("H1 = %#v", page.H1)
	}
	if len(page.H2) != 1 || page.H2[0] != "Features" {
		t.Fatalf("H2 = %#v", page.H2)
	}
	if len(page.H3) != 1 || page.H3[0] != "Fast setup" {
		t.Fatalf("H3 = %#v", page.H3)
	}
	if page.MetaTags["description"] != "A useful product" ||
		page.Viewport != "width=device-width, initial-scale=1" ||
		page.Robots != "index,follow" ||
		page.Author != "Example Author" ||
		page.Keywords != "example, product" ||
		page.Generator != "Example CMS" ||
		page.ThemeColor != "#ffffff" {
		t.Fatalf("meta fields = %#v", page)
	}
	if page.TwitterTags["card"] != "summary_large_image" {
		t.Fatalf("twitter tags = %#v", page.TwitterTags)
	}
	if len(page.StructuredData) != 1 {
		t.Fatalf("structured data count = %d", len(page.StructuredData))
	}
	if len(page.Links) != 3 ||
		!page.Links[0].InNavigation ||
		page.Links[2].Placement != "image" ||
		page.Links[2].URL != "https://example.com/images/product.png" {
		t.Fatalf("links = %#v", page.Links)
	}
	if page.InternalLinkCount != 1 || page.ExternalLinkCount != 1 {
		t.Fatalf(
			"link counts = internal:%d external:%d",
			page.InternalLinkCount,
			page.ExternalLinkCount,
		)
	}
	if len(page.Images) != 1 ||
		page.Images[0].Src != "https://example.com/images/product.png" ||
		page.Images[0].Alt != "Product screenshot" ||
		page.Images[0].Width != "640" ||
		page.Images[0].Loading != "lazy" {
		t.Fatalf("images = %#v", page.Images)
	}
	if len(page.Hreflang) != 1 ||
		page.Hreflang[0].Language != "en-US" ||
		page.Hreflang[0].URL != "https://example.com/en/product" {
		t.Fatalf("hreflang = %#v", page.Hreflang)
	}
	if len(page.SchemaMicrodata) != 1 ||
		page.SchemaMicrodata[0].Type != "https://schema.org/Product" ||
		page.SchemaMicrodata[0].Properties["name"] != "Example Product" ||
		page.SchemaMicrodata[0].Properties["sku"] != "SKU-1" {
		t.Fatalf("schema microdata = %#v", page.SchemaMicrodata)
	}
	if page.MainText == "" {
		t.Fatal("main text was not extracted")
	}
	if page.WordCount == 0 {
		t.Fatal("word count was not calculated")
	}
	if page.ResponseTimeMS != 125 ||
		page.SizeBytes != 4096 ||
		len(page.Redirects) != 1 ||
		page.Error != "partial response" ||
		page.ErrorType != "http_error" {
		t.Fatalf("transport fields = %#v", page)
	}
}

func TestParserExtractsManifestAndOfficialLogoHints(t *testing.T) {
	html := `<!doctype html>
<html>
<head>
  <link rel="manifest" href="/site.webmanifest">
  <script type="application/ld+json">{
    "@context": "https://schema.org",
    "@type": "Organization",
    "name": "Example",
    "logo": {
      "@type": "ImageObject",
      "contentUrl": "/assets/brand-mark.png"
    }
  }</script>
</head>
<body></body>
</html>`

	page, err := (Parser{}).Parse(
		Resource{
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(html),
		},
		0,
		"",
	)
	if err != nil {
		t.Fatalf("Parse() returned an error: %v", err)
	}
	if page.ManifestURL != "https://example.com/site.webmanifest" {
		t.Fatalf("manifest URL = %q", page.ManifestURL)
	}
	if page.LogoURL != "https://example.com/assets/brand-mark.png" {
		t.Fatalf("logo URL = %q", page.LogoURL)
	}
}

func TestParserSeparatesTextAcrossNestedHeadingElements(t *testing.T) {
	page, err := (Parser{}).Parse(
		Resource{
			URL:         "https://example.com",
			FinalURL:    "https://example.com",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html><body><h1><span>Modern product</span>` +
					`<span>development system</span></h1></body></html>`,
			),
		},
		0,
		"",
	)
	if err != nil {
		t.Fatalf("Parse() returned an error: %v", err)
	}
	if len(page.H1) != 1 ||
		page.H1[0] != "Modern product development system" {
		t.Fatalf("H1 = %#v", page.H1)
	}
}
