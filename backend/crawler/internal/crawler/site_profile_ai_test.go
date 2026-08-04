package crawler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
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
		writeAIProfileResponse(t, response, aiProfileOutput{
			BusinessName:      "Example Athletics, Inc.",
			BusinessType:      "Sportswear brand",
			BusinessSummary:   "Example Athletics makes sports products for athletes and active consumers.",
			TargetAudiences:   []string{"Athletes", "Active consumers"},
			ProductsServices:  []string{"Athletic footwear", "Sports apparel", "Sports accessories"},
			ValuePropositions: []string{"Products designed for sport and everyday activity", "A broad range across sports and age groups"},
			Evidence: []aiProfileEvidence{
				{Field: "business_name", Value: "Example Athletics, Inc.", PageID: "page_001", Quote: "Example Athletics. Official Site"},
				{Field: "business_type", Value: "Sportswear brand", PageID: "page_001", Quote: "Shoes"},
				{Field: "business_summary", Value: "Example Athletics makes sports products for athletes and active consumers.", PageID: "page_001", Quote: "Sports products."},
				{Field: "target_audiences", Value: "Athletes", PageID: "page_001", Quote: "Sports products."},
				{Field: "target_audiences", Value: "Active consumers", PageID: "page_001", Quote: "Move every day"},
				{Field: "products_services", Value: "Athletic footwear", PageID: "page_001", Quote: "Shoes"},
				{Field: "products_services", Value: "Sports apparel", PageID: "page_001", Quote: "Clothing"},
				{Field: "products_services", Value: "Sports accessories", PageID: "page_001", Quote: "Sports products."},
				{Field: "value_propositions", Value: "Products designed for sport and everyday activity", PageID: "page_001", Quote: "Move every day"},
				{Field: "value_propositions", Value: "A broad range across sports and age groups", PageID: "page_001", Quote: "Sports products."},
			},
		})
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

	if profile.ProfileVersion != 4 {
		t.Fatalf("profile version = %d", profile.ProfileVersion)
	}
	if profile.ExtractionMethod != "ai_synthesized_with_grounded_evidence" {
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
	if len(profile.Evidence) != 10 {
		t.Fatalf("grounded evidence count = %d: %#v", len(profile.Evidence), profile.Evidence)
	}
	if profile.Evidence[0].Quote != "Example Athletics. Official Site" ||
		profile.Evidence[0].SourceURL != "https://example.com/" {
		t.Fatalf("grounded evidence = %#v", profile.Evidence[0])
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
		"verbatim substring",
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
	pagesPayload := evidencePayload["pages"].([]any)
	if pagesPayload[0].(map[string]any)["id"] != "page_001" {
		t.Fatalf("page ID = %#v", pagesPayload[0])
	}
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

func TestAIProfileSynthesizerRetriesTransientStatus(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		if calls.Add(1) == 1 {
			response.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		writeValidAIProfileResponse(response)
	}))
	defer server.Close()

	synthesizer := NewAIProfileSynthesizer(Config{
		BusinessProfileAIBaseURL:    server.URL,
		BusinessProfileAIAPIKey:     "test-key",
		BusinessProfileAIModel:      "test-model",
		BusinessProfileAITimeout:    time.Second,
		BusinessProfileAIMaxRetries: 1,
	})
	synthesizer.retryDelay = time.Millisecond

	profile, err := synthesizer.Synthesize(
		context.Background(),
		Task{TargetURL: "https://example.com", Language: "en"},
		standardAIProfilePages(),
		SiteProfile{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("request count = %d, want 2", calls.Load())
	}
	if profile.BusinessName != "Example" {
		t.Fatalf("business name = %q", profile.BusinessName)
	}
}

func TestAIProfileSynthesizerRetriesTimedOutRequest(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		if calls.Add(1) == 1 {
			time.Sleep(50 * time.Millisecond)
			return
		}
		writeValidAIProfileResponse(response)
	}))
	defer server.Close()

	synthesizer := NewAIProfileSynthesizer(Config{
		BusinessProfileAIBaseURL:    server.URL,
		BusinessProfileAIAPIKey:     "test-key",
		BusinessProfileAIModel:      "test-model",
		BusinessProfileAITimeout:    10 * time.Millisecond,
		BusinessProfileAIMaxRetries: 1,
	})
	synthesizer.retryDelay = time.Millisecond

	_, err := synthesizer.Synthesize(
		context.Background(),
		Task{TargetURL: "https://example.com", Language: "en"},
		standardAIProfilePages(),
		SiteProfile{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("request count = %d, want 2", calls.Load())
	}
}

func TestAIProfileSynthesizerDoesNotRetryAuthenticationFailure(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		calls.Add(1)
		response.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()

	synthesizer := NewAIProfileSynthesizer(Config{
		BusinessProfileAIBaseURL:    server.URL,
		BusinessProfileAIAPIKey:     "test-key",
		BusinessProfileAIModel:      "test-model",
		BusinessProfileAITimeout:    time.Second,
		BusinessProfileAIMaxRetries: 2,
	})

	_, err := synthesizer.Synthesize(
		context.Background(),
		Task{TargetURL: "https://example.com", Language: "en"},
		nil,
		SiteProfile{},
	)
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") {
		t.Fatalf("Synthesize() error = %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("request count = %d, want 1", calls.Load())
	}
}

func TestAIProfileSynthesizerRetriesInvalidOutput(t *testing.T) {
	var calls atomic.Int32
	var retryPrompt string
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		var requestBody struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(request.Body).Decode(&requestBody); err != nil {
			t.Fatal(err)
		}
		output := validAIProfileOutput()
		if calls.Add(1) == 1 {
			output.Evidence = output.Evidence[1:]
		} else {
			retryPrompt = requestBody.Messages[1].Content
		}
		writeAIProfileResponse(t, response, output)
	}))
	defer server.Close()

	synthesizer := NewAIProfileSynthesizer(Config{
		BusinessProfileAIBaseURL:    server.URL,
		BusinessProfileAIAPIKey:     "test-key",
		BusinessProfileAIModel:      "test-model",
		BusinessProfileAIMaxRetries: 1,
	})
	synthesizer.retryDelay = time.Millisecond

	profile, err := synthesizer.Synthesize(
		context.Background(),
		Task{TargetURL: "https://example.com", Language: "en"},
		standardAIProfilePages(),
		SiteProfile{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("request count = %d, want 2", calls.Load())
	}
	if profile.BusinessName != "Example" {
		t.Fatalf("business name = %q", profile.BusinessName)
	}
	if !strings.Contains(retryPrompt, "previous response failed") {
		t.Fatalf("retry prompt did not include validation feedback: %q", retryPrompt)
	}
}

func TestAIProfileSynthesizerSanitizesAndDeduplicatesLists(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		writeAIProfileResponse(t, response, aiProfileOutput{
			BusinessName:      "Example",
			BusinessType:      "Analytics software",
			BusinessSummary:   "Example helps teams understand their business data.",
			TargetAudiences:   []string{"Finance teams", "Finance teams."},
			ProductsServices:  []string{"Analytics", "analytics.", "Discover the future of business intelligence with a platform that transforms every decision across your entire organization."},
			ValuePropositions: []string{"Fast setup", "Fast setup.", "Build a better future for every team with powerful insights that unlock limitless growth and transform how the world works."},
			Evidence: []aiProfileEvidence{
				{Field: "business_name", Value: "Example", PageID: "page_001", Quote: "Example analytics software"},
				{Field: "business_type", Value: "Analytics software", PageID: "page_001", Quote: "analytics software"},
				{Field: "business_summary", Value: "Example helps teams understand their business data.", PageID: "page_001", Quote: "understand business data"},
				{Field: "target_audiences", Value: "Finance teams", PageID: "page_001", Quote: "Finance teams"},
				{Field: "products_services", Value: "Analytics", PageID: "page_001", Quote: "analytics software"},
				{Field: "value_propositions", Value: "Fast setup", PageID: "page_001", Quote: "fast setup"},
			},
		})
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
		[]Page{{
			URL:         "https://example.com",
			FinalURL:    "https://example.com",
			Description: "Example analytics software helps Finance teams understand business data with fast setup.",
		}},
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

func TestAIProfileSynthesizerRejectsCoreFieldWithoutValidGrounding(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		output := validAIProfileOutput()
		output.Evidence[0].Quote = "This text does not appear on the supplied page."
		writeAIProfileResponse(t, response, output)
	}))
	defer server.Close()

	_, err := NewAIProfileSynthesizer(Config{
		BusinessProfileAIBaseURL: server.URL,
		BusinessProfileAIAPIKey:  "test-key",
		BusinessProfileAIModel:   "test-model",
	}).Synthesize(
		context.Background(),
		Task{TargetURL: "https://example.com", Country: "US", Language: "en"},
		standardAIProfilePages(),
		SiteProfile{},
	)

	if err == nil || !strings.Contains(err.Error(), "missing required field business_name") {
		t.Fatalf("Synthesize() error = %v", err)
	}
}

func TestAIProfileSynthesizerAssociatesScalarCitationByField(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		output := validAIProfileOutput()
		output.Evidence[2].Value = "A stale copy of the summary"
		writeAIProfileResponse(t, response, output)
	}))
	defer server.Close()

	profile, err := NewAIProfileSynthesizer(Config{
		BusinessProfileAIBaseURL: server.URL,
		BusinessProfileAIAPIKey:  "test-key",
		BusinessProfileAIModel:   "test-model",
	}).Synthesize(
		context.Background(),
		Task{TargetURL: "https://example.com", Country: "US", Language: "en"},
		standardAIProfilePages(),
		SiteProfile{},
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, evidence := range profile.Evidence {
		if evidence.Field == "business_summary" &&
			evidence.Value == profile.BusinessSummary {
			return
		}
	}
	t.Fatalf("business summary evidence = %#v", profile.Evidence)
}

func TestAIProfileSynthesizerDiscardsAnUngroundedListItem(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		output := validAIProfileOutput()
		output.ProductsServices = append(output.ProductsServices, "Unsupported product")
		writeAIProfileResponse(t, response, output)
	}))
	defer server.Close()

	profile, err := NewAIProfileSynthesizer(Config{
		BusinessProfileAIBaseURL: server.URL,
		BusinessProfileAIAPIKey:  "test-key",
		BusinessProfileAIModel:   "test-model",
	}).Synthesize(
		context.Background(),
		Task{TargetURL: "https://example.com", Country: "US", Language: "en"},
		standardAIProfilePages(),
		SiteProfile{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(profile.ProductsServices, "|") != "Business software" {
		t.Fatalf("products/services = %#v", profile.ProductsServices)
	}
}

func TestAIProfileSynthesizerDiscardsListItemWithInvalidCitation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		_ *http.Request,
	) {
		output := validAIProfileOutput()
		output.ProductsServices = append(output.ProductsServices, "Unsupported product")
		output.Evidence = append(output.Evidence, aiProfileEvidence{
			Field:  "products_services",
			Value:  "Unsupported product",
			PageID: "page_001",
			Quote:  "This fabricated quote is not in the supplied evidence.",
		})
		writeAIProfileResponse(t, response, output)
	}))
	defer server.Close()

	profile, err := NewAIProfileSynthesizer(Config{
		BusinessProfileAIBaseURL: server.URL,
		BusinessProfileAIAPIKey:  "test-key",
		BusinessProfileAIModel:   "test-model",
	}).Synthesize(
		context.Background(),
		Task{TargetURL: "https://example.com", Country: "US", Language: "en"},
		standardAIProfilePages(),
		SiteProfile{},
	)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(profile.ProductsServices, "|") != "Business software" {
		t.Fatalf("products/services = %#v", profile.ProductsServices)
	}
	for _, evidence := range profile.Evidence {
		if evidence.Value == "Unsupported product" {
			t.Fatalf("invalid evidence was retained: %#v", evidence)
		}
	}
}

func TestAlignPageQuoteIgnoresOnlyCaseWhitespaceAndPunctuation(t *testing.T) {
	page := profileEvidencePage{
		Description: "Open-source software, with publicly auditable code.",
	}

	aligned, matched := alignPageQuote(
		page,
		"open source SOFTWARE with publicly auditable code",
	)
	if !matched {
		t.Fatal("quote was not aligned")
	}
	if aligned != "Open-source software, with publicly auditable code" {
		t.Fatalf("aligned quote = %q", aligned)
	}
	if _, matched := alignPageQuote(page, "open source private software"); matched {
		t.Fatal("quote with a substituted word was accepted")
	}
}

func writeValidAIProfileResponse(response http.ResponseWriter) {
	response.Header().Set("Content-Type", "application/json")
	content, _ := json.Marshal(validAIProfileOutput())
	body, _ := json.Marshal(map[string]any{
		"choices": []map[string]any{{
			"message": map[string]string{"content": string(content)},
		}},
	})
	_, _ = response.Write(body)
}

func writeAIProfileResponse(
	t *testing.T,
	response http.ResponseWriter,
	output aiProfileOutput,
) {
	t.Helper()
	content, err := json.Marshal(output)
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(map[string]any{
		"choices": []map[string]any{{
			"message": map[string]string{"content": string(content)},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	response.Header().Set("Content-Type", "application/json")
	_, _ = response.Write(body)
}

func standardAIProfilePages() []Page {
	return []Page{{
		URL:         "https://example.com",
		FinalURL:    "https://example.com",
		Description: "Example provides business software for teams with fast setup.",
	}}
}

func validAIProfileOutput() aiProfileOutput {
	const quote = "Example provides business software for teams with fast setup."
	return aiProfileOutput{
		BusinessName:      "Example",
		BusinessType:      "Software",
		BusinessSummary:   "Example provides business software.",
		TargetAudiences:   []string{"Teams"},
		ProductsServices:  []string{"Business software"},
		ValuePropositions: []string{"Fast setup"},
		Evidence: []aiProfileEvidence{
			{Field: "business_name", Value: "Example", PageID: "page_001", Quote: quote},
			{Field: "business_type", Value: "Software", PageID: "page_001", Quote: quote},
			{Field: "business_summary", Value: "Example provides business software.", PageID: "page_001", Quote: quote},
			{Field: "target_audiences", Value: "Teams", PageID: "page_001", Quote: quote},
			{Field: "products_services", Value: "Business software", PageID: "page_001", Quote: quote},
			{Field: "value_propositions", Value: "Fast setup", PageID: "page_001", Quote: quote},
		},
	}
}
