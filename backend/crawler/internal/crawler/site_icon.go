package crawler

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type webManifest struct {
	Icons []webManifestIcon `json:"icons"`
}

type webManifestIcon struct {
	Src     string `json:"src"`
	Sizes   string `json:"sizes"`
	Type    string `json:"type"`
	Purpose string `json:"purpose"`
}

type SiteIcon struct {
	URL         string
	ContentType string
	Body        []byte
}

func resolveSiteIcon(ctx context.Context, fetcher Fetcher, pages []Page) SiteIcon {
	if fetcher == nil || len(pages) == 0 {
		return SiteIcon{}
	}
	ordered := orderedBrandPages(pages)

	for _, page := range ordered {
		if icon := validatedImage(ctx, fetcher, page.FaviconURL); icon.URL != "" {
			return icon
		}
	}
	for _, page := range ordered {
		if icon := manifestIcon(ctx, fetcher, page.ManifestURL); icon.URL != "" {
			return icon
		}
	}

	homepageURL, err := url.Parse(pageSourceURL(ordered[0], ""))
	if err == nil {
		if icon := validatedImage(
			ctx,
			fetcher,
			homepageURL.ResolveReference(&url.URL{Path: "/favicon.ico"}).String(),
		); icon.URL != "" {
			return icon
		}
	}

	for _, page := range ordered {
		if icon := validatedLogo(ctx, fetcher, page.LogoURL); icon.URL != "" {
			return icon
		}
	}
	return SiteIcon{}
}

func orderedBrandPages(pages []Page) []Page {
	ordered := append([]Page(nil), pages...)
	for index, page := range ordered {
		pageURL, err := url.Parse(pageSourceURL(page, ""))
		if err != nil || (pageURL.Path != "" && pageURL.Path != "/") {
			continue
		}
		if index > 0 {
			ordered[0], ordered[index] = ordered[index], ordered[0]
		}
		break
	}
	return ordered
}

func manifestIcon(ctx context.Context, fetcher Fetcher, manifestURL string) SiteIcon {
	manifestURL = strings.TrimSpace(manifestURL)
	if manifestURL == "" {
		return SiteIcon{}
	}
	resource, err := fetcher.Fetch(ctx, manifestURL)
	if err != nil || resource.StatusCode < 200 || resource.StatusCode >= 300 {
		return SiteIcon{}
	}
	var manifest webManifest
	if json.Unmarshal(resource.Body, &manifest) != nil {
		return SiteIcon{}
	}
	base, err := url.Parse(firstNonEmpty(resource.FinalURL, manifestURL))
	if err != nil {
		return SiteIcon{}
	}

	icons := append([]webManifestIcon(nil), manifest.Icons...)
	for len(icons) > 0 {
		bestIndex := 0
		for index := 1; index < len(icons); index++ {
			if manifestIconScore(icons[index]) > manifestIconScore(icons[bestIndex]) {
				bestIndex = index
			}
		}
		best := icons[bestIndex]
		icons = append(icons[:bestIndex], icons[bestIndex+1:]...)
		candidate := resolveHTTPURL(base, best.Src)
		if icon := validatedImage(ctx, fetcher, candidate); icon.URL != "" {
			return icon
		}
	}
	return SiteIcon{}
}

func manifestIconScore(icon webManifestIcon) int {
	score := 0
	if strings.Contains(strings.ToLower(icon.Type), "svg") {
		score += 4096
	}
	for _, value := range strings.Fields(strings.ToLower(icon.Sizes)) {
		parts := strings.Split(value, "x")
		if len(parts) != 2 {
			continue
		}
		width, widthErr := strconv.Atoi(parts[0])
		height, heightErr := strconv.Atoi(parts[1])
		if widthErr == nil && heightErr == nil {
			score = max(score, min(width, height))
		}
	}
	if strings.Contains(strings.ToLower(icon.Purpose), "maskable") {
		score += 32
	}
	return score
}

func validatedImage(ctx context.Context, fetcher Fetcher, rawURL string) SiteIcon {
	resource, finalURL := fetchImageResource(ctx, fetcher, rawURL)
	if finalURL == "" || !isImageResource(resource) {
		return SiteIcon{}
	}
	return siteIconFromResource(resource, finalURL)
}

func validatedLogo(ctx context.Context, fetcher Fetcher, rawURL string) SiteIcon {
	resource, finalURL := fetchImageResource(ctx, fetcher, rawURL)
	if finalURL == "" || !isImageResource(resource) || !hasIconLikeAspectRatio(resource) {
		return SiteIcon{}
	}
	return siteIconFromResource(resource, finalURL)
}

func siteIconFromResource(resource Resource, finalURL string) SiteIcon {
	contentType := strings.TrimSpace(resource.ContentType)
	if mediaType, _, err := mime.ParseMediaType(contentType); err == nil {
		contentType = mediaType
	}
	if !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		contentType = http.DetectContentType(resource.Body)
	}
	return SiteIcon{
		URL:         finalURL,
		ContentType: contentType,
		Body:        append([]byte(nil), resource.Body...),
	}
}

func fetchImageResource(
	ctx context.Context,
	fetcher Fetcher,
	rawURL string,
) (Resource, string) {
	rawURL = strings.TrimSpace(rawURL)
	if rawURL == "" {
		return Resource{}, ""
	}
	resource, err := fetcher.Fetch(ctx, rawURL)
	if err != nil || resource.StatusCode < 200 || resource.StatusCode >= 300 {
		return Resource{}, ""
	}
	return resource, firstNonEmpty(resource.FinalURL, rawURL)
}

func isImageResource(resource Resource) bool {
	contentType := strings.TrimSpace(resource.ContentType)
	if mediaType, _, err := mime.ParseMediaType(contentType); err == nil &&
		strings.HasPrefix(strings.ToLower(mediaType), "image/") {
		return true
	}
	return strings.HasPrefix(
		strings.ToLower(http.DetectContentType(resource.Body)),
		"image/",
	)
}

func hasIconLikeAspectRatio(resource Resource) bool {
	if strings.Contains(strings.ToLower(resource.ContentType), "svg") ||
		bytes.Contains(resource.Body[:min(len(resource.Body), 256)], []byte("<svg")) {
		width, height, ok := svgDimensions(resource.Body)
		return ok && iconLikeRatio(width, height)
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(resource.Body))
	return err == nil && iconLikeRatio(float64(config.Width), float64(config.Height))
}

func svgDimensions(body []byte) (float64, float64, bool) {
	decoder := xml.NewDecoder(bytes.NewReader(body))
	for {
		token, err := decoder.Token()
		if err != nil {
			return 0, 0, false
		}
		start, ok := token.(xml.StartElement)
		if !ok || !strings.EqualFold(start.Name.Local, "svg") {
			continue
		}
		attributes := make(map[string]string, len(start.Attr))
		for _, attribute := range start.Attr {
			attributes[strings.ToLower(attribute.Name.Local)] = attribute.Value
		}
		if viewBox := strings.Fields(attributes["viewbox"]); len(viewBox) == 4 {
			width, widthErr := strconv.ParseFloat(viewBox[2], 64)
			height, heightErr := strconv.ParseFloat(viewBox[3], 64)
			if widthErr == nil && heightErr == nil {
				return width, height, width > 0 && height > 0
			}
		}
		width, widthErr := numericDimension(attributes["width"])
		height, heightErr := numericDimension(attributes["height"])
		return width, height, widthErr == nil && heightErr == nil && width > 0 && height > 0
	}
}

func numericDimension(value string) (float64, error) {
	value = strings.TrimSpace(value)
	end := 0
	for end < len(value) &&
		((value[end] >= '0' && value[end] <= '9') || value[end] == '.') {
		end++
	}
	return strconv.ParseFloat(value[:end], 64)
}

func iconLikeRatio(width, height float64) bool {
	if width <= 0 || height <= 0 {
		return false
	}
	ratio := width / height
	return ratio >= 0.75 && ratio <= 1.3334
}
