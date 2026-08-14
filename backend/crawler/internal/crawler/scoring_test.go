package crawler

import (
	"encoding/json"
	"net/url"
	"testing"
)

func TestImportantPageScoresAboveUtilityPage(t *testing.T) {
	productURL, _ := url.Parse("https://example.com/products/widget")
	loginURL, _ := url.Parse("https://example.com/account/login")

	product := ScoreCandidate(Candidate{
		URL:             productURL,
		Depth:           1,
		InNavigation:    true,
		FromSitemap:     true,
		SitemapPriority: 0.8,
	})
	login := ScoreCandidate(Candidate{URL: loginURL, Depth: 1})
	if product <= login {
		t.Fatalf("product score %d should exceed login score %d", product, login)
	}
}

func TestCandidateRoleUsesAnchorTextForGenericURLs(t *testing.T) {
	productURL, _ := url.Parse("https://example.com/w/catalog-entry")
	candidate := Candidate{
		URL:        productURL,
		AnchorText: "Products and services",
	}

	if role := CandidateBusinessRole(candidate); role != BusinessPageOffering {
		t.Fatalf("role = %q, want %q", role, BusinessPageOffering)
	}
}

func TestCandidateRoleTreatsDownloadPageAsOffering(t *testing.T) {
	downloadURL, _ := url.Parse("https://example.com/download")
	candidate := Candidate{URL: downloadURL, AnchorText: "Download the app"}

	if role := CandidateBusinessRole(candidate); role != BusinessPageOffering {
		t.Fatalf("role = %q, want %q", role, BusinessPageOffering)
	}
}

func TestPricingRoleDoesNotTreatCompoundPlanPathsAsPricing(t *testing.T) {
	trainingPlanURL, _ := url.Parse("https://example.com/training-plan")

	if role := CandidateBusinessRole(Candidate{URL: trainingPlanURL}); role == BusinessPagePricing {
		t.Fatalf("role = %q, compound plan path must not be pricing", role)
	}
}

func TestPricingRoleDoesNotSpecialCaseStandalonePlanLabel(t *testing.T) {
	brandedPlanURL, _ := url.Parse("https://example.com/acmes-plan")
	candidate := Candidate{URL: brandedPlanURL, AnchorText: "Plan", InNavigation: true}

	if role := CandidateBusinessRole(candidate); role != BusinessPageOther {
		t.Fatalf("role = %q, want %q", role, BusinessPageOther)
	}
}

func TestPricingRoleRecognizesExplicitPlanLanguage(t *testing.T) {
	for _, anchorText := range []string{
		"Pricing plans",
		"Subscription plans",
	} {
		pageURL, _ := url.Parse("https://example.com/compare")
		candidate := Candidate{URL: pageURL, AnchorText: anchorText}
		if role := CandidateBusinessRole(candidate); role != BusinessPagePricing {
			t.Fatalf("%q role = %q, want %q", anchorText, role, BusinessPagePricing)
		}
	}
}

func TestContentPathOutranksGenericCategorySignal(t *testing.T) {
	pageURL, _ := url.Parse("https://example.com/category/blog")
	candidate := Candidate{URL: pageURL, AnchorText: "Blog"}

	if role := CandidateBusinessRole(candidate); role != BusinessPageContent {
		t.Fatalf("role = %q, want %q", role, BusinessPageContent)
	}
}

func TestLocalizedLanguageRootIsHomepage(t *testing.T) {
	for _, page := range []Page{
		{
			URL:      "https://example.com/fr",
			FinalURL: "https://example.com/fr",
			Language: "fr-FR",
		},
		{
			URL:      "https://example.com/en-us/",
			FinalURL: "https://example.com/en-us/",
			Language: "en-US",
		},
	} {
		if role := PageBusinessRole(page); role != BusinessPageHomepage {
			t.Fatalf("%s role = %q, want %q", page.FinalURL, role, BusinessPageHomepage)
		}
	}
}

func TestBusinessRoleRecognizesCommonLocalizedNavigationTerms(t *testing.T) {
	tests := []struct {
		path string
		text string
		want BusinessPageRole
	}{
		{path: "/chan-pin", text: "产品", want: BusinessPageOffering},
		{path: "/tarifs", text: "Tarifs", want: BusinessPagePricing},
		{path: "/empresa", text: "Sobre nosotros", want: BusinessPageAbout},
		{path: "/kontakt", text: "Kontakt", want: BusinessPageContact},
	}

	for _, test := range tests {
		pageURL, _ := url.Parse("https://example.com" + test.path)
		role := CandidateBusinessRole(Candidate{
			URL:        pageURL,
			AnchorText: test.text,
		})
		if role != test.want {
			t.Fatalf("%q role = %q, want %q", test.text, role, test.want)
		}
	}
}

func TestBusinessRoleTreatsHelpAndSupportPathsAsUtility(t *testing.T) {
	for _, rawURL := range []string{
		"https://example.com/help",
		"https://example.com/help/orders",
		"https://example.com/support",
		"https://example.com/customer-service",
		"https://example.com/returns",
		"https://example.com/accessibility",
		"https://example.com/privacy-policy",
		"https://example.com/terms-of-service",
		"https://example.com/dmca",
	} {
		pageURL, _ := url.Parse(rawURL)
		if role := CandidateBusinessRole(Candidate{URL: pageURL}); role != BusinessPageUtility {
			t.Fatalf("%s role = %q, want %q", rawURL, role, BusinessPageUtility)
		}
	}
}

func TestSiteUnderstandingCandidateSelectionSkipsUtilityPages(t *testing.T) {
	homeURL, _ := url.Parse("https://example.com/")
	privacyURL, _ := url.Parse("https://example.com/privacy-policy")
	dmcaURL, _ := url.Parse("https://example.com/dmca")
	aboutURL, _ := url.Parse("https://example.com/about")
	productsURL, _ := url.Parse("https://example.com/products")
	candidates := map[string]Candidate{}
	for _, candidate := range []Candidate{
		{URL: homeURL, Depth: 0},
		{URL: privacyURL, Depth: 1},
		{URL: dmcaURL, Depth: 1},
		{URL: aboutURL, Depth: 1},
		{URL: productsURL, Depth: 1},
	} {
		addCandidate(candidates, candidate)
	}

	selected := pendingSiteUnderstandingCandidates(
		candidates,
		map[string]struct{}{homeURL.String(): {}},
		nil,
		4,
	)
	if len(selected) != 2 {
		t.Fatalf("selected %d candidates, want 2", len(selected))
	}
	if selected[0].URL.String() != aboutURL.String() ||
		selected[1].URL.String() != productsURL.String() {
		t.Fatalf("selected URLs = %#v", selected)
	}
}

func TestSiteUnderstandingCandidateSelectionUsesDistinctBusinessRoles(t *testing.T) {
	aboutURL, _ := url.Parse("https://example.com/about")
	productsURL, _ := url.Parse("https://example.com/products")
	productDetailURL, _ := url.Parse("https://example.com/products/widget")
	pricingURL, _ := url.Parse("https://example.com/pricing")
	customersURL, _ := url.Parse("https://example.com/customers")
	blogURL, _ := url.Parse("https://example.com/blog")
	partnerURL, _ := url.Parse("https://example.com/partners")
	candidates := map[string]Candidate{}
	for _, candidate := range []Candidate{
		{URL: blogURL, Depth: 1},
		{URL: partnerURL, Depth: 1},
		{URL: productDetailURL, Depth: 1},
		{URL: customersURL, Depth: 1},
		{URL: pricingURL, Depth: 1},
		{URL: productsURL, Depth: 1},
		{URL: aboutURL, Depth: 1},
	} {
		addCandidate(candidates, candidate)
	}

	selected := pendingSiteUnderstandingCandidates(
		candidates,
		map[string]struct{}{},
		nil,
		7,
	)
	if len(selected) != 7 {
		t.Fatalf("selected %d candidates, want 7", len(selected))
	}
	want := []string{
		aboutURL.String(),
		productsURL.String(),
		pricingURL.String(),
		customersURL.String(),
		productDetailURL.String(),
		partnerURL.String(),
		blogURL.String(),
	}
	for index, candidate := range selected {
		if candidate.URL.String() != want[index] {
			t.Fatalf("selected[%d] = %q, want %q", index, candidate.URL, want[index])
		}
	}
}

func TestSiteUnderstandingProtectsPricingFromSecondOffering(t *testing.T) {
	productsURL, _ := url.Parse("https://example.com/products")
	productDetailURL, _ := url.Parse("https://example.com/products/widget")
	pricingURL, _ := url.Parse("https://example.com/pricing")
	candidates := []Candidate{
		{URL: productDetailURL, Depth: 1, DiscoveryOrder: 1},
		{URL: productsURL, Depth: 1, DiscoveryOrder: 2},
		{URL: pricingURL, Depth: 1, DiscoveryOrder: 3},
	}

	selected := selectSiteUnderstandingCandidates(candidates, nil, 2)
	if len(selected) != 2 {
		t.Fatalf("selected %d candidates, want 2", len(selected))
	}
	if selected[0].URL.String() != productsURL.String() ||
		selected[1].URL.String() != pricingURL.String() {
		t.Fatalf("selected URLs = %#v", selected)
	}
}

func TestSiteUnderstandingFetchesUnclassifiedPagesWithinDepthTwo(t *testing.T) {
	overviewURL, _ := url.Parse("https://example.com/overview")
	partnersURL, _ := url.Parse("https://example.com/partners")
	bodyURL, _ := url.Parse("https://example.com/misc")
	deepURL, _ := url.Parse("https://example.com/catalog/item/details")
	candidates := []Candidate{
		{URL: partnersURL, Depth: 1, DiscoveryOrder: 2, InNavigation: true},
		{URL: bodyURL, Depth: 2, DiscoveryOrder: 1},
		{URL: overviewURL, Depth: 1, DiscoveryOrder: 1, InNavigation: true},
		{URL: deepURL, Depth: 3, DiscoveryOrder: 3},
	}

	selected := selectSiteUnderstandingCandidates(candidates, nil, 4)
	if len(selected) != 3 {
		t.Fatalf("selected %d candidates, want 3", len(selected))
	}
	want := []string{overviewURL.String(), partnersURL.String(), bodyURL.String()}
	for index, candidate := range selected {
		if candidate.URL.String() != want[index] {
			t.Fatalf("selected[%d] = %q, want %q", index, candidate.URL, want[index])
		}
	}
}

func TestSiteUnderstandingKeepsOnlyCoreRolesAfterReadingPage(t *testing.T) {
	pricingPage := Page{
		FinalURL:   "https://example.com/billing-options",
		Title:      "Compare pricing packages",
		MainText:   "Choose the package that fits your team.",
		Depth:      1,
		StatusCode: 200,
	}
	unknownPage := Page{
		FinalURL:   "https://example.com/partners",
		Title:      "Partner network",
		MainText:   "Learn about our partner network.",
		Depth:      1,
		StatusCode: 200,
	}

	if !siteUnderstandingPageEligible(pricingPage, nil) {
		t.Fatal("pricing page was not retained after its body was read")
	}
	if siteUnderstandingPageEligible(unknownPage, nil) {
		t.Fatal("unclassified page consumed the final page budget")
	}
}

func TestSiteUnderstandingRejectsEditorialReviewAfterReadingPage(t *testing.T) {
	page := Page{
		FinalURL:    "https://example.com/customers/my-switching-story",
		Title:       "Why I switched providers after ten years",
		Description: "My personal review of the service.",
		H1:          []string{"Why I switched providers"},
		Author:      "Example Author",
		MainText: "I tried the service for a month. In this review I explain my " +
			"experience and what I liked about it.",
		StructuredData: []json.RawMessage{json.RawMessage(`{
			"@context": "https://schema.org",
			"@type": "Article"
		}`)},
		StatusCode: 200,
	}

	if siteUnderstandingPageEligible(page, nil) {
		t.Fatal("personal editorial review was retained as business proof")
	}
}

func TestSiteUnderstandingKeepsEvidenceRichCustomerCaseStudy(t *testing.T) {
	page := Page{
		FinalURL:    "https://example.com/customers/northwind",
		Title:       "Northwind customer case study",
		Description: "See how Northwind reduced processing time by 40%.",
		H1:          []string{"Northwind customer success story"},
		MainText: "This customer case study explains how Northwind used the platform " +
			"to reduce processing time by 40% and serve its clients faster.",
		StructuredData: []json.RawMessage{json.RawMessage(`{
			"@context": "https://schema.org",
			"@type": "Article"
		}`)},
		StatusCode: 200,
	}

	if !siteUnderstandingPageEligible(page, nil) {
		t.Fatal("evidence-rich customer case study was rejected")
	}
}

func TestSiteUnderstandingDistinguishesDownloadProductFromTutorial(t *testing.T) {
	tutorial := Page{
		FinalURL:    "https://example.com/download-app-step-by-step-guide",
		Title:       "Download the app: step-by-step installation guide",
		Description: "Follow these instructions to install the app on your TV.",
		H1:          []string{"How to download and install the app"},
		MainText:    "Step 1 open the downloader. Step 2 enter the code. Step 3 install the app.",
		StatusCode:  200,
	}
	product := Page{
		FinalURL:    "https://example.com/download",
		Title:       "Acme desktop app",
		Description: "Download the Acme app for secure team collaboration.",
		H1:          []string{"Acme for desktop"},
		MainText:    "The Acme desktop app provides secure collaboration, file sharing, and team workspaces.",
		StatusCode:  200,
	}

	if siteUnderstandingPageEligible(tutorial, nil) {
		t.Fatal("installation tutorial was retained as a core offering page")
	}
	if !siteUnderstandingPageEligible(product, nil) {
		t.Fatal("commercial download page was rejected")
	}
}

func TestBusinessRoleDoesNotTreatCommercialSupportTextAsUtility(t *testing.T) {
	pageURL, _ := url.Parse("https://example.com/services/managed-it")
	candidate := Candidate{
		URL:        pageURL,
		AnchorText: "Managed IT support services",
	}

	if role := CandidateBusinessRole(candidate); role != BusinessPageOffering {
		t.Fatalf("role = %q, want %q", role, BusinessPageOffering)
	}
}

func TestSiteUnderstandingCandidateSelectionStopsAtDepthTwo(t *testing.T) {
	depthTwoURL, _ := url.Parse("https://example.com/products/widget")
	depthThreeURL, _ := url.Parse("https://example.com/pricing/enterprise/details")
	candidates := map[string]Candidate{}
	for _, candidate := range []Candidate{
		{URL: depthTwoURL, Depth: 2},
		{URL: depthThreeURL, Depth: 3},
	} {
		addCandidate(candidates, candidate)
	}

	selected, ok := bestCandidate(
		candidates,
		map[string]struct{}{},
		TaskSiteUnderstanding,
		nil,
	)
	if !ok {
		t.Fatal("bestCandidate() returned no candidate")
	}
	if selected.URL.String() != depthTwoURL.String() {
		t.Fatalf("selected URL = %q, want depth-two page", selected.URL)
	}

	processed := map[string]struct{}{depthTwoURL.String(): {}}
	if _, ok := bestCandidate(candidates, processed, TaskSiteUnderstanding, nil); ok {
		t.Fatal("bestCandidate() selected a page deeper than two levels")
	}
}

func TestSiteUnderstandingRecognizesPricingFromExplicitBodyEvidence(t *testing.T) {
	page := Page{
		FinalURL:   "https://example.com/access-options",
		Title:      "Access options",
		H1:         []string{"Choose the right access"},
		MainText:   "Compare our monthly subscription plans and choose the package that fits your team.",
		StatusCode: 200,
	}

	if role := PageBusinessRole(page); role != BusinessPagePricing {
		t.Fatalf("role = %q, want %q", role, BusinessPagePricing)
	}
	if !siteUnderstandingPageEligible(page, nil) {
		t.Fatal("pricing page identified from explicit body evidence was rejected")
	}
}

func TestSiteUnderstandingRejectsRenderedErrorShell(t *testing.T) {
	page := Page{
		FinalURL:   "https://example.com/",
		Title:      "Unsupported client",
		MainText:   "Unsupported client. Please use a supported browser.",
		StatusCode: 200,
		Rendered:   true,
	}

	if siteUnderstandingPageEligible(page, nil) {
		t.Fatal("rendered browser error shell was retained as business evidence")
	}
}

func TestSiteUnderstandingRejectsNearDuplicateOfferingPage(t *testing.T) {
	first := Page{
		FinalURL:    "https://example.com/collections/team-tools",
		Title:       "Team tools collection",
		Description: "Browse collaboration tools for modern teams.",
		H1:          []string{"Tools for modern teams"},
		MainText:    "Browse collaboration tools for modern teams, including shared workspaces and project coordination.",
		WordCount:   12,
		StatusCode:  200,
	}
	second := Page{
		FinalURL:    "https://example.com/collections/business-tools",
		Title:       "Business tools collection",
		Description: "Browse collaboration tools for modern teams.",
		H1:          []string{"Tools for modern teams"},
		MainText:    "Browse collaboration tools for modern teams, including shared workspaces and project coordination.",
		WordCount:   12,
		StatusCode:  200,
	}

	if !siteUnderstandingPageEligible(first, nil) {
		t.Fatal("first offering page was rejected")
	}
	if siteUnderstandingPageEligible(second, []Page{first}) {
		t.Fatal("near-duplicate offering page consumed a second offering slot")
	}
}
