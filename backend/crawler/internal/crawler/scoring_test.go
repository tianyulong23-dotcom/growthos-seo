package crawler

import (
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

func TestPricingRoleDoesNotTreatCompoundPlanPathsAsPricing(t *testing.T) {
	trainingPlanURL, _ := url.Parse("https://example.com/training-plan")

	if role := CandidateBusinessRole(Candidate{URL: trainingPlanURL}); role == BusinessPagePricing {
		t.Fatalf("role = %q, compound plan path must not be pricing", role)
	}
}

func TestPricingRoleRecognizesTopLevelPlanPaths(t *testing.T) {
	for _, rawURL := range []string{
		"https://example.com/plan",
		"https://example.com/plans",
	} {
		pageURL, _ := url.Parse(rawURL)
		if role := CandidateBusinessRole(Candidate{URL: pageURL}); role != BusinessPagePricing {
			t.Fatalf("%s role = %q, want %q", rawURL, role, BusinessPagePricing)
		}
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
	} {
		pageURL, _ := url.Parse(rawURL)
		if role := CandidateBusinessRole(Candidate{URL: pageURL}); role != BusinessPageUtility {
			t.Fatalf("%s role = %q, want %q", rawURL, role, BusinessPageUtility)
		}
	}
}

func TestBusinessProfileCandidateSelectionSkipsUtilityPages(t *testing.T) {
	aboutURL, _ := url.Parse("https://example.com/about")
	productURL, _ := url.Parse("https://example.com/products")
	helpURL, _ := url.Parse("https://example.com/help")
	candidates := map[string]Candidate{}
	for _, candidate := range []Candidate{
		{URL: aboutURL, InNavigation: true, Score: 60},
		{URL: productURL, InNavigation: true, Score: 60},
		{URL: helpURL, InNavigation: true, Score: 100},
	} {
		addCandidate(candidates, candidate)
	}

	selected := bestUnderstandingCandidates(
		candidates,
		map[string]struct{}{},
		map[BusinessPageRole]int{},
		3,
	)
	if len(selected) != 2 {
		t.Fatalf("selected %d candidates, want 2", len(selected))
	}
	for _, candidate := range selected {
		if role := CandidateBusinessRole(candidate); role == BusinessPageUtility {
			t.Fatalf("selected utility page %s", candidate.URL)
		}
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

func TestSiteUnderstandingSelectionPrefersMissingBusinessRole(t *testing.T) {
	aboutURL, _ := url.Parse("https://example.com/about")
	productOneURL, _ := url.Parse("https://example.com/products/one")
	productTwoURL, _ := url.Parse("https://example.com/products/two")
	candidates := map[string]Candidate{}
	for _, candidate := range []Candidate{
		{URL: aboutURL, Depth: 1, InNavigation: true},
		{URL: productOneURL, Depth: 1, InNavigation: true},
		{URL: productTwoURL, Depth: 1, InNavigation: true},
	} {
		addCandidate(candidates, candidate)
	}
	pages := []Page{{
		URL:      "https://example.com/products",
		FinalURL: "https://example.com/products",
		Title:    "Products",
		H1:       []string{"Products"},
	}}

	selected, ok := bestCandidate(
		candidates,
		map[string]struct{}{},
		TaskSiteUnderstanding,
		pages,
	)
	if !ok {
		t.Fatal("bestCandidate() returned no candidate")
	}
	if selected.URL.String() != "https://example.com/about" {
		t.Fatalf("selected URL = %q, want about page", selected.URL)
	}
}

func TestSiteUnderstandingRequiresThreeDistinctPageRoles(t *testing.T) {
	task := Task{
		TargetURL: "https://example.com",
		Country:   "US",
		Language:  "en",
	}
	pages := []Page{
		{
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			Title:       "Acme Store",
			Description: "Acme sells operations equipment.",
		},
		{
			URL:      "https://example.com/products/one",
			FinalURL: "https://example.com/products/one",
			Title:    "Product One",
			H1:       []string{"Product One"},
		},
		{
			URL:      "https://example.com/products/two",
			FinalURL: "https://example.com/products/two",
			Title:    "Product Two",
			H1:       []string{"Product Two"},
		},
	}

	if siteUnderstandingComplete(task, pages) {
		t.Fatal("site understanding completed with duplicate offering roles")
	}
}

func TestSiteUnderstandingDoesNotCountNonBusinessRolesAsThirdRole(t *testing.T) {
	task := Task{
		TargetURL: "https://example.com",
		Country:   "US",
		Language:  "en",
	}
	basePages := []Page{
		{
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			Title:       "Acme",
			Description: "Acme is a software platform for operations teams.",
		},
		{
			URL:         "https://example.com/products/workflows",
			FinalURL:    "https://example.com/products/workflows",
			Title:       "Workflow Automation",
			Description: "Automate recurring work.",
			H1:          []string{"Workflow Automation"},
		},
	}

	tests := []Page{
		{
			URL:      "https://example.com/blog",
			FinalURL: "https://example.com/blog",
			Title:    "Blog",
		},
		{
			URL:      "https://example.com/login",
			FinalURL: "https://example.com/login",
			Title:    "Log in",
		},
		{
			URL:      "https://example.com/careers",
			FinalURL: "https://example.com/careers",
			Title:    "Careers",
		},
		{
			URL:      "https://example.com/help",
			FinalURL: "https://example.com/help",
			Title:    "Help",
		},
		{
			URL:      "https://example.com/support",
			FinalURL: "https://example.com/support",
			Title:    "Customer support",
		},
	}

	for _, thirdPage := range tests {
		pages := append(append([]Page{}, basePages...), thirdPage)
		if siteUnderstandingComplete(task, pages) {
			t.Fatalf(
				"site understanding completed when third role was %q",
				PageBusinessRole(thirdPage),
			)
		}
	}
}

func TestSiteUnderstandingCountsAThirdBusinessRole(t *testing.T) {
	task := Task{
		TargetURL: "https://example.com",
		Country:   "US",
		Language:  "en",
	}
	pages := []Page{
		{
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			Title:       "Acme",
			Description: "Acme is a software platform for operations teams.",
		},
		{
			URL:         "https://example.com/products/workflows",
			FinalURL:    "https://example.com/products/workflows",
			Title:       "Workflow Automation",
			Description: "Automate recurring work.",
			H1:          []string{"Workflow Automation"},
		},
		{
			URL:         "https://example.com/about",
			FinalURL:    "https://example.com/about",
			Title:       "About Acme",
			Description: "Learn about Acme.",
		},
	}

	if !siteUnderstandingComplete(task, pages) {
		t.Fatal("site understanding did not complete with a third business role")
	}
}
