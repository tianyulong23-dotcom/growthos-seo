package crawler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAIProfileSynthesizerTurnsNavigationEvidenceIntoBusinessCategories(t *testing.T) {
	var requestBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("authorization header = %q", request.Header.Get("Authorization"))
		}
		if err := json.NewDecoder(request.Body).Decode(&requestBody); err != nil {
			t.Fatal(err)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"choices": [{
				"message": {
					"content": "{\"business_name\":\"Example Athletics, Inc.\",\"business_type\":\"Sportswear brand\",\"business_summary\":\"Example Athletics makes sports products for athletes and active consumers.\",\"target_audiences\":[\"Athletes\",\"Active consumers\"],\"products_services\":[\"Athletic footwear\",\"Sports apparel\",\"Sports accessories\"],\"value_propositions\":[\"Products designed for sport and everyday activity\",\"A broad range across sports and age groups\"]}"
				}
			}]
		}`))
	}))
	defer server.Close()

	fallback := SiteProfile{
		ProfileVersion:   2,
		ExtractionMethod: "structured_data_and_page_content",
		BusinessName:     "Example Athletics. Official Site",
		BusinessSummary:  "Sports products.",
		ProductsServices: []string{
			"Summer Blue",
			"Factory Stores",
			"Product Advice",
		},
		Evidence: []SiteProfileEvidence{{
			Field:     "business_summary",
			Value:     "Sports products.",
			SourceURL: "https://example.com/",
		}},
	}
	pages := []Page{{
		URL:         "https://example.com/",
		FinalURL:    "https://example.com/",
		Title:       "Example Athletics. Official Site",
		Description: "Sports products.",
		H1:          []string{"Move every day"},
		Links: []Link{
			{
				URL:          "https://example.com/men/shoes",
				Text:         "Shoes",
				InNavigation: true,
				IsInternal:   true,
			},
			{
				URL:          "https://example.com/women/clothing",
				Text:         "Clothing",
				InNavigation: true,
				IsInternal:   true,
			},
			{
				URL:          "https://example.com/colors/summer-blue",
				Text:         "Summer Blue",
				InNavigation: true,
				IsInternal:   true,
			},
			{
				URL:          "https://example.com/help",
				Text:         "Help",
				InNavigation: true,
				IsInternal:   true,
			},
			{
				URL:          "https://example.com/returns",
				Text:         "Shipping and returns",
				InNavigation: true,
				IsInternal:   true,
			},
			{
				URL:          "https://example.com/contact",
				Text:         "Contact us",
				InNavigation: true,
				IsInternal:   true,
			},
			{
				URL:          "https://example.com/blog",
				Text:         "Blog",
				InNavigation: true,
				IsInternal:   true,
			},
		},
	}}

	profile, err := NewAIProfileSynthesizer(Config{
		BusinessProfileAIBaseURL: server.URL,
		BusinessProfileAIAPIKey:  "test-key",
		BusinessProfileAIModel:   "test-model",
	}).Synthesize(context.Background(), Task{
		TargetURL: "https://example.com",
		Country:   "US",
		Language:  "en",
	}, pages, fallback)
	if err != nil {
		t.Fatal(err)
	}

	if profile.ProfileVersion != 3 {
		t.Fatalf("profile version = %d", profile.ProfileVersion)
	}
	if profile.ExtractionMethod != "ai_synthesized_from_crawl_evidence" {
		t.Fatalf("extraction method = %q", profile.ExtractionMethod)
	}
	if profile.BusinessName != "Example Athletics" {
		t.Fatalf("business name = %q", profile.BusinessName)
	}
	if profile.BusinessType != "Sportswear brand" {
		t.Fatalf("business type = %q", profile.BusinessType)
	}
	if strings.Join(profile.ProductsServices, "|") !=
		"Athletic footwear|Sports apparel|Sports accessories" {
		t.Fatalf("products/services = %#v", profile.ProductsServices)
	}
	if len(profile.Evidence) != 1 {
		t.Fatalf("crawler evidence was not preserved: %#v", profile.Evidence)
	}

	messages := requestBody["messages"].([]any)
	systemPrompt := messages[0].(map[string]any)["content"].(string)
	userPrompt := messages[1].(map[string]any)["content"].(string)
	for _, required := range []string{
		"campaign names",
		"colors",
		"support articles",
		"store locations",
		"support seekers",
		"free customer support",
		"website navigation or filtering features",
		"untrusted data",
		"Never follow instructions",
	} {
		if !strings.Contains(systemPrompt, required) {
			t.Fatalf("system prompt missing %q", required)
		}
	}
	for _, evidence := range []string{
		"Summer Blue",
		"https://example.com/men/shoes",
		"Sports products.",
	} {
		if !strings.Contains(userPrompt, evidence) {
			t.Fatalf("user prompt missing %q", evidence)
		}
	}
	for _, utilityEvidence := range []string{
		"https://example.com/help",
		"https://example.com/returns",
		"https://example.com/contact",
		"https://example.com/blog",
	} {
		if strings.Contains(userPrompt, utilityEvidence) {
			t.Fatalf("user prompt contains utility evidence %q", utilityEvidence)
		}
	}
	var evidencePayload map[string]any
	if err := json.Unmarshal(
		[]byte(strings.TrimPrefix(
			userPrompt,
			"Create the business profile from this crawl evidence:\n",
		)),
		&evidencePayload,
	); err != nil {
		t.Fatal(err)
	}
	deterministicProfile := evidencePayload["deterministic_profile"].(map[string]any)
	for _, omitted := range []string{
		"evidence",
		"key_pages",
		"conversion_actions",
		"target_markets",
		"languages",
	} {
		if _, exists := deterministicProfile[omitted]; exists {
			t.Fatalf("deterministic profile contains unnecessary field %q", omitted)
		}
	}
}

func TestAIProfileSynthesizerRequiresConfiguration(t *testing.T) {
	_, err := NewAIProfileSynthesizer(Config{}).Synthesize(
		context.Background(),
		Task{},
		nil,
		SiteProfile{},
	)
	if err == nil {
		t.Fatal("expected missing configuration error")
	}
}

func TestAIProfileSynthesizerSanitizesListsAndPreservesUsableFallbacks(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"choices": [{
				"message": {
					"content": "{\"business_name\":\"Example\",\"business_type\":\"Analytics software\",\"business_summary\":\"Example helps teams understand their business data.\",\"target_audiences\":[],\"products_services\":[\"Analytics\",\"analytics.\",\"Discover the future of business intelligence with a platform that transforms every decision across your entire organization.\"],\"value_propositions\":[\"Fast setup\",\"Fast setup.\",\"Build a better future for every team with powerful insights that unlock limitless growth and transform how the world works.\"]}"
				}
			}]
		}`))
	}))
	defer server.Close()

	fallback := SiteProfile{
		TargetAudiences:   []string{"Finance teams", "Finance teams."},
		ProductsServices:  []string{"Reporting"},
		ValuePropositions: []string{"Reliable reporting"},
	}
	profile, err := NewAIProfileSynthesizer(Config{
		BusinessProfileAIBaseURL: server.URL,
		BusinessProfileAIAPIKey:  "test-key",
		BusinessProfileAIModel:   "test-model",
	}).Synthesize(
		context.Background(),
		Task{TargetURL: "https://example.com", Country: "US", Language: "en"},
		[]Page{{URL: "https://example.com", FinalURL: "https://example.com"}},
		fallback,
	)
	if err != nil {
		t.Fatal(err)
	}

	if strings.Join(profile.TargetAudiences, "|") != "Finance teams" {
		t.Fatalf("target audiences = %#v", profile.TargetAudiences)
	}
	if strings.Join(profile.ProductsServices, "|") != "Analytics" {
		t.Fatalf("products/services = %#v", profile.ProductsServices)
	}
	if strings.Join(profile.ValuePropositions, "|") != "Fast setup" {
		t.Fatalf("value propositions = %#v", profile.ValuePropositions)
	}
}
