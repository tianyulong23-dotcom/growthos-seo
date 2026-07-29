package crawler

import (
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/gocolly/colly/v2"
)

type Fetcher interface {
	Fetch(context.Context, string) (Resource, error)
}

type FetchOutcome struct {
	Resource Resource
	Err      error
}

type BatchFetcher interface {
	FetchMany(context.Context, []string) []FetchOutcome
}

type StatusChecker interface {
	CheckStatus(context.Context, string) (int, error)
}

type HTTPFetcher struct {
	config   Config
	resolver IPResolver
	jar      http.CookieJar
	limiter  *RequestLimiter
	clientMu sync.Mutex
	clients  map[httpClientKey]*http.Client
}

type httpClientKey struct {
	proxyValue   string
	enforceScope bool
}

const defaultHTTPFetchConcurrency = 5

func NewHTTPFetcher(config Config) (*HTTPFetcher, error) {
	return NewHTTPFetcherWithLimiter(
		config,
		NewRequestLimiter(config.RequestDelay, config.RandomDelay),
	)
}

func NewHTTPFetcherWithLimiter(
	config Config,
	limiter *RequestLimiter,
) (*HTTPFetcher, error) {
	jar, err := cookiejar.New(nil)
	if err != nil {
		return nil, err
	}
	return &HTTPFetcher{
		config:   config,
		resolver: net.DefaultResolver,
		jar:      jar,
		limiter:  limiter,
		clients:  make(map[httpClientKey]*http.Client),
	}, nil
}

func (f *HTTPFetcher) Fetch(ctx context.Context, rawURL string) (Resource, error) {
	target, err := parsedURL(rawURL)
	if err != nil {
		return Resource{}, err
	}
	resolvedIPs, err := resolvePublicURL(ctx, f.resolver, target)
	if err != nil {
		return Resource{}, err
	}
	if err := validateContextScope(ctx, target); err != nil {
		return Resource{}, err
	}

	proxies := uniqueStrings([]string{f.config.PrimaryProxyURL, f.config.FallbackProxyURL})
	if len(proxies) == 0 {
		proxies = []string{""}
	} else if f.config.PrimaryProxyURL == "" {
		proxies = append([]string{""}, proxies...)
	}

	var lastResource Resource
	var lastErr error
	attempts := max(f.config.MaxRetries, len(proxies))
	for attempt := 0; attempt < attempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return Resource{}, err
		}
		proxyURL := proxies[min(attempt, len(proxies)-1)]
		resource, fetchErr := f.fetchOnce(ctx, target, proxyURL, resolvedIPs)
		resource.ProxyURL = proxyURL
		lastResource, lastErr = resource, fetchErr
		if !shouldRetry(resource, fetchErr) {
			return resource, fetchErr
		}
		if attempt+1 < attempts {
			delay := time.Duration(1<<min(attempt, 4)) * time.Second
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return Resource{}, ctx.Err()
			case <-timer.C:
			}
		}
	}
	return lastResource, lastErr
}

func (f *HTTPFetcher) FetchMany(ctx context.Context, rawURLs []string) []FetchOutcome {
	outcomes := make([]FetchOutcome, len(rawURLs))
	semaphore := make(chan struct{}, positiveOrDefault(
		f.config.HTTPConcurrency,
		defaultHTTPFetchConcurrency,
	))
	var group sync.WaitGroup
	for index, rawURL := range rawURLs {
		group.Add(1)
		go func(outcomeIndex int, value string) {
			defer group.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				outcomes[outcomeIndex].Err = ctx.Err()
				return
			}
			outcomes[outcomeIndex].Resource, outcomes[outcomeIndex].Err = f.Fetch(ctx, value)
		}(index, rawURL)
	}
	group.Wait()
	return outcomes
}

func (f *HTTPFetcher) CheckStatus(ctx context.Context, rawURL string) (int, error) {
	target, err := parsedURL(rawURL)
	if err != nil {
		return 0, err
	}
	if err := ValidatePublicURL(ctx, f.resolver, target); err != nil {
		return 0, err
	}
	proxies := uniqueStrings([]string{f.config.PrimaryProxyURL, f.config.FallbackProxyURL})
	if len(proxies) == 0 {
		proxies = []string{""}
	} else if f.config.PrimaryProxyURL == "" {
		proxies = append([]string{""}, proxies...)
	}

	var lastStatus int
	var lastErr error
	attempts := max(f.config.MaxRetries, len(proxies))
	for attempt := 0; attempt < attempts; attempt++ {
		if err := f.limiter.Wait(ctx); err != nil {
			return lastStatus, err
		}
		client, clientErr := f.client(ctx, proxies[min(attempt, len(proxies)-1)], false)
		if clientErr != nil {
			lastErr = clientErr
			continue
		}
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodHead, target.String(), nil)
		if requestErr != nil {
			return 0, requestErr
		}
		request.Header.Set("User-Agent", f.config.UserAgent)
		response, requestErr := client.Do(request)
		if requestErr != nil {
			lastErr = requestErr
			continue
		}
		lastStatus = response.StatusCode
		_ = response.Body.Close()
		if !shouldRetry(Resource{StatusCode: lastStatus}, nil) {
			return lastStatus, nil
		}
	}
	if lastErr != nil {
		return lastStatus, lastErr
	}
	return lastStatus, nil
}

func (f *HTTPFetcher) fetchOnce(
	ctx context.Context,
	target *url.URL,
	proxyValue string,
	resolvedIPs []string,
) (Resource, error) {
	client, err := f.client(ctx, proxyValue, true)
	if err != nil {
		return Resource{}, err
	}
	if err := f.limiter.Wait(ctx); err != nil {
		return Resource{URL: target.String(), FinalURL: target.String()}, err
	}

	redirects := make([]Redirect, 0, 4)
	requestCtx := context.WithValue(ctx, redirectRecorderContextKey{}, &redirects)
	request, err := http.NewRequestWithContext(requestCtx, http.MethodGet, target.String(), nil)
	if err != nil {
		return Resource{}, err
	}
	request.Header.Set("User-Agent", f.config.UserAgent)
	request.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	request.Header.Set("Accept-Language", acceptLanguageFromContext(ctx))
	request.Header.Set("Cache-Control", "no-cache")

	resource := Resource{
		URL:              target.String(),
		FinalURL:         target.String(),
		RenderMode:       "static",
		ResolvedIPs:      append([]string(nil), resolvedIPs...),
		SecurityDecision: "allowed",
		FetchedAt:        time.Now().UTC(),
	}
	response, err := client.Do(request)
	resource.Redirects = append(resource.Redirects, redirects...)
	if err != nil {
		return resource, err
	}
	defer response.Body.Close()

	resource.StatusCode = response.StatusCode
	resource.ContentType = response.Header.Get("Content-Type")
	resource.Header = response.Header.Clone()
	if response.Request != nil && response.Request.URL != nil {
		resource.FinalURL = response.Request.URL.String()
	}
	if !isAllowedCrawlContentType(resource.ContentType) {
		resource.ErrorType = "unsupported_content_type"
		resource.Error = fmt.Sprintf("unsupported content type %q", resource.ContentType)
		return resource, errors.New(resource.Error)
	}

	var reader io.Reader = response.Body
	if f.config.MaxBodyBytes > 0 {
		reader = io.LimitReader(response.Body, int64(f.config.MaxBodyBytes)+1)
	}
	resource.Body, err = io.ReadAll(reader)
	if err != nil {
		return resource, err
	}
	if f.config.MaxBodyBytes > 0 && len(resource.Body) > f.config.MaxBodyBytes {
		resource.Body = resource.Body[:f.config.MaxBodyBytes]
		return resource, fmt.Errorf("response body exceeds %d bytes", f.config.MaxBodyBytes)
	}
	return resource, nil
}

func (f *HTTPFetcher) client(
	_ context.Context,
	proxyValue string,
	enforceScope bool,
) (*http.Client, error) {
	key := httpClientKey{proxyValue: proxyValue, enforceScope: enforceScope}
	f.clientMu.Lock()
	defer f.clientMu.Unlock()
	if client, exists := f.clients[key]; exists {
		return client, nil
	}

	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = false
	transport.MaxIdleConns = 100
	transport.MaxIdleConnsPerHost = positiveOrDefault(
		f.config.HTTPConcurrency,
		defaultHTTPFetchConcurrency,
	)
	transport.Proxy = nil

	trustedProxyHost := ""
	if proxyValue != "" {
		proxyURL, err := url.Parse(proxyValue)
		if err != nil {
			return nil, fmt.Errorf("parse proxy URL: %w", err)
		}
		transport.Proxy = http.ProxyURL(proxyURL)
		trustedProxyHost = proxyURL.Hostname()
	}
	transport.DialContext = f.safeDialer(trustedProxyHost)

	client := &http.Client{
		Transport: transport,
		Jar:       f.jar,
		Timeout:   f.config.RequestTimeout,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 10 {
				return errors.New("too many redirects")
			}
			redirect := Redirect{
				URL:              request.URL.String(),
				SecurityDecision: "blocked",
			}
			if len(via) > 0 && via[len(via)-1].URL != nil {
				redirect.FromURL = via[len(via)-1].URL.String()
			}
			if request.Response != nil {
				redirect.StatusCode = request.Response.StatusCode
			}
			var recordedIndex = -1
			if redirects, ok := request.Context().Value(redirectRecorderContextKey{}).(*[]Redirect); ok {
				*redirects = append(*redirects, redirect)
				recordedIndex = len(*redirects) - 1
			}
			resolvedIPs, err := resolvePublicURL(request.Context(), f.resolver, request.URL)
			if err != nil {
				return err
			}
			if redirects, ok := request.Context().Value(redirectRecorderContextKey{}).(*[]Redirect); ok {
				if recordedIndex >= 0 {
					(*redirects)[recordedIndex].SecurityDecision = "allowed"
					(*redirects)[recordedIndex].ResolvedIPs = resolvedIPs
				}
			}
			if enforceScope {
				if err := validateContextScope(request.Context(), request.URL); err != nil {
					return err
				}
			}
			return nil
		},
	}
	f.clients[key] = client
	return client, nil
}

func (f *HTTPFetcher) safeDialer(trustedProxyHost string) func(context.Context, string, string) (net.Conn, error) {
	dialer := &net.Dialer{Timeout: f.config.RequestTimeout}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		if trustedProxyHost != "" && strings.EqualFold(host, trustedProxyHost) {
			return dialer.DialContext(ctx, network, address)
		}

		addresses, err := f.resolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, resolved := range addresses {
			if !isPublicIP(resolved.IP) {
				return nil, fmt.Errorf("blocked resolved address %s", resolved.IP)
			}
		}
		if len(addresses) == 0 {
			return nil, errors.New("hostname has no IP addresses")
		}
		return dialer.DialContext(ctx, network, net.JoinHostPort(addresses[0].IP.String(), port))
	}
}

func resourceFromColly(requestURL string, response *colly.Response) Resource {
	resource := Resource{
		URL:              requestURL,
		FinalURL:         requestURL,
		RenderMode:       "static",
		SecurityDecision: "allowed",
		FetchedAt:        time.Now().UTC(),
	}
	if response == nil {
		return resource
	}

	resource.StatusCode = response.StatusCode
	resource.Body = slices.Clone(response.Body)
	if response.Request != nil && response.Request.URL != nil {
		resource.FinalURL = response.Request.URL.String()
	}
	if response.Headers != nil {
		resource.Header = make(map[string][]string, len(*response.Headers))
		maps.Copy(resource.Header, *response.Headers)
		resource.ContentType = response.Headers.Get("Content-Type")
	}
	return resource
}

func isAllowedCrawlContentType(value string) bool {
	mediaType := strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
	if mediaType == "" {
		return true
	}
	if strings.HasPrefix(mediaType, "text/") ||
		strings.HasPrefix(mediaType, "image/") {
		return true
	}
	switch mediaType {
	case "application/json",
		"application/ld+json",
		"application/xml",
		"application/xhtml+xml",
		"application/rss+xml",
		"application/atom+xml":
		return true
	default:
		return false
	}
}

func shouldRetry(resource Resource, err error) bool {
	if err != nil && resource.StatusCode == 0 {
		return true
	}
	return resource.StatusCode == http.StatusForbidden ||
		resource.StatusCode == http.StatusTooManyRequests ||
		resource.StatusCode >= http.StatusInternalServerError
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

var _ io.Closer = (*BrowserFetcher)(nil)

type proxyPreferenceContextKey struct{}
type requestLocaleContextKey struct{}
type redirectRecorderContextKey struct{}

type requestLocale struct {
	Language string
	Country  string
}

func withRequestLocale(ctx context.Context, language, country string) context.Context {
	return context.WithValue(ctx, requestLocaleContextKey{}, requestLocale{
		Language: strings.TrimSpace(language),
		Country:  strings.TrimSpace(country),
	})
}

func acceptLanguageFromContext(ctx context.Context) string {
	locale, _ := ctx.Value(requestLocaleContextKey{}).(requestLocale)
	return buildAcceptLanguage(locale.Language, locale.Country)
}

func buildAcceptLanguage(language, country string) string {
	language = strings.ReplaceAll(strings.TrimSpace(language), "_", "-")
	country = strings.ToUpper(strings.TrimSpace(country))
	if language == "" {
		return "en-US,en;q=0.8"
	}

	parts := strings.Split(language, "-")
	primary := strings.ToLower(parts[0])
	values := make([]string, 0, 3)
	if len(parts) == 1 && len(country) == 2 {
		values = append(values, primary+"-"+country)
	} else {
		values = append(values, language)
	}
	if !strings.EqualFold(values[0], language) {
		values = append(values, language)
	}
	if !strings.EqualFold(values[len(values)-1], primary) {
		values = append(values, primary)
	}

	weighted := make([]string, 0, len(values))
	for index, value := range uniqueStrings(values) {
		if index == 0 {
			weighted = append(weighted, value)
			continue
		}
		quality := 1.0 - float64(index)*0.1
		weighted = append(weighted, fmt.Sprintf("%s;q=%.1f", value, quality))
	}
	return strings.Join(weighted, ",")
}

func withPreferredProxy(ctx context.Context, proxyURL string) context.Context {
	return context.WithValue(ctx, proxyPreferenceContextKey{}, proxyURL)
}

func preferredProxyFromContext(ctx context.Context) (string, bool) {
	proxyURL, exists := ctx.Value(proxyPreferenceContextKey{}).(string)
	return proxyURL, exists
}

func positiveOrDefault(value, fallback int) int {
	if value > 0 {
		return value
	}
	return fallback
}
