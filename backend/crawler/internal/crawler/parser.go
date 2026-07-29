package crawler

import (
	"bytes"
	"encoding/json"
	"net/url"
	"regexp"
	"strings"
	"unicode"

	readability "codeberg.org/readeck/go-readability/v2"
	"github.com/PuerkitoBio/goquery"
)

type Parser struct{}

func (Parser) Parse(resource Resource, depth int, discoveredFrom string) (Page, error) {
	document, err := goquery.NewDocumentFromReader(bytes.NewReader(resource.Body))
	if err != nil {
		return Page{}, err
	}

	finalURL := resource.FinalURL
	if finalURL == "" {
		finalURL = resource.URL
	}
	pageURL, err := url.Parse(finalURL)
	if err != nil {
		return Page{}, err
	}

	structuredData := extractStructuredData(document)
	robots := metaContent(document, "name", "robots")
	page := Page{
		URL:              resource.URL,
		FinalURL:         finalURL,
		StatusCode:       resource.StatusCode,
		ContentType:      resource.ContentType,
		Title:            cleanText(document.Find("title").First().Text()),
		Description:      metaContent(document, "name", "description"),
		Canonical:        linkHref(document, "canonical"),
		Language:         strings.TrimSpace(document.Find("html").First().AttrOr("lang", "")),
		Charset:          extractCharset(document),
		MetaTags:         extractMetaTags(document),
		Viewport:         metaContent(document, "name", "viewport"),
		Robots:           robots,
		Author:           metaContent(document, "name", "author"),
		Keywords:         metaContent(document, "name", "keywords"),
		Generator:        metaContent(document, "name", "generator"),
		ThemeColor:       metaContent(document, "name", "theme-color"),
		FaviconURL:       extractFaviconURL(document, pageURL),
		ManifestURL:      extractManifestURL(document, pageURL),
		LogoURL:          extractOfficialLogoURL(document, structuredData, pageURL),
		Images:           extractImages(document, pageURL),
		Hreflang:         extractHreflang(document, pageURL),
		OpenGraph:        extractOpenGraph(document),
		TwitterTags:      extractTwitterTags(document),
		StructuredData:   structuredData,
		SchemaMicrodata:  extractSchemaMicrodata(document),
		Analytics:        extractAnalytics(string(resource.Body)),
		Rendered:         resource.Rendered,
		ResponseTimeMS:   resource.ResponseTimeMS,
		SizeBytes:        resource.SizeBytes,
		Redirects:        append([]Redirect(nil), resource.Redirects...),
		ResolvedIPs:      append([]string(nil), resource.ResolvedIPs...),
		SecurityDecision: resource.SecurityDecision,
		RobotsDecision:   resource.RobotsDecision,
		RenderMode:       resource.RenderMode,
		NoIndex:          strings.Contains(strings.ToLower(robots), "noindex"),
		Error:            resource.Error,
		ErrorType:        resource.ErrorType,
		Depth:            depth,
		DiscoveredFrom:   discoveredFrom,
		FetchedAt:        resource.FetchedAt,
	}

	document.Find("h1").Each(func(_ int, selection *goquery.Selection) {
		if text := selectionText(selection); text != "" {
			page.H1 = append(page.H1, text)
		}
	})
	document.Find("h2").Each(func(_ int, selection *goquery.Selection) {
		if text := selectionText(selection); text != "" {
			page.H2 = append(page.H2, text)
		}
	})
	document.Find("h3").Each(func(_ int, selection *goquery.Selection) {
		if text := selectionText(selection); text != "" {
			page.H3 = append(page.H3, text)
		}
	})
	document.Find("h1,h2,h3,h4,h5,h6").Each(func(_ int, selection *goquery.Selection) {
		if text := selectionText(selection); text != "" {
			page.Headings = append(page.Headings, text)
		}
	})
	document.Find("a[href]").Each(func(_ int, selection *goquery.Selection) {
		href, ok := selection.Attr("href")
		if !ok {
			return
		}
		resolved, err := pageURL.Parse(strings.TrimSpace(href))
		if err != nil || (resolved.Scheme != "http" && resolved.Scheme != "https") {
			return
		}
		placement := linkPlacement(selection)
		internal := sameSite(pageURL, resolved)
		page.Links = append(page.Links, Link{
			URL:          resolved.String(),
			Text:         selectionText(selection),
			Rel:          cleanText(selection.AttrOr("rel", "")),
			InNavigation: placement == "navigation",
			IsInternal:   internal,
			TargetDomain: resolved.Host,
			Placement:    placement,
		})
		if internal {
			page.InternalLinkCount++
		} else {
			page.ExternalLinkCount++
		}
	})
	for _, image := range page.Images {
		target, err := url.Parse(image.Src)
		if err != nil {
			continue
		}
		page.Links = append(page.Links, Link{
			URL:          image.Src,
			Text:         image.Alt,
			IsInternal:   sameSite(pageURL, target),
			TargetDomain: target.Host,
			Placement:    "image",
		})
	}

	if article, parseErr := readability.FromReader(bytes.NewReader(resource.Body), pageURL); parseErr == nil {
		var text, html strings.Builder
		if article.RenderText(&text) == nil {
			page.MainText = cleanText(text.String())
		}
		if article.RenderHTML(&html) == nil {
			page.MainHTML = html.String()
		}
	}
	if page.MainText == "" {
		page.MainText = cleanText(document.Find("body").Text())
	}
	page.WordCount = countDocumentWords(document.Text())
	return page, nil
}

func countDocumentWords(value string) int {
	count := 0
	inWord := false
	for _, current := range value {
		wordCharacter := current == '_' || unicode.IsLetter(current) || unicode.IsDigit(current)
		if wordCharacter && !inWord {
			count++
		}
		inWord = wordCharacter
	}
	return count
}

func extractCharset(document *goquery.Document) string {
	if value := strings.TrimSpace(document.Find("meta[charset]").First().AttrOr("charset", "")); value != "" {
		return value
	}
	content := document.Find("meta[http-equiv]").FilterFunction(
		func(_ int, selection *goquery.Selection) bool {
			return strings.EqualFold(selection.AttrOr("http-equiv", ""), "content-type")
		},
	).First().AttrOr("content", "")
	for _, part := range strings.Split(content, ";") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && strings.EqualFold(key, "charset") {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func extractAnalytics(html string) map[string]any {
	analytics := map[string]any{
		"google_analytics": false,
		"gtag":             false,
		"ga4_id":           "",
		"gtm_id":           "",
		"facebook_pixel":   false,
		"hotjar":           false,
		"mixpanel":         false,
	}
	lowerHTML := strings.ToLower(html)
	ga4Pattern := regexp.MustCompile(`G-[A-Z0-9]{10}`)
	if match := ga4Pattern.FindString(strings.ToUpper(html)); match != "" {
		analytics["ga4_id"] = match
		analytics["gtag"] = true
	}
	gtmPattern := regexp.MustCompile(`GTM-[A-Z0-9]+`)
	if match := gtmPattern.FindString(strings.ToUpper(html)); match != "" {
		analytics["gtm_id"] = match
	}
	for _, signal := range []string{
		"gtag(",
		"ga(",
		"googleanalyticsobject",
		"google-analytics.com",
		"googletagmanager.com",
	} {
		if strings.Contains(lowerHTML, signal) {
			analytics["google_analytics"] = true
			break
		}
	}
	analytics["facebook_pixel"] = strings.Contains(lowerHTML, "fbq(") ||
		strings.Contains(lowerHTML, "facebook.com/tr")
	analytics["hotjar"] = strings.Contains(lowerHTML, "hotjar.com") ||
		strings.Contains(lowerHTML, "hj(")
	analytics["mixpanel"] = strings.Contains(lowerHTML, "mixpanel.com") ||
		strings.Contains(lowerHTML, "mixpanel.track")
	return analytics
}

func extractMetaTags(document *goquery.Document) map[string]string {
	result := make(map[string]string)
	document.Find("meta").Each(func(_ int, selection *goquery.Selection) {
		key := strings.TrimSpace(selection.AttrOr("name", ""))
		if key == "" {
			key = strings.TrimSpace(selection.AttrOr("property", ""))
		}
		content := cleanText(selection.AttrOr("content", ""))
		if key != "" && content != "" {
			result[strings.ToLower(key)] = content
		}
	})
	if len(result) == 0 {
		return nil
	}
	return result
}

func metaContent(document *goquery.Document, attribute, value string) string {
	selector := "meta[" + attribute + "]"
	var content string
	document.Find(selector).EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if strings.EqualFold(selection.AttrOr(attribute, ""), value) {
			content = cleanText(selection.AttrOr("content", ""))
			return false
		}
		return true
	})
	return content
}

func linkHref(document *goquery.Document, rel string) string {
	var value string
	document.Find("link[rel][href]").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if strings.EqualFold(selection.AttrOr("rel", ""), rel) {
			value = strings.TrimSpace(selection.AttrOr("href", ""))
			return false
		}
		return true
	})
	return value
}

func extractFaviconURL(document *goquery.Document, base *url.URL) string {
	type iconCandidate struct {
		url   string
		score int
	}
	var candidates []iconCandidate
	document.Find("link[rel][href]").Each(func(_ int, selection *goquery.Selection) {
		rel := strings.ToLower(selection.AttrOr("rel", ""))
		relTokens := strings.Fields(rel)
		isIcon := false
		score := 0
		for _, token := range relTokens {
			switch token {
			case "icon":
				isIcon = true
				score += 20
			case "shortcut":
				score += 5
			case "apple-touch-icon":
				isIcon = true
				score += 10
			case "mask-icon":
				isIcon = true
				score += 5
			}
		}
		if !isIcon {
			return
		}
		resolved, err := base.Parse(strings.TrimSpace(selection.AttrOr("href", "")))
		if err != nil || (resolved.Scheme != "http" && resolved.Scheme != "https") {
			return
		}
		iconType := strings.ToLower(selection.AttrOr("type", ""))
		if strings.Contains(iconType, "svg") {
			score += 4
		} else if strings.Contains(iconType, "png") {
			score += 3
		}
		candidates = append(candidates, iconCandidate{url: resolved.String(), score: score})
	})
	if len(candidates) == 0 {
		return ""
	}
	best := candidates[0]
	for _, candidate := range candidates[1:] {
		if candidate.score > best.score {
			best = candidate
		}
	}
	return best.url
}

func extractManifestURL(document *goquery.Document, base *url.URL) string {
	var value string
	document.Find("link[rel][href]").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		if !relContains(selection.AttrOr("rel", ""), "manifest") {
			return true
		}
		value = resolveHTTPURL(base, selection.AttrOr("href", ""))
		return value == ""
	})
	return value
}

func extractOfficialLogoURL(
	document *goquery.Document,
	structuredData []json.RawMessage,
	base *url.URL,
) string {
	for _, raw := range structuredData {
		var value any
		if json.Unmarshal(raw, &value) != nil {
			continue
		}
		if logo := structuredLogoURL(value); logo != "" {
			if resolved := resolveHTTPURL(base, logo); resolved != "" {
				return resolved
			}
		}
	}

	var value string
	document.Find("img[src],img[data-src]").EachWithBreak(func(_ int, selection *goquery.Selection) bool {
		signals := strings.ToLower(strings.Join([]string{
			selection.AttrOr("itemprop", ""),
			selection.AttrOr("id", ""),
			selection.AttrOr("class", ""),
			selection.AttrOr("alt", ""),
		}, " "))
		if !strings.Contains(signals, "logo") && !strings.Contains(signals, "brand") {
			return true
		}
		value = resolveHTTPURL(
			base,
			firstNonEmpty(
				selection.AttrOr("src", ""),
				selection.AttrOr("data-src", ""),
			),
		)
		return value == ""
	})
	return value
}

func structuredLogoURL(value any) string {
	switch node := value.(type) {
	case []any:
		for _, child := range node {
			if logo := structuredLogoURL(child); logo != "" {
				return logo
			}
		}
	case map[string]any:
		if isOrganizationSchemaType(structuredStrings(node["@type"])) {
			if logo := structuredImageURL(node["logo"]); logo != "" {
				return logo
			}
		}
		for _, child := range node {
			switch child.(type) {
			case []any, map[string]any:
				if logo := structuredLogoURL(child); logo != "" {
					return logo
				}
			}
		}
	}
	return ""
}

func structuredImageURL(value any) string {
	switch item := value.(type) {
	case string:
		return strings.TrimSpace(item)
	case []any:
		for _, child := range item {
			if value := structuredImageURL(child); value != "" {
				return value
			}
		}
	case map[string]any:
		return firstNonEmpty(
			structuredText(item, "contentUrl"),
			structuredText(item, "url"),
		)
	}
	return ""
}

func isOrganizationSchemaType(values []string) bool {
	for _, value := range values {
		switch strings.ToLower(value) {
		case "organization", "corporation", "brand", "localbusiness",
			"professionalservice", "newsmediaorganization",
			"educationalorganization", "medicalorganization":
			return true
		}
	}
	return false
}

func resolveHTTPURL(base *url.URL, raw string) string {
	resolved, err := base.Parse(strings.TrimSpace(raw))
	if err != nil || (resolved.Scheme != "http" && resolved.Scheme != "https") {
		return ""
	}
	return resolved.String()
}

func extractOpenGraph(document *goquery.Document) map[string]string {
	result := make(map[string]string)
	document.Find("meta[property^='og:']").Each(func(_ int, selection *goquery.Selection) {
		property := strings.TrimSpace(selection.AttrOr("property", ""))
		content := cleanText(selection.AttrOr("content", ""))
		if property != "" && content != "" {
			result[property] = content
		}
	})
	if len(result) == 0 {
		return nil
	}
	return result
}

func extractTwitterTags(document *goquery.Document) map[string]string {
	result := make(map[string]string)
	document.Find("meta").Each(func(_ int, selection *goquery.Selection) {
		key := strings.TrimSpace(selection.AttrOr("name", ""))
		if key == "" {
			key = strings.TrimSpace(selection.AttrOr("property", ""))
		}
		if len(key) <= len("twitter:") || !strings.EqualFold(key[:len("twitter:")], "twitter:") {
			return
		}
		content := cleanText(selection.AttrOr("content", ""))
		if content != "" {
			result[strings.ToLower(key[len("twitter:"):])] = content
		}
	})
	if len(result) == 0 {
		return nil
	}
	return result
}

func extractStructuredData(document *goquery.Document) []json.RawMessage {
	var result []json.RawMessage
	document.Find("script[type='application/ld+json']").Each(func(_ int, selection *goquery.Selection) {
		value := strings.TrimSpace(selection.Text())
		if value != "" && json.Valid([]byte(value)) {
			result = append(result, json.RawMessage(value))
		}
	})
	return result
}

func extractImages(document *goquery.Document, base *url.URL) []SEOImage {
	var result []SEOImage
	document.Find("img").Each(func(_ int, selection *goquery.Selection) {
		src := strings.TrimSpace(selection.AttrOr("src", ""))
		if src == "" {
			return
		}
		resolved, err := base.Parse(src)
		if err != nil || (resolved.Scheme != "http" && resolved.Scheme != "https") {
			return
		}
		result = append(result, SEOImage{
			Src:     resolved.String(),
			Alt:     cleanText(selection.AttrOr("alt", "")),
			Title:   cleanText(selection.AttrOr("title", "")),
			Width:   strings.TrimSpace(selection.AttrOr("width", "")),
			Height:  strings.TrimSpace(selection.AttrOr("height", "")),
			Loading: strings.TrimSpace(selection.AttrOr("loading", "")),
		})
	})
	return result
}

func extractHreflang(document *goquery.Document, base *url.URL) []HreflangLink {
	var result []HreflangLink
	document.Find("link[rel][hreflang][href]").Each(func(_ int, selection *goquery.Selection) {
		if !relContains(selection.AttrOr("rel", ""), "alternate") {
			return
		}
		language := strings.TrimSpace(selection.AttrOr("hreflang", ""))
		resolved, err := base.Parse(strings.TrimSpace(selection.AttrOr("href", "")))
		if language == "" || err != nil ||
			(resolved.Scheme != "http" && resolved.Scheme != "https") {
			return
		}
		result = append(result, HreflangLink{Language: language, URL: resolved.String()})
	})
	return result
}

func extractSchemaMicrodata(document *goquery.Document) []SchemaMicrodata {
	var result []SchemaMicrodata
	document.Find("[itemscope]").Each(func(_ int, item *goquery.Selection) {
		properties := make(map[string]string)
		item.Find("[itemprop]").Each(func(_ int, property *goquery.Selection) {
			name := strings.TrimSpace(property.AttrOr("itemprop", ""))
			if name == "" {
				return
			}
			value := firstAttribute(property, "content", "href", "src", "datetime")
			if value == "" {
				value = cleanText(property.Text())
			}
			if value == "" {
				return
			}
			if previous := properties[name]; previous != "" {
				properties[name] = previous + ", " + value
			} else {
				properties[name] = value
			}
		})
		result = append(result, SchemaMicrodata{
			Type:       strings.TrimSpace(item.AttrOr("itemtype", "")),
			Properties: properties,
		})
	})
	return result
}

func firstAttribute(selection *goquery.Selection, names ...string) string {
	for _, name := range names {
		if value := cleanText(selection.AttrOr(name, "")); value != "" {
			return value
		}
	}
	return ""
}

func relContains(value, target string) bool {
	for _, token := range strings.Fields(value) {
		if strings.EqualFold(token, target) {
			return true
		}
	}
	return false
}

func linkPlacement(selection *goquery.Selection) string {
	placement := "body"
	selection.Parents().EachWithBreak(func(_ int, parent *goquery.Selection) bool {
		name := goquery.NodeName(parent)
		classes := strings.ToLower(parent.AttrOr("class", ""))
		id := strings.ToLower(parent.AttrOr("id", ""))
		switch {
		case name == "footer",
			strings.Contains(classes, "footer"),
			strings.Contains(id, "footer"):
			placement = "footer"
			return false
		case name == "nav",
			name == "header",
			strings.Contains(classes, "nav"),
			strings.Contains(classes, "menu"),
			strings.Contains(classes, "header"),
			strings.Contains(id, "nav"),
			strings.Contains(id, "menu"),
			strings.Contains(id, "header"):
			placement = "navigation"
			return false
		default:
			return true
		}
	})
	return placement
}

func sameSite(left, right *url.URL) bool {
	leftHost := strings.TrimPrefix(strings.ToLower(left.Hostname()), "www.")
	rightHost := strings.TrimPrefix(strings.ToLower(right.Hostname()), "www.")
	return leftHost != "" && leftHost == rightHost
}

func cleanText(value string) string {
	return strings.Join(strings.Fields(value), " ")
}

func selectionText(selection *goquery.Selection) string {
	parts := make([]string, 0, selection.Contents().Length())
	var collect func(*goquery.Selection)
	collect = func(current *goquery.Selection) {
		current.Contents().Each(func(_ int, child *goquery.Selection) {
			if goquery.NodeName(child) == "#text" {
				if value := cleanText(child.Text()); value != "" {
					parts = append(parts, value)
				}
				return
			}
			collect(child)
		})
	}
	collect(selection)
	return cleanText(strings.Join(parts, " "))
}
