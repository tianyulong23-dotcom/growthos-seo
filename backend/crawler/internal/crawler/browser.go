package crawler

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/PuerkitoBio/goquery"
	"github.com/go-rod/rod"
	"github.com/go-rod/rod/lib/launcher"
	"github.com/go-rod/rod/lib/proto"
	"github.com/go-rod/stealth"
)

type BrowserFetcher struct {
	config   Config
	resolver IPResolver
	limiter  *RequestLimiter
	mu       sync.Mutex
	sessions map[string]browserSession
}

type browserSession struct {
	browser  *rod.Browser
	launcher *launcher.Launcher
}

func NewBrowserFetcher(config Config) *BrowserFetcher {
	return NewBrowserFetcherWithLimiter(
		config,
		NewRequestLimiter(config.RequestDelay, config.RandomDelay),
	)
}

func NewBrowserFetcherWithLimiter(
	config Config,
	limiter *RequestLimiter,
) *BrowserFetcher {
	return &BrowserFetcher{
		config:   config,
		resolver: net.DefaultResolver,
		limiter:  limiter,
		sessions: make(map[string]browserSession),
	}
}

func PrepareBrowser(ctx context.Context, config *Config) error {
	if !config.BrowserEnabled || config.BrowserExecutable != "" {
		return nil
	}

	browser := launcher.NewBrowser()
	browser.Context = ctx
	if config.BrowserCacheDir != "" {
		browser.RootDir = config.BrowserCacheDir
	}
	executable, err := browser.Get()
	if err != nil {
		return fmt.Errorf("prepare crawler browser: %w", err)
	}
	config.BrowserExecutable = executable
	return nil
}

func (f *BrowserFetcher) Fetch(ctx context.Context, rawURL string) (Resource, error) {
	if !f.config.BrowserEnabled {
		return Resource{}, errors.New("browser fetching is disabled")
	}
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

	proxyURL, exists := preferredProxyFromContext(ctx)
	if !exists {
		proxyURL = f.config.PrimaryProxyURL
		if proxyURL == "" {
			proxyURL = f.config.FallbackProxyURL
		}
	}
	browser, err := f.getBrowser(ctx, proxyURL)
	if err != nil {
		return Resource{}, err
	}
	page, err := stealth.Page(browser.Context(ctx))
	if err != nil {
		return Resource{}, err
	}
	defer page.Close()

	page = page.Timeout(f.config.BrowserTimeout)
	router, blocked := f.safeRequestRouter(ctx, page)
	defer router.Stop()
	go router.Run()

	if err := f.limiter.Wait(ctx); err != nil {
		return Resource{}, err
	}
	var navigationResponse *proto.NetworkResponse
	waitResponse := page.EachEvent(func(event *proto.NetworkResponseReceived) bool {
		if event.Type != proto.NetworkResourceTypeDocument ||
			event.FrameID != page.FrameID ||
			event.Response == nil {
			return false
		}
		navigationResponse = event.Response
		return true
	})
	if err := page.Navigate(rawURL); err != nil {
		return Resource{}, preferBlockedRequestError(err, blocked)
	}
	waitResponse()
	if err := page.WaitLoad(); err != nil {
		return Resource{}, preferBlockedRequestError(err, blocked)
	}
	if err := waitForContext(ctx, f.config.BrowserWait); err != nil {
		return Resource{}, err
	}
	if err := blockedRequestError(blocked); err != nil {
		return Resource{}, err
	}

	body, err := page.HTML()
	if err != nil {
		return Resource{}, err
	}
	if len(body) > f.config.MaxBodyBytes {
		return Resource{}, errors.New("rendered page exceeds maximum body size")
	}
	info, err := page.Info()
	if err != nil {
		return Resource{}, err
	}
	finalURL, err := url.Parse(info.URL)
	if err != nil {
		return Resource{}, fmt.Errorf("parse rendered final URL: %w", err)
	}
	finalResolvedIPs, err := resolvePublicURL(ctx, f.resolver, finalURL)
	if err != nil {
		return Resource{}, fmt.Errorf("blocked rendered final URL: %w", err)
	}
	if err := validateContextScope(ctx, finalURL); err != nil {
		return Resource{}, fmt.Errorf("blocked rendered final URL: %w", err)
	}

	statusCode := 0
	contentType := "text/html; charset=utf-8"
	if navigationResponse != nil {
		statusCode = navigationResponse.Status
		if strings.TrimSpace(navigationResponse.MIMEType) != "" {
			contentType = navigationResponse.MIMEType
		}
	}
	return Resource{
		URL:              rawURL,
		FinalURL:         info.URL,
		StatusCode:       statusCode,
		ContentType:      contentType,
		Body:             []byte(body),
		Rendered:         true,
		RenderMode:       "browser",
		ProxyURL:         proxyURL,
		SecurityDecision: "allowed",
		ResolvedIPs:      uniqueStrings(append(resolvedIPs, finalResolvedIPs...)),
		FetchedAt:        time.Now().UTC(),
	}, nil
}

func (f *BrowserFetcher) safeRequestRouter(
	ctx context.Context,
	page *rod.Page,
) (*rod.HijackRouter, <-chan error) {
	router := page.HijackRequests()
	blocked := make(chan error, 1)
	router.MustAdd("*", func(request *rod.Hijack) {
		target := request.Request.URL()
		if target == nil || (target.Scheme != "http" && target.Scheme != "https") {
			request.ContinueRequest(&proto.FetchContinueRequest{})
			return
		}
		if err := ValidatePublicURL(ctx, f.resolver, target); err != nil {
			select {
			case blocked <- fmt.Errorf("blocked browser request %s: %w", target.Redacted(), err):
			default:
			}
			request.Response.Fail(proto.NetworkErrorReasonBlockedByClient)
			return
		}
		if request.Request.IsNavigation() {
			if err := validateContextScope(ctx, target); err != nil {
				select {
				case blocked <- fmt.Errorf("blocked browser navigation %s: %w", target.Redacted(), err):
				default:
				}
				request.Response.Fail(proto.NetworkErrorReasonBlockedByClient)
				return
			}
		}
		request.ContinueRequest(&proto.FetchContinueRequest{})
	})
	return router, blocked
}

func preferBlockedRequestError(fallback error, blocked <-chan error) error {
	if err := blockedRequestError(blocked); err != nil {
		return err
	}
	return fallback
}

func blockedRequestError(blocked <-chan error) error {
	select {
	case err := <-blocked:
		return err
	default:
		return nil
	}
}

func (f *BrowserFetcher) getBrowser(ctx context.Context, proxyURL string) (*rod.Browser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if session, exists := f.sessions[proxyURL]; exists {
		return session.browser, nil
	}

	browserLauncher := launcher.New().Context(ctx).HeadlessNew(true)
	if f.config.BrowserExecutable != "" {
		browserLauncher = browserLauncher.Bin(f.config.BrowserExecutable)
	}
	if proxyURL != "" {
		browserLauncher = browserLauncher.Proxy(proxyURL)
	}
	controlURL, err := browserLauncher.Launch()
	if err != nil {
		return nil, err
	}
	browser := rod.New().ControlURL(controlURL).Context(ctx)
	if err := browser.Connect(); err != nil {
		browserLauncher.Cleanup()
		return nil, err
	}

	f.sessions[proxyURL] = browserSession{
		browser:  browser,
		launcher: browserLauncher,
	}
	return browser, nil
}

func (f *BrowserFetcher) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	var closeErr error
	for proxyURL, session := range f.sessions {
		if err := session.browser.Close(); err != nil && closeErr == nil {
			closeErr = err
		}
		session.launcher.Cleanup()
		delete(f.sessions, proxyURL)
	}
	return closeErr
}

type HybridFetcher struct {
	HTTP               Fetcher
	Browser            Fetcher
	Mode               RenderingMode
	HTTPConcurrency    int
	BrowserConcurrency int
}

func (f HybridFetcher) Fetch(ctx context.Context, rawURL string) (Resource, error) {
	resource, httpErr := f.HTTP.Fetch(ctx, rawURL)
	mode := f.Mode
	if mode == "" {
		mode = RenderingAuto
	}
	if f.Browser == nil || mode == RenderingOff {
		return resource, httpErr
	}
	if mode == RenderingAuto && !needsBrowser(resource, httpErr) {
		return resource, httpErr
	}
	if mode == RenderingAll &&
		httpErr == nil &&
		!strings.Contains(strings.ToLower(resource.ContentType), "html") {
		return resource, nil
	}

	rendered, browserErr := f.Browser.Fetch(withPreferredProxy(ctx, resource.ProxyURL), rawURL)
	if browserErr != nil {
		if resource.StatusCode != 0 {
			return resource, httpErr
		}
		return Resource{}, browserErr
	}
	if rendered.StatusCode == 0 {
		rendered.StatusCode = resource.StatusCode
	}
	rendered.Redirects = append([]Redirect(nil), resource.Redirects...)
	rendered.RobotsDecision = resource.RobotsDecision
	if rendered.SecurityDecision == "" {
		rendered.SecurityDecision = resource.SecurityDecision
	}
	rendered.ResolvedIPs = uniqueStrings(append(resource.ResolvedIPs, rendered.ResolvedIPs...))
	return rendered, nil
}

func (f HybridFetcher) FetchMany(ctx context.Context, rawURLs []string) []FetchOutcome {
	outcomes := make([]FetchOutcome, len(rawURLs))
	if len(rawURLs) == 0 {
		return outcomes
	}

	if batchFetcher, ok := f.HTTP.(BatchFetcher); ok {
		fetched := batchFetcher.FetchMany(ctx, rawURLs)
		copy(outcomes, fetched)
		for index := len(fetched); index < len(outcomes); index++ {
			outcomes[index].Err = errors.New("HTTP batch fetcher returned fewer results than requested")
		}
	} else {
		fetchOutcomes(
			ctx,
			f.HTTP,
			rawURLs,
			positiveOrDefault(f.HTTPConcurrency, defaultHTTPFetchConcurrency),
			outcomes,
		)
	}

	mode := f.Mode
	if mode == "" {
		mode = RenderingAuto
	}
	if f.Browser == nil || mode == RenderingOff {
		return outcomes
	}

	browserIndexes := make([]int, 0, len(rawURLs))
	for index, outcome := range outcomes {
		if mode == RenderingAuto && !needsBrowser(outcome.Resource, outcome.Err) {
			continue
		}
		if mode == RenderingAll &&
			outcome.Err == nil &&
			!strings.Contains(strings.ToLower(outcome.Resource.ContentType), "html") {
			continue
		}
		browserIndexes = append(browserIndexes, index)
	}

	semaphore := make(chan struct{}, positiveOrDefault(f.BrowserConcurrency, 3))
	var group sync.WaitGroup
	for _, index := range browserIndexes {
		group.Add(1)
		go func(outcomeIndex int) {
			defer group.Done()
			select {
			case semaphore <- struct{}{}:
				defer func() { <-semaphore }()
			case <-ctx.Done():
				outcomes[outcomeIndex].Err = ctx.Err()
				return
			}

			httpOutcome := outcomes[outcomeIndex]
			rendered, browserErr := f.Browser.Fetch(
				withPreferredProxy(ctx, httpOutcome.Resource.ProxyURL),
				rawURLs[outcomeIndex],
			)
			if browserErr != nil {
				if httpOutcome.Resource.StatusCode == 0 {
					outcomes[outcomeIndex] = FetchOutcome{Err: browserErr}
				}
				return
			}
			if rendered.StatusCode == 0 {
				rendered.StatusCode = httpOutcome.Resource.StatusCode
			}
			rendered.Redirects = append(
				[]Redirect(nil),
				httpOutcome.Resource.Redirects...,
			)
			rendered.RobotsDecision = httpOutcome.Resource.RobotsDecision
			if rendered.SecurityDecision == "" {
				rendered.SecurityDecision = httpOutcome.Resource.SecurityDecision
			}
			rendered.ResolvedIPs = uniqueStrings(append(
				httpOutcome.Resource.ResolvedIPs,
				rendered.ResolvedIPs...,
			))
			outcomes[outcomeIndex] = FetchOutcome{Resource: rendered}
		}(index)
	}
	group.Wait()
	return outcomes
}

func fetchOutcomes(
	ctx context.Context,
	fetcher Fetcher,
	rawURLs []string,
	concurrency int,
	outcomes []FetchOutcome,
) {
	semaphore := make(chan struct{}, concurrency)
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
			outcomes[outcomeIndex].Resource, outcomes[outcomeIndex].Err =
				fetcher.Fetch(ctx, value)
		}(index, rawURL)
	}
	group.Wait()
}

func waitForContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func needsBrowser(resource Resource, fetchErr error) bool {
	if resource.StatusCode == http.StatusForbidden || resource.StatusCode == http.StatusTooManyRequests {
		return true
	}
	if fetchErr != nil || !strings.Contains(strings.ToLower(resource.ContentType), "html") {
		return false
	}
	document, err := goquery.NewDocumentFromReader(strings.NewReader(string(resource.Body)))
	if err != nil {
		return false
	}
	document.Find("script,style,noscript,svg").Remove()
	text := cleanText(document.Find("body").Text())
	if len(text) >= 300 {
		return false
	}
	html := strings.ToLower(string(resource.Body))
	return strings.Contains(html, "<script") ||
		strings.Contains(html, "__next_data__") ||
		strings.Contains(html, "data-reactroot") ||
		strings.Contains(html, "id=\"app\"") ||
		strings.Contains(html, "id=\"root\"")
}
