package crawler

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestSiteProfileReadyRequiresEveryEditableBusinessField(t *testing.T) {
	complete := SiteProfile{
		BusinessName:      "Example",
		BusinessType:      "Software / SaaS",
		BusinessSummary:   "Example helps teams plan work.",
		TargetAudiences:   []string{"Product teams"},
		ProductsServices:  []string{"Planning software"},
		ValuePropositions: []string{"Fast collaborative planning"},
	}
	if !SiteProfileReady(complete) {
		t.Fatal("complete profile was not ready")
	}

	incomplete := complete
	incomplete.TargetAudiences = nil
	if SiteProfileReady(incomplete) {
		t.Fatal("profile without a target audience was ready")
	}
}

func TestBuildSiteProfileUsesRepresentativePagesAndEvidence(t *testing.T) {
	task := Task{
		TargetURL: "https://example.com",
		Country:   "US",
		Language:  "en",
	}
	pages := []Page{
		{
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			Title:       "Acme Cloud | Operations Platform",
			Description: "Acme Cloud helps operations teams automate recurring work.",
			FaviconURL:  "https://example.com/favicon.png",
			H1:          []string{"Operations automation for growing teams"},
			OpenGraph:   map[string]string{"site_name": "Acme Cloud, Inc."},
			ContentExcerpt: "Acme Cloud is a platform for operations teams. " +
				"Built for growing teams that need reliable recurring workflows.",
			StructuredData: []json.RawMessage{json.RawMessage(`{
				"@context": "https://schema.org",
				"@type": "Organization",
				"name": "Acme Cloud, Inc.",
				"description": "Acme Cloud helps operations teams automate recurring work.",
				"audience": {
					"@type": "BusinessAudience",
					"audienceType": "Operations teams"
				}
			}`)},
		},
		{
			URL:         "https://example.com/products/workflows",
			FinalURL:    "https://example.com/products/workflows",
			Title:       "Workflow Automation",
			Description: "Automate approvals and handoffs.",
			H1:          []string{"Workflow Automation"},
			H2:          []string{"Automate approval workflows"},
			StructuredData: []json.RawMessage{json.RawMessage(`{
				"@context": "https://schema.org",
				"@type": "SoftwareApplication",
				"name": "Workflow Automation"
			}`)},
		},
	}

	profile := BuildSiteProfile(task, pages)

	if profile.BusinessName != "Acme Cloud" {
		t.Fatalf("business name = %q", profile.BusinessName)
	}
	if profile.BusinessSummary != pages[0].Description {
		t.Fatalf("business summary = %q", profile.BusinessSummary)
	}
	if profile.FaviconURL != "https://example.com/favicon.png" {
		t.Fatalf("favicon URL = %q", profile.FaviconURL)
	}
	if len(profile.ProductsServices) != 1 ||
		profile.ProductsServices[0] != "Workflow Automation" {
		t.Fatalf("products/services = %#v", profile.ProductsServices)
	}
	if len(profile.TargetAudiences) == 0 ||
		profile.TargetAudiences[0] != "Operations teams" {
		t.Fatalf("target audiences = %#v", profile.TargetAudiences)
	}
	if len(profile.ValuePropositions) == 0 {
		t.Fatal("value propositions were not identified")
	}
	if !slices.Contains(profile.UseCases, "Automate approval workflows") {
		t.Fatalf("use cases = %#v", profile.UseCases)
	}
	if profile.ExtractionMethod != "structured_data_and_page_content" {
		t.Fatalf("extraction method = %q", profile.ExtractionMethod)
	}
	foundSource := false
	for _, evidence := range profile.Evidence {
		if evidence.Field == "key_pages" &&
			evidence.SourceURL == "https://example.com/products/workflows" {
			foundSource = true
			break
		}
	}
	if !foundSource {
		t.Fatalf("key page evidence missing source URL: %#v", profile.Evidence)
	}
}

func TestBuildSiteProfileUsesGenericStructuredDataAcrossBusinessTypes(t *testing.T) {
	tests := []struct {
		name         string
		schemaType   string
		offeringName string
		wantType     string
	}{
		{
			name:         "commerce product",
			schemaType:   "Product",
			offeringName: "Trail Backpack",
			wantType:     "E-commerce",
		},
		{
			name:         "professional service",
			schemaType:   "Service",
			offeringName: "Tax Advisory",
			wantType:     "Services",
		},
		{
			name:         "software application",
			schemaType:   "SoftwareApplication",
			offeringName: "Planning Workspace",
			wantType:     "Software / SaaS",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw, err := json.Marshal(map[string]any{
				"@context": "https://schema.org",
				"@type":    test.schemaType,
				"name":     test.offeringName,
			})
			if err != nil {
				t.Fatal(err)
			}
			profile := BuildSiteProfile(
				Task{
					TargetURL: "https://example.com",
					Country:   "US",
					Language:  "en",
				},
				[]Page{
					{
						URL:         "https://example.com/",
						FinalURL:    "https://example.com/",
						Title:       "Example Business",
						Description: "A representative business website.",
					},
					{
						URL:            "https://example.com/offerings/main",
						FinalURL:       "https://example.com/offerings/main",
						StructuredData: []json.RawMessage{raw},
					},
				},
			)

			if profile.BusinessType != test.wantType {
				t.Fatalf("business type = %q, want %q", profile.BusinessType, test.wantType)
			}
			if len(profile.ProductsServices) == 0 ||
				profile.ProductsServices[0] != test.offeringName {
				t.Fatalf("products/services = %#v", profile.ProductsServices)
			}
		})
	}
}

func TestAudienceExtractionRequiresAnAudienceSignal(t *testing.T) {
	profile := BuildSiteProfile(
		Task{
			TargetURL: "https://example.com",
			Country:   "US",
			Language:  "en",
		},
		[]Page{{
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			Title:       "Example",
			Description: "Purpose-built for planning and building products.",
			H1:          []string{"A product development system for teams and agents"},
		}},
	)

	if len(profile.TargetAudiences) != 1 ||
		profile.TargetAudiences[0] != "teams and agents" {
		t.Fatalf("target audiences = %#v", profile.TargetAudiences)
	}
}

func TestSiteProfileOnlyUsesObservedMarketsAndLanguages(t *testing.T) {
	profile := BuildSiteProfile(
		Task{
			TargetURL: "https://example.com",
			Country:   "US",
			Language:  "en",
		},
		[]Page{{
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			Title:       "Example",
			Description: "Example business.",
		}},
	)

	if len(profile.TargetMarkets) != 0 {
		t.Fatalf("target markets = %#v, want no inferred project market", profile.TargetMarkets)
	}
	if len(profile.Languages) != 0 {
		t.Fatalf("languages = %#v, want no inferred project language", profile.Languages)
	}
}

func TestSiteProfileExtractsMarketsAndLanguagesFromEvidence(t *testing.T) {
	profile := BuildSiteProfile(
		Task{TargetURL: "https://example.com"},
		[]Page{{
			URL:      "https://example.com/",
			FinalURL: "https://example.com/",
			Language: "en",
			Hreflang: []HreflangLink{
				{Language: "fr-CA", URL: "https://example.com/ca-fr"},
			},
			StructuredData: []json.RawMessage{json.RawMessage(`{
				"@context": "https://schema.org",
				"@type": "Organization",
				"name": "Example",
				"areaServed": "United States",
				"address": {
					"@type": "PostalAddress",
					"addressCountry": "GB"
				}
			}`)},
		}},
	)

	for _, want := range []string{"United States", "GB", "CA"} {
		if !slices.Contains(profile.TargetMarkets, want) {
			t.Fatalf("target markets = %#v, missing %q", profile.TargetMarkets, want)
		}
	}
	for _, want := range []string{"en", "fr-CA"} {
		if !slices.Contains(profile.Languages, want) {
			t.Fatalf("languages = %#v, missing %q", profile.Languages, want)
		}
	}
}

func TestSiteProfileDoesNotInventBusinessSummary(t *testing.T) {
	profile := BuildSiteProfile(
		Task{TargetURL: "https://example.com"},
		[]Page{{
			URL:      "https://example.com/",
			FinalURL: "https://example.com/",
		}},
	)

	if profile.BusinessSummary != "" {
		t.Fatalf("business summary = %q, want empty without evidence", profile.BusinessSummary)
	}
}
