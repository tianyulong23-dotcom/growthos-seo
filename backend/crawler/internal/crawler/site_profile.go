package crawler

import (
	"encoding/json"
	"math"
	"net/url"
	"path"
	"regexp"
	"strings"
)

type SiteProfile struct {
	ProfileVersion    int                   `json:"profile_version"`
	ExtractionMethod  string                `json:"extraction_method"`
	SourcePageCount   int                   `json:"source_page_count"`
	FaviconURL        string                `json:"favicon_url"`
	BusinessName      string                `json:"business_name"`
	BusinessType      string                `json:"business_type"`
	BusinessModel     string                `json:"business_model,omitempty"`
	BusinessSummary   string                `json:"business_summary"`
	ProductsServices  []string              `json:"products_services"`
	TargetAudiences   []string              `json:"target_audiences"`
	ValuePropositions []string              `json:"value_propositions"`
	UseCases          []string              `json:"use_cases"`
	TargetMarkets     []string              `json:"target_markets"`
	Languages         []string              `json:"languages"`
	ContentTopics     []string              `json:"content_topics"`
	ConversionActions []string              `json:"conversion_actions"`
	KeyPages          []SiteProfileKeyPage  `json:"key_pages"`
	Evidence          []SiteProfileEvidence `json:"evidence"`
	Confidence        float64               `json:"confidence"`
}

type SiteProfileKeyPage struct {
	URL         string `json:"url"`
	Title       string `json:"title"`
	Description string `json:"description"`
}

type SiteProfileEvidence struct {
	Field     string `json:"field"`
	Value     string `json:"value"`
	SourceURL string `json:"source_url"`
	Quote     string `json:"quote,omitempty"`
}

func SiteProfileReady(profile SiteProfile) bool {
	return strings.TrimSpace(profile.BusinessName) != "" &&
		strings.TrimSpace(profile.BusinessType) != "" &&
		strings.TrimSpace(profile.BusinessSummary) != "" &&
		len(profile.TargetAudiences) > 0 &&
		len(profile.ProductsServices) > 0 &&
		len(profile.ValuePropositions) > 0
}

func SiteProfileHasSubstantiveData(profile SiteProfile) bool {
	return strings.TrimSpace(profile.BusinessType) != "" ||
		strings.TrimSpace(profile.BusinessSummary) != "" ||
		len(profile.ProductsServices) > 0 ||
		len(profile.TargetAudiences) > 0 ||
		len(profile.ValuePropositions) > 0 ||
		len(profile.UseCases) > 0 ||
		len(profile.ContentTopics) > 0 ||
		len(profile.ConversionActions) > 0 ||
		len(profile.Evidence) > 0
}

func siteProfileForPersistence(task Task, result Result) (SiteProfile, bool) {
	profile := BuildSiteProfile(task, result.Pages)
	if result.SiteProfile != nil {
		profile = *result.SiteProfile
	}
	return profile, SiteProfileHasSubstantiveData(profile)
}

type sourcedValue struct {
	Value     string
	SourceURL string
}

type structuredFacts struct {
	OrganizationNames        []sourcedValue
	OrganizationDescriptions []sourcedValue
	Offerings                []sourcedValue
	Audiences                []sourcedValue
	Markets                  []sourcedValue
	TypeSignals              []sourcedValue
}

func BuildSiteProfile(task Task, pages []Page) SiteProfile {
	homepage := representativeHomepage(task.TargetURL, pages)
	homepageURL := pageSourceURL(homepage, task.TargetURL)
	facts := collectStructuredFacts(pages)

	businessName := firstSourced(
		facts.OrganizationNames,
		sourcedValue{Value: homepage.OpenGraph["site_name"], SourceURL: homepageURL},
		sourcedValue{Value: titleBrand(homepage.Title), SourceURL: homepageURL},
		sourcedValue{
			Value:     strings.TrimPrefix(hostname(task.TargetURL), "www."),
			SourceURL: task.TargetURL,
		},
	)
	businessName.Value = businessDisplayName(businessName.Value)
	summary := firstSourced(
		facts.OrganizationDescriptions,
		sourcedValue{Value: homepage.Description, SourceURL: homepageURL},
		sourcedValue{Value: homepage.OpenGraph["description"], SourceURL: homepageURL},
		sourcedValue{Value: firstString(homepage.H1), SourceURL: homepageURL},
	)

	businessType := inferBusinessType(pages, facts)
	offerings := append(
		append([]sourcedValue{}, facts.Offerings...),
		collectOfferingLabels(pages, 12)...,
	)
	audiences := append(
		append([]sourcedValue{}, facts.Audiences...),
		collectAudienceLabels(pages, 8)...,
	)
	valuePropositions := collectValuePropositions(pages, 8)
	useCases := collectUseCases(pages, 8)
	contentTopics := collectContentTopics(pages, 8)
	conversionActions := collectConversionActions(pages, 8)
	markets := append(
		append([]sourcedValue{}, facts.Markets...),
		collectHreflangMarkets(pages)...,
	)
	languages := collectLanguages(pages)
	keyPages := collectKeyPages(pages, 8)

	profile := SiteProfile{
		ProfileVersion:    2,
		ExtractionMethod:  "structured_data_and_page_content",
		SourcePageCount:   len(pages),
		FaviconURL:        homepage.FaviconURL,
		BusinessName:      businessName.Value,
		BusinessType:      businessType.Value,
		BusinessSummary:   summary.Value,
		ProductsServices:  sourcedStrings(offerings, 8),
		TargetAudiences:   sourcedStrings(audiences, 8),
		ValuePropositions: sourcedStrings(valuePropositions, 8),
		UseCases:          sourcedStrings(useCases, 8),
		TargetMarkets:     sourcedStrings(markets, 8),
		Languages:         sourcedStrings(languages, 8),
		ContentTopics:     sourcedStrings(contentTopics, 8),
		ConversionActions: sourcedStrings(conversionActions, 8),
		KeyPages:          keyPages,
	}

	appendEvidence(&profile.Evidence, "business_name", []sourcedValue{businessName}, 1)
	appendEvidence(&profile.Evidence, "business_type", []sourcedValue{businessType}, 1)
	appendEvidence(&profile.Evidence, "business_summary", []sourcedValue{summary}, 1)
	appendEvidence(&profile.Evidence, "products_services", offerings, 8)
	appendEvidence(&profile.Evidence, "target_audiences", audiences, 8)
	appendEvidence(&profile.Evidence, "value_propositions", valuePropositions, 8)
	appendEvidence(&profile.Evidence, "use_cases", useCases, 8)
	appendEvidence(&profile.Evidence, "content_topics", contentTopics, 8)
	appendEvidence(&profile.Evidence, "conversion_actions", conversionActions, 8)
	appendEvidence(&profile.Evidence, "languages", languages, 8)
	appendEvidence(&profile.Evidence, "target_markets", markets, 8)
	for _, keyPage := range profile.KeyPages {
		profile.Evidence = append(profile.Evidence, SiteProfileEvidence{
			Field:     "key_pages",
			Value:     keyPage.Title,
			SourceURL: keyPage.URL,
		})
	}

	profile.Confidence = profileConfidence(profile)
	return profile
}

func collectStructuredFacts(pages []Page) structuredFacts {
	var facts structuredFacts
	for _, page := range pages {
		sourceURL := pageSourceURL(page, "")
		for _, raw := range page.StructuredData {
			var value any
			if json.Unmarshal(raw, &value) == nil {
				walkStructuredData(value, sourceURL, &facts)
			}
		}
		for _, item := range page.SchemaMicrodata {
			node := make(map[string]any, len(item.Properties)+1)
			node["@type"] = item.Type
			for key, value := range item.Properties {
				node[key] = value
			}
			walkStructuredData(node, sourceURL, &facts)
		}
	}
	return facts
}

func walkStructuredData(value any, sourceURL string, facts *structuredFacts) {
	switch node := value.(type) {
	case []any:
		for _, child := range node {
			walkStructuredData(child, sourceURL, facts)
		}
	case map[string]any:
		types := structuredStrings(node["@type"])
		name := structuredText(node, "name", "headline")
		description := structuredText(node, "description")
		for _, schemaType := range types {
			facts.TypeSignals = appendSourced(
				facts.TypeSignals,
				sourcedValue{Value: schemaType, SourceURL: sourceURL},
			)
			switch strings.ToLower(schemaType) {
			case "organization", "corporation", "brand", "localbusiness",
				"professionalservice", "newsmediaorganization",
				"educationalorganization", "medicalorganization":
				facts.OrganizationNames = appendSourced(
					facts.OrganizationNames,
					sourcedValue{Value: name, SourceURL: sourceURL},
				)
				facts.OrganizationDescriptions = appendSourced(
					facts.OrganizationDescriptions,
					sourcedValue{Value: description, SourceURL: sourceURL},
				)
			case "product", "productgroup", "service", "softwareapplication",
				"webapplication", "mobileapplication", "offercatalog", "course":
				facts.Offerings = appendSourced(
					facts.Offerings,
					sourcedValue{Value: name, SourceURL: sourceURL},
				)
			case "audience", "businessaudience", "peopleaudience":
				facts.Audiences = appendSourced(
					facts.Audiences,
					sourcedValue{
						Value: firstNonEmpty(
							structuredText(node, "audienceType"),
							name,
						),
						SourceURL: sourceURL,
					},
				)
			}
		}
		for _, key := range []string{
			"audience",
			"serviceAudience",
			"targetAudience",
		} {
			facts.Audiences = appendSourced(
				facts.Audiences,
				sourcedValue{
					Value:     structuredText(node, key),
					SourceURL: sourceURL,
				},
			)
		}
		for _, key := range []string{
			"areaServed",
			"serviceArea",
			"addressCountry",
		} {
			for _, market := range structuredStrings(node[key]) {
				facts.Markets = appendSourced(
					facts.Markets,
					sourcedValue{Value: market, SourceURL: sourceURL},
				)
			}
		}
		for _, child := range node {
			switch child.(type) {
			case []any, map[string]any:
				walkStructuredData(child, sourceURL, facts)
			}
		}
	}
}

func structuredText(node map[string]any, keys ...string) string {
	for _, key := range keys {
		if values := structuredStrings(node[key]); len(values) > 0 {
			return values[0]
		}
	}
	return ""
}

func structuredStrings(value any) []string {
	switch item := value.(type) {
	case string:
		return uniqueNonEmpty([]string{item}, 8)
	case []any:
		values := make([]string, 0, len(item))
		for _, child := range item {
			values = append(values, structuredStrings(child)...)
		}
		return uniqueNonEmpty(values, 8)
	case map[string]any:
		for _, key := range []string{"name", "audienceType", "description"} {
			if values := structuredStrings(item[key]); len(values) > 0 {
				return values
			}
		}
	}
	return nil
}

func inferBusinessType(pages []Page, facts structuredFacts) sourcedValue {
	var localBusinessSignal sourcedValue
	for _, signal := range facts.TypeSignals {
		switch strings.ToLower(signal.Value) {
		case "softwareapplication", "webapplication", "mobileapplication":
			return sourcedValue{Value: "Software / SaaS", SourceURL: signal.SourceURL}
		case "product", "productgroup", "offercatalog":
			return sourcedValue{Value: "E-commerce", SourceURL: signal.SourceURL}
		case "service", "professionalservice":
			return sourcedValue{Value: "Services", SourceURL: signal.SourceURL}
		case "newsmediaorganization", "article", "newsarticle":
			return sourcedValue{
				Value:     "Publisher / content",
				SourceURL: signal.SourceURL,
			}
		case "educationalorganization", "course":
			return sourcedValue{Value: "Education", SourceURL: signal.SourceURL}
		case "medicalorganization":
			return sourcedValue{Value: "Healthcare", SourceURL: signal.SourceURL}
		case "localbusiness":
			localBusinessSignal = signal
		}
	}

	for _, page := range pages {
		text := strings.ToLower(strings.Join([]string{
			page.URL,
			page.Title,
			page.Description,
			strings.Join(page.H1, " "),
			pageContent(page),
			linkText(page.Links),
		}, " "))
		switch {
		case containsAny(text, "add to cart", "buy now", "/cart", "/shop", "/store"):
			return sourcedValue{Value: "E-commerce", SourceURL: pageSourceURL(page, "")}
		case containsAny(text, "software", "platform", "saas", "/pricing", "book a demo"):
			return sourcedValue{
				Value:     "Software / SaaS",
				SourceURL: pageSourceURL(page, ""),
			}
		case containsAny(text, "/services", "/service", "get a quote", "contact us"):
			return sourcedValue{Value: "Services", SourceURL: pageSourceURL(page, "")}
		case containsAny(text, "/news", "/article", "/blog", "/magazine"):
			return sourcedValue{
				Value:     "Publisher / content",
				SourceURL: pageSourceURL(page, ""),
			}
		case containsAny(text, "nonprofit", "foundation", "association"):
			return sourcedValue{
				Value:     "Organization",
				SourceURL: pageSourceURL(page, ""),
			}
		}
	}
	if localBusinessSignal.Value != "" {
		return sourcedValue{Value: "Business website", SourceURL: localBusinessSignal.SourceURL}
	}
	return sourcedValue{Value: "Business website", SourceURL: firstPageURL(pages)}
}

func collectOfferingLabels(pages []Page, limit int) []sourcedValue {
	values := make([]sourcedValue, 0, limit)
	for _, page := range pages {
		role := PageBusinessRole(page)
		if role != BusinessPageOffering {
			continue
		}
		pageURL, err := url.Parse(pageSourceURL(page, ""))
		if err != nil {
			continue
		}
		label := cleanProfileText(titleBrand(page.Title))
		if genericPageLabel(label) &&
			containsBusinessTerm(pageURL.Path, offeringLabelPathTerms) {
			label = cleanProfileText(firstString(page.H1))
		}
		if genericPageLabel(label) {
			label = cleanProfileText(path.Base(pageURL.Path))
		}
		if !genericPageLabel(label) && offeringLabelSupported(page, label) {
			values = appendSourced(
				values,
				sourcedValue{Value: label, SourceURL: pageURL.String()},
			)
		}
		if len(values) >= limit {
			break
		}
	}
	return values
}

func offeringLabelSupported(page Page, label string) bool {
	body := strings.ToLower(strings.Join(
		append(append([]string{}, page.H1...), page.H2...),
		" ",
	) + " " + page.MainText)
	label = strings.ToLower(strings.TrimSpace(label))
	return label != "" && strings.Contains(body, label) &&
		containsBusinessTerm(body, commercialEvidenceTerms)
}

var audiencePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)\b(?:built|designed|made|created)\s+for\s+([^.!?;\n]{2,90})`),
	regexp.MustCompile(`(?i)\b(?:system|platform|software|service|services|solution|solutions)\s+for\s+([^.!?;\n]{2,90})`),
	regexp.MustCompile(`(?:专为|面向|适用于)([^。！？；\n]{2,50})`),
}

var offeringLabelPathTerms = []string{
	"product", "products", "service", "services", "solution", "solutions",
	"category", "categories", "collection", "collections", "catalog",
}

func collectAudienceLabels(pages []Page, limit int) []sourcedValue {
	values := make([]sourcedValue, 0, limit)
	for _, page := range pages {
		content := strings.Join(
			[]string{
				page.Description,
				strings.Join(page.H1, " "),
				strings.Join(page.H2, " "),
			},
			". ",
		)
		for _, pattern := range audiencePatterns {
			for _, match := range pattern.FindAllStringSubmatch(content, -1) {
				if len(match) < 2 {
					continue
				}
				value := trimAudience(match[1])
				if value != "" && audienceLike(value) && !genericPageLabel(value) {
					values = appendSourced(values, sourcedValue{
						Value:     value,
						SourceURL: pageSourceURL(page, ""),
					})
				}
				if len(values) >= limit {
					return values
				}
			}
		}
	}
	return values
}

func collectValuePropositions(pages []Page, limit int) []sourcedValue {
	values := make([]sourcedValue, 0, limit)
	for _, page := range pages {
		role := PageBusinessRole(page)
		if role != BusinessPageHomepage && role != BusinessPageOffering {
			continue
		}
		sourceURL := pageSourceURL(page, "")
		for _, value := range append(append([]string{}, page.H1...), page.Description) {
			value = cleanProfileText(value)
			if genericPageLabel(value) || len(strings.Fields(value)) < 3 {
				continue
			}
			values = appendSourced(values, sourcedValue{
				Value:     value,
				SourceURL: sourceURL,
			})
			if len(values) >= limit {
				return values
			}
		}
	}
	return values
}

func collectUseCases(pages []Page, limit int) []sourcedValue {
	values := make([]sourcedValue, 0, limit)
	for _, page := range pages {
		role := PageBusinessRole(page)
		if role != BusinessPageOffering && role != BusinessPageProof {
			continue
		}
		sourceURL := pageSourceURL(page, "")
		if looksLikeUseCase(page.Description) {
			values = appendSourced(values, sourcedValue{
				Value:     page.Description,
				SourceURL: sourceURL,
			})
		}
		for _, heading := range append(append([]string{}, page.H2...), page.H3...) {
			if !looksLikeUseCase(heading) {
				continue
			}
			values = appendSourced(values, sourcedValue{
				Value:     heading,
				SourceURL: sourceURL,
			})
			if len(values) >= limit {
				return values
			}
		}
	}
	return values
}

func collectContentTopics(pages []Page, limit int) []sourcedValue {
	values := make([]sourcedValue, 0, limit)
	for _, page := range pages {
		if PageBusinessRole(page) != BusinessPageContent {
			continue
		}
		sourceURL := pageSourceURL(page, "")
		label := firstNonEmpty(firstString(page.H1), page.Title)
		if !genericPageLabel(label) {
			values = appendSourced(
				values,
				sourcedValue{Value: label, SourceURL: sourceURL},
			)
		}
		for _, keyword := range strings.FieldsFunc(page.Keywords, func(r rune) bool {
			return r == ',' || r == ';' || r == '，' || r == '；'
		}) {
			values = appendSourced(values, sourcedValue{
				Value:     keyword,
				SourceURL: sourceURL,
			})
			if len(values) >= limit {
				return values
			}
		}
	}
	return values
}

func collectLanguages(pages []Page) []sourcedValue {
	values := make([]sourcedValue, 0, len(pages)*2)
	for _, page := range pages {
		sourceURL := pageSourceURL(page, "")
		values = appendSourced(values, sourcedValue{
			Value:     page.Language,
			SourceURL: sourceURL,
		})
		for _, alternate := range page.Hreflang {
			if strings.EqualFold(strings.TrimSpace(alternate.Language), "x-default") {
				continue
			}
			values = appendSourced(values, sourcedValue{
				Value:     alternate.Language,
				SourceURL: sourceURL,
			})
		}
	}
	return values
}

func collectHreflangMarkets(pages []Page) []sourcedValue {
	values := make([]sourcedValue, 0, len(pages))
	for _, page := range pages {
		sourceURL := pageSourceURL(page, "")
		for _, alternate := range page.Hreflang {
			if market := hreflangMarket(alternate.Language); market != "" {
				values = appendSourced(values, sourcedValue{
					Value:     market,
					SourceURL: sourceURL,
				})
			}
		}
	}
	return values
}

func hreflangMarket(value string) string {
	normalized := strings.ReplaceAll(strings.TrimSpace(value), "_", "-")
	if normalized == "" || strings.EqualFold(normalized, "x-default") {
		return ""
	}
	parts := strings.Split(normalized, "-")
	for index := len(parts) - 1; index > 0; index-- {
		part := parts[index]
		if len(part) == 2 && allASCIIAlpha(part) {
			return strings.ToUpper(part)
		}
		if len(part) == 3 && allASCIIDigit(part) {
			return part
		}
	}
	return ""
}

func allASCIIAlpha(value string) bool {
	for _, char := range value {
		if char < 'A' || char > 'Z' {
			if char < 'a' || char > 'z' {
				return false
			}
		}
	}
	return value != ""
}

func allASCIIDigit(value string) bool {
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return value != ""
}

func collectConversionActions(pages []Page, limit int) []sourcedValue {
	values := make([]sourcedValue, 0, limit)
	for _, page := range pages {
		for _, link := range page.Links {
			text := strings.TrimSpace(link.Text)
			lower := strings.ToLower(text)
			if text != "" && containsAny(
				lower,
				"buy", "shop", "contact", "demo", "quote", "sign up", "signup",
				"get started", "book", "subscribe", "download",
				"申请", "购买", "联系", "咨询", "注册", "订阅", "下载",
			) {
				values = appendSourced(values, sourcedValue{
					Value:     text,
					SourceURL: pageSourceURL(page, ""),
				})
			}
			if len(values) >= limit {
				return values
			}
		}
	}
	return values
}

func collectKeyPages(pages []Page, limit int) []SiteProfileKeyPage {
	result := make([]SiteProfileKeyPage, 0, min(limit, len(pages)))
	seen := make(map[string]struct{})
	for _, page := range pages {
		pageURL := pageSourceURL(page, "")
		if pageURL == "" {
			continue
		}
		if _, exists := seen[pageURL]; exists {
			continue
		}
		seen[pageURL] = struct{}{}
		result = append(result, SiteProfileKeyPage{
			URL:         pageURL,
			Title:       firstNonEmpty(page.Title, firstString(page.H1), pageURL),
			Description: page.Description,
		})
		if len(result) >= limit {
			break
		}
	}
	return result
}

func representativeHomepage(targetURL string, pages []Page) Page {
	index := representativeHomepageIndex(targetURL, pages)
	if index >= 0 {
		return pages[index]
	}
	return Page{URL: targetURL, FinalURL: targetURL, OpenGraph: map[string]string{}}
}

func representativeHomepageIndex(targetURL string, pages []Page) int {
	target, _ := url.Parse(targetURL)
	targetHost := normalizedSiteHostname(target)
	for index, page := range pages {
		pageURL, err := url.Parse(pageSourceURL(page, ""))
		if err == nil && normalizedSiteHostname(pageURL) == targetHost &&
			(pageURL.Path == "" || pageURL.Path == "/") {
			return index
		}
	}
	if len(pages) > 0 {
		return 0
	}
	return -1
}

func normalizedSiteHostname(value *url.URL) string {
	if value == nil {
		return ""
	}
	return strings.TrimPrefix(
		strings.ToLower(strings.TrimSuffix(value.Hostname(), ".")),
		"www.",
	)
}

func pageContent(page Page) string {
	return firstNonEmpty(page.MainText, page.ContentExcerpt)
}

func pageSourceURL(page Page, fallback string) string {
	return firstNonEmpty(page.FinalURL, page.URL, fallback)
}

func firstPageURL(pages []Page) string {
	if len(pages) == 0 {
		return ""
	}
	return pageSourceURL(pages[0], "")
}

func linkText(links []Link) string {
	values := make([]string, 0, len(links)*2)
	for _, link := range links {
		values = append(values, link.Text, link.URL)
	}
	return strings.Join(values, " ")
}

func firstSourced(primary []sourcedValue, fallbacks ...sourcedValue) sourcedValue {
	for _, value := range append(append([]sourcedValue{}, primary...), fallbacks...) {
		value.Value = cleanProfileText(value.Value)
		if value.Value != "" {
			return value
		}
	}
	return sourcedValue{}
}

func appendSourced(values []sourcedValue, candidate sourcedValue) []sourcedValue {
	candidate.Value = cleanProfileText(candidate.Value)
	if candidate.Value == "" {
		return values
	}
	for _, value := range values {
		if strings.EqualFold(value.Value, candidate.Value) {
			return values
		}
	}
	return append(values, candidate)
}

func sourcedStrings(values []sourcedValue, limit int) []string {
	result := make([]string, 0, min(limit, len(values)))
	seen := make(map[string]struct{})
	for _, value := range values {
		key := strings.ToLower(strings.TrimSpace(value.Value))
		if key == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value.Value)
		if len(result) >= limit {
			break
		}
	}
	return result
}

func appendEvidence(
	evidence *[]SiteProfileEvidence,
	field string,
	values []sourcedValue,
	limit int,
) {
	seen := make(map[string]struct{})
	for _, item := range values {
		item.Value = strings.TrimSpace(item.Value)
		if item.Value == "" {
			continue
		}
		key := strings.ToLower(item.Value) + "\x00" + item.SourceURL
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		*evidence = append(*evidence, SiteProfileEvidence{
			Field:     field,
			Value:     item.Value,
			SourceURL: item.SourceURL,
		})
		if len(seen) >= limit {
			return
		}
	}
}

func profileConfidence(profile SiteProfile) float64 {
	confidence := 0.3
	if profile.BusinessName != "" {
		confidence += 0.1
	}
	if profile.BusinessSummary != "" {
		confidence += 0.1
	}
	if profile.BusinessType != "" && profile.BusinessType != "Business website" {
		confidence += 0.1
	}
	if len(profile.ProductsServices) > 0 {
		confidence += 0.1
	}
	if len(profile.TargetAudiences) > 0 {
		confidence += 0.08
	}
	if len(profile.ValuePropositions) > 0 {
		confidence += 0.08
	}
	if len(profile.UseCases) > 0 || len(profile.ContentTopics) > 0 {
		confidence += 0.04
	}
	if profile.SourcePageCount >= 3 {
		confidence += 0.05
	}
	return math.Round(min(confidence, 0.9)*100) / 100
}

func trimAudience(value string) string {
	value = strings.TrimSpace(value)
	lower := strings.ToLower(value)
	cutAt := len(value)
	for _, separator := range []string{
		" to ", " who ", " that ", " with ", " by ", ",", "，",
	} {
		if index := strings.Index(lower, separator); index >= 0 && index < cutAt {
			cutAt = index
		}
	}
	return strings.Trim(strings.TrimSpace(value[:cutAt]), " .,:;，。；")
}

func audienceLike(value string) bool {
	lower := strings.ToLower(value)
	return containsAny(
		lower,
		"team", "teams", "business", "businesses", "company", "companies",
		"organization", "organizations", "developer", "developers", "designer",
		"designers", "marketer", "marketers", "professional", "professionals",
		"customer", "customers", "user", "users", "agency", "agencies",
		"creator", "creators", "student", "students", "patient", "patients",
		"enterprise", "enterprises", "retailer", "retailers", "agent", "agents",
		"团队", "企业", "公司", "组织", "开发者", "设计师", "营销人员", "专业人士",
		"客户", "用户", "机构", "创作者", "学生", "患者", "零售商",
	)
}

func looksLikeUseCase(value string) bool {
	lower := strings.ToLower(cleanProfileText(value))
	return containsAny(
		lower,
		"use case", "solution", "workflow", "automate", "manage", "plan",
		"track", "build", "create", "improve", "reduce", "grow", "align",
		"streamline", "integrate", "collaborate", "report", "analyze",
		"使用场景", "解决方案", "工作流", "自动化", "管理", "规划", "跟踪",
		"创建", "提升", "降低", "增长", "协作", "报告", "分析",
	)
}

func cleanProfileText(value string) string {
	value = cleanText(value)
	words := strings.Fields(value)
	for repeats := 4; repeats >= 2; repeats-- {
		if len(words) < repeats*3 || len(words)%repeats != 0 {
			continue
		}
		chunkSize := len(words) / repeats
		repeated := true
		for repeat := 1; repeat < repeats && repeated; repeat++ {
			for index := 0; index < chunkSize; index++ {
				if !strings.EqualFold(
					words[index],
					words[repeat*chunkSize+index],
				) {
					repeated = false
					break
				}
			}
		}
		if repeated {
			return strings.Join(words[:chunkSize], " ")
		}
	}
	return value
}

var incSuffixPattern = regexp.MustCompile(`(?i)(?:\s*,\s*|\s+)inc\.?\s*$`)

func businessDisplayName(value string) string {
	cleaned := cleanProfileText(value)
	displayName := strings.TrimSpace(incSuffixPattern.ReplaceAllString(cleaned, ""))
	if displayName == "" {
		return cleaned
	}
	return displayName
}

func genericPageLabel(value string) bool {
	normalized := strings.ToLower(cleanProfileText(value))
	switch normalized {
	case "", "home", "homepage", "about", "about us", "products", "product",
		"services", "service", "solutions", "solution", "pricing", "plans",
		"plan", "features", "feature", "blog", "news", "resources", "contact",
		"contact us", "learn more",
		"首页", "关于我们", "产品", "服务", "解决方案", "价格", "博客", "新闻",
		"资源", "联系我们", "了解更多":
		return true
	default:
		return false
	}
}

func titleBrand(value string) string {
	value = strings.TrimSpace(value)
	for _, separator := range []string{" | ", " - ", " – ", " — "} {
		if before, _, found := strings.Cut(value, separator); found {
			return strings.TrimSpace(before)
		}
	}
	return value
}

func hostname(value string) string {
	parsed, err := url.Parse(value)
	if err != nil {
		return value
	}
	return parsed.Hostname()
}

func firstString(values []string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func uniqueNonEmpty(values []string, limit int) []string {
	result := make([]string, 0, min(limit, len(values)))
	seen := make(map[string]struct{})
	for _, value := range values {
		value = strings.TrimSpace(value)
		key := strings.ToLower(value)
		if value == "" {
			continue
		}
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
		if len(result) >= limit {
			break
		}
	}
	return result
}

func containsAny(value string, candidates ...string) bool {
	for _, candidate := range candidates {
		if strings.Contains(value, candidate) {
			return true
		}
	}
	return false
}
