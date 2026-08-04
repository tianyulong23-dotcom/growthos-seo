package crawler

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

type fakeCheckpointStore struct {
	mu         sync.Mutex
	checkpoint CrawlCheckpoint
	found      bool
	saved      []CrawlCheckpoint
	deleted    bool
}

type fakeStatusFetcher struct {
	*fakeFetcher
	statusMu         sync.Mutex
	statuses         map[string]int
	statusErrors     map[string]error
	statusCallsByURL map[string]int
	statusCalls      int
}

type fakeBatchFetcher struct {
	*fakeFetcher
	mu          sync.Mutex
	batches     [][]string
	language    string
	acceptValue string
}

type flakyHomepageFetcher struct {
	mu       sync.Mutex
	resource Resource
	calls    int
}

type delayedURLFetcher struct {
	Fetcher
	url   string
	delay time.Duration
}

type blockingStatusFetcher struct {
	*fakeFetcher
	started chan string
	release <-chan struct{}

	mu        sync.Mutex
	active    int
	maxActive int
}

func (f *blockingStatusFetcher) CheckStatus(
	ctx context.Context,
	rawURL string,
) (int, error) {
	f.mu.Lock()
	f.active++
	f.maxActive = max(f.maxActive, f.active)
	f.mu.Unlock()

	select {
	case f.started <- rawURL:
	case <-ctx.Done():
		f.finishStatusCheck()
		return 0, ctx.Err()
	}
	select {
	case <-f.release:
		f.finishStatusCheck()
		return 200, nil
	case <-ctx.Done():
		f.finishStatusCheck()
		return 0, ctx.Err()
	}
}

func (f *blockingStatusFetcher) finishStatusCheck() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.active--
}

func (f *blockingStatusFetcher) maximumConcurrency() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.maxActive
}

func (f delayedURLFetcher) Fetch(ctx context.Context, rawURL string) (Resource, error) {
	if rawURL == f.url {
		timer := time.NewTimer(f.delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return Resource{URL: rawURL, FinalURL: rawURL}, ctx.Err()
		case <-timer.C:
		}
	}
	return f.Fetcher.Fetch(ctx, rawURL)
}

func (f *flakyHomepageFetcher) Fetch(_ context.Context, rawURL string) (Resource, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.calls == 1 {
		return Resource{URL: rawURL, FinalURL: rawURL}, errors.New("temporary timeout")
	}
	return f.resource, nil
}

func (f *flakyHomepageFetcher) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func (f *fakeBatchFetcher) Fetch(ctx context.Context, rawURL string) (Resource, error) {
	f.mu.Lock()
	f.language = acceptLanguageFromContext(ctx)
	f.mu.Unlock()
	return f.fakeFetcher.Fetch(ctx, rawURL)
}

func (f *fakeBatchFetcher) FetchMany(
	ctx context.Context,
	rawURLs []string,
) []FetchOutcome {
	f.mu.Lock()
	f.batches = append(f.batches, append([]string(nil), rawURLs...))
	f.acceptValue = acceptLanguageFromContext(ctx)
	f.mu.Unlock()

	outcomes := make([]FetchOutcome, len(rawURLs))
	for index, rawURL := range rawURLs {
		outcomes[index].Resource, outcomes[index].Err = f.fakeFetcher.Fetch(ctx, rawURL)
	}
	return outcomes
}

func (f *fakeStatusFetcher) CheckStatus(_ context.Context, rawURL string) (int, error) {
	f.statusMu.Lock()
	defer f.statusMu.Unlock()
	f.statusCalls++
	if f.statusCallsByURL == nil {
		f.statusCallsByURL = make(map[string]int)
	}
	f.statusCallsByURL[rawURL]++
	if err := f.statusErrors[rawURL]; err != nil {
		return 0, err
	}
	if status, exists := f.statuses[rawURL]; exists {
		return status, nil
	}
	return 200, nil
}

func (f *fakeStatusFetcher) statusCallCount(rawURL string) int {
	f.statusMu.Lock()
	defer f.statusMu.Unlock()
	return f.statusCallsByURL[rawURL]
}

func (s *fakeCheckpointStore) SaveCheckpoint(
	_ context.Context,
	_ Task,
	checkpoint CrawlCheckpoint,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.saved = append(s.saved, checkpoint)
	s.checkpoint = checkpoint
	s.found = true
	return nil
}

func (s *fakeCheckpointStore) LoadCheckpoint(
	context.Context,
	Task,
) (CrawlCheckpoint, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.checkpoint, s.found, nil
}

func (s *fakeCheckpointStore) DeleteCheckpoint(context.Context, Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleted = true
	return nil
}

func TestInitializationReusesHomepageFetch(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><head><title>Home</title></head><body><nav><a href="/about">About</a></nav></body></html>`),
			FetchedAt:   now,
		},
		"https://example.com/about": {
			URL:         "https://example.com/about",
			FinalURL:    "https://example.com/about",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><head><title>About</title></head><body><h1>About</h1></body></html>`),
			FetchedAt:   now,
		},
	}}
	config := Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 10}
	engine := NewEngine(config, httpFetcher, pageFetcher, nil)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "run",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       2,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 2 {
		t.Fatalf("page count = %d", len(result.Pages))
	}
	if pageFetcher.callCount("https://example.com/") != 1 {
		t.Fatalf("homepage fetch count = %d", pageFetcher.callCount("https://example.com/"))
	}
}

func TestSiteUnderstandingRetriesFailedHomepagePrefetch(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &flakyHomepageFetcher{resource: Resource{
		URL:         "https://example.com/",
		FinalURL:    "https://example.com/",
		StatusCode:  200,
		ContentType: "text/html",
		Body: []byte(
			`<html lang="en"><head><title>Acme Platform</title>` +
				`<meta name="description" content="Acme helps operations teams."></head>` +
				`<body><h1>Operations platform</h1></body></html>`,
		),
		FetchedAt: now,
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 5},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "retry-homepage",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       1,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 1 {
		t.Fatalf("page count = %d, want 1", len(result.Pages))
	}
	if pageFetcher.callCount() != 2 {
		t.Fatalf("homepage fetch count = %d, want 2", pageFetcher.callCount())
	}
}

func TestSiteUnderstandingFollowsMatchingHreflangAndFiltersWrongLanguage(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html lang="en"><head><title>Acme Platform</title>` +
					`<link rel="alternate" hreflang="fr-FR" href="/fr">` +
					`<meta name="description" content="Acme helps operations teams."></head>` +
					`<body><nav><a href="/about">About</a><a href="/products">Products</a></nav>` +
					`<h1>Operations platform</h1></body></html>`,
			),
			FetchedAt: now,
		},
		"https://example.com/fr": {
			URL:         "https://example.com/fr",
			FinalURL:    "https://example.com/fr",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html lang="fr-FR"><head><title>Acme France</title>` +
					`<meta name="description" content="Acme automatise les operations."></head>` +
					`<body><nav><a href="/fr/about">A propos</a>` +
					`<a href="/fr/products">Produits</a></nav>` +
					`<h1>Plateforme d'automatisation</h1></body></html>`,
			),
			FetchedAt: now,
		},
		"https://example.com/fr/about": {
			URL:         "https://example.com/fr/about",
			FinalURL:    "https://example.com/fr/about",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html lang="fr"><head><title>A propos de Acme</title></head><body><h1>A propos</h1></body></html>`),
			FetchedAt:   now,
		},
		"https://example.com/fr/products": {
			URL:         "https://example.com/fr/products",
			FinalURL:    "https://example.com/fr/products",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html lang="fr"><head><title>Produits Acme</title></head><body><h1>Produits</h1></body></html>`),
			FetchedAt:   now,
		},
		"https://example.com/about": {
			URL:         "https://example.com/about",
			FinalURL:    "https://example.com/about",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html lang="en"><head><title>About Acme</title></head><body><h1>About</h1></body></html>`),
			FetchedAt:   now,
		},
		"https://example.com/products": {
			URL:         "https://example.com/products",
			FinalURL:    "https://example.com/products",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html lang="en"><head><title>Acme Products</title></head><body><h1>Products</h1></body></html>`),
			FetchedAt:   now,
		},
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 20},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "locale-understanding",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "FR",
		Language:       "fr",
		MaxPages:       3,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if result.CompletionStatus != CompletionComplete {
		t.Fatalf("completion status = %q, want %q", result.CompletionStatus, CompletionComplete)
	}
	if len(result.Pages) != 3 {
		t.Fatalf("page count = %d, want 3", len(result.Pages))
	}
	for _, page := range result.Pages {
		if page.Language != "fr" && page.Language != "fr-FR" {
			t.Fatalf("selected wrong-language page: %#v", page)
		}
	}
	if pageFetcher.callCount("https://example.com/fr") != 1 {
		t.Fatalf("localized homepage fetch count = %d, want 1", pageFetcher.callCount("https://example.com/fr"))
	}
	if pageFetcher.callCount("https://example.com/about") != 0 ||
		pageFetcher.callCount("https://example.com/products") != 0 {
		t.Fatal("wrong-language navigation pages were fetched")
	}
}

func TestSiteUnderstandingExplainsWhenAllPagesUseAnotherLanguage(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html lang="en-US"><head><title>Example</title></head>` +
					`<body><h1>Example</h1></body></html>`,
			),
			FetchedAt: now,
		},
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 5},
		httpFetcher,
		pageFetcher,
		nil,
		WithCheckpointStore(&fakeCheckpointStore{}),
	)
	task := Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "wrong-language-only",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "BR",
		Language:       "pt-BR",
		MaxPages:       1,
	}
	want := "未找到符合项目语言 pt-BR 的页面；网站返回的页面语言为 en-US"
	for attempt := 1; attempt <= 2; attempt++ {
		_, err := engine.Run(context.Background(), task)
		if err == nil {
			t.Fatalf("Run() attempt %d returned no error", attempt)
		}
		if err.Error() != want {
			t.Fatalf("Run() attempt %d error = %q, want %q", attempt, err, want)
		}
	}
}

func TestCheckpointResumeSkipsCompletedHomepage(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/about": {
			URL:         "https://example.com/about",
			FinalURL:    "https://example.com/about",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><head><title>About</title></head><body><h1>About</h1></body></html>`),
			FetchedAt:   now,
		},
	}}
	checkpoints := &fakeCheckpointStore{
		found: true,
		checkpoint: CrawlCheckpoint{
			Candidates: []CandidateState{
				{URL: "https://example.com/", Depth: 0, Score: 100},
				{URL: "https://example.com/about", Depth: 1, Score: 50},
			},
			Processed: []string{"https://example.com/"},
			Pages: []Page{
				{
					URL:        "https://example.com/",
					FinalURL:   "https://example.com/",
					StatusCode: 200,
					Title:      "Home",
					H1:         []string{"Home"},
					Score:      100,
				},
			},
			Attempted:   1,
			ImageStatus: map[string]int{},
		},
	}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 10},
		httpFetcher,
		pageFetcher,
		nil,
		WithCheckpointStore(checkpoints),
	)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "resume-run",
		Type:           TaskTechnicalAudit,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       2,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 2 {
		t.Fatalf("page count = %d, want 2", len(result.Pages))
	}
	if pageFetcher.callCount("https://example.com/") != 0 {
		t.Fatalf("homepage fetch count = %d, want 0", pageFetcher.callCount("https://example.com/"))
	}
	if pageFetcher.callCount("https://example.com/about") != 1 {
		t.Fatalf("about fetch count = %d, want 1", pageFetcher.callCount("https://example.com/about"))
	}
}

func TestCheckpointIsSavedBeforeNetworkDiscovery(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><head><title>Home</title></head><body><h1>Home</h1></body></html>`),
			FetchedAt:   now,
		},
	}}
	checkpoints := &fakeCheckpointStore{}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 10},
		httpFetcher,
		pageFetcher,
		nil,
		WithCheckpointStore(checkpoints),
	)

	_, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "initial-checkpoint",
		Type:           TaskTechnicalAudit,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       1,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}

	checkpoints.mu.Lock()
	defer checkpoints.mu.Unlock()
	if len(checkpoints.saved) == 0 {
		t.Fatal("no checkpoint was saved")
	}
	first := checkpoints.saved[0]
	if first.Attempted != 0 || len(first.Pages) != 0 {
		t.Fatalf("initial checkpoint = %#v", first)
	}
	if len(first.Candidates) != 1 || first.Candidates[0].URL != "https://example.com/" {
		t.Fatalf("initial checkpoint candidates = %#v", first.Candidates)
	}
}

func TestCheckpointCadenceMatchesLibreCrawlBatching(t *testing.T) {
	now := time.Now()

	if checkpointDue(0, checkpointAttemptBatchSize-1, now, now.Add(29*time.Second)) {
		t.Fatal("checkpoint became due before the batch or interval threshold")
	}
	if !checkpointDue(0, checkpointAttemptBatchSize, now, now.Add(time.Second)) {
		t.Fatal("checkpoint did not become due after 50 attempts")
	}
	if !checkpointDue(10, 11, now, now.Add(checkpointInterval)) {
		t.Fatal("checkpoint did not become due after 30 seconds")
	}
}

func TestTechnicalAuditCheckpointOmitsStoredInlineArtifacts(t *testing.T) {
	pages := []Page{
		{
			URL:         "https://example.com/",
			MainText:    "large extracted body",
			MainHTML:    "<main>large extracted body</main>",
			MainTextRef: "runs/run/pages/page/main.txt.gz",
			MainHTMLRef: "runs/run/pages/page/main.html.gz",
		},
	}

	checkpoint := checkpointPages(Task{Type: TaskTechnicalAudit}, pages)

	if checkpoint[0].MainText != "" || checkpoint[0].MainHTML != "" {
		t.Fatalf("checkpoint retained inline page artifacts: %#v", checkpoint[0])
	}
	if checkpoint[0].MainTextRef == "" || checkpoint[0].MainHTMLRef == "" {
		t.Fatalf("checkpoint lost page artifact references: %#v", checkpoint[0])
	}
	if pages[0].MainText == "" || pages[0].MainHTML == "" {
		t.Fatal("checkpoint copy mutated the live page")
	}
}

func TestImageStatusChecksRespectResourceLimit(t *testing.T) {
	fetcher := &fakeStatusFetcher{
		fakeFetcher: &fakeFetcher{},
		statuses: map[string]int{
			"https://example.com/one.png": 200,
			"https://example.com/two.png": 404,
		},
	}
	engine := NewEngine(
		Config{ResourceCheckLimit: 1, StatusConcurrency: 1},
		fetcher,
		fetcher,
		nil,
	)
	page := Page{Links: []Link{
		{URL: "https://example.com/one.png", Placement: "image"},
		{URL: "https://example.com/two.png", Placement: "image"},
	}}

	engine.checkImageStatuses(context.Background(), &page, map[string]int{})

	if fetcher.statusCalls != 1 {
		t.Fatalf("status calls = %d, want 1", fetcher.statusCalls)
	}
	if !engine.resourceChecksTruncated {
		t.Fatal("resource checks were not marked as truncated")
	}
}

func TestImageStatusChecksRunAcrossPagesConcurrently(t *testing.T) {
	release := make(chan struct{})
	fetcher := &blockingStatusFetcher{
		fakeFetcher: &fakeFetcher{},
		started:     make(chan string, 2),
		release:     release,
	}
	engine := NewEngine(
		Config{ResourceCheckLimit: 10, StatusConcurrency: 5},
		fetcher,
		fetcher,
		nil,
	)
	pages := []Page{
		{Links: []Link{{URL: "https://example.com/one.png", Placement: "image"}}},
		{Links: []Link{{URL: "https://example.com/two.png", Placement: "image"}}},
	}
	done := make(chan struct{})
	go func() {
		engine.checkImageStatusesForPages(context.Background(), pages, map[string]int{})
		close(done)
	}()

	for range 2 {
		select {
		case <-fetcher.started:
		case <-time.After(time.Second):
			close(release)
			<-done
			t.Fatal("image checks from separate pages did not overlap")
		}
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("parallel image checks did not finish")
	}
	if fetcher.maximumConcurrency() < 2 {
		t.Fatalf("maximum image concurrency = %d, want at least 2", fetcher.maximumConcurrency())
	}
}

func TestImageStatusChecksLimitConcurrencyWithinPage(t *testing.T) {
	release := make(chan struct{})
	fetcher := &blockingStatusFetcher{
		fakeFetcher: &fakeFetcher{},
		started:     make(chan string, 6),
		release:     release,
	}
	engine := NewEngine(
		Config{ResourceCheckLimit: 10, StatusConcurrency: 5},
		fetcher,
		fetcher,
		nil,
	)
	links := make([]Link, 6)
	for index := range links {
		links[index] = Link{
			URL:       fmt.Sprintf("https://example.com/%d.png", index),
			Placement: "image",
		}
	}
	pages := []Page{{Links: links}}
	done := make(chan struct{})
	go func() {
		engine.checkImageStatusesForPages(context.Background(), pages, map[string]int{})
		close(done)
	}()

	for range imageStatusPerPageConcurrency {
		select {
		case <-fetcher.started:
		case <-time.After(time.Second):
			close(release)
			<-done
			t.Fatal("five image checks did not start")
		}
	}
	select {
	case <-fetcher.started:
		close(release)
		<-done
		t.Fatal("more than five image checks ran concurrently for one page")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("per-page image checks did not finish")
	}
	if maximum := fetcher.maximumConcurrency(); maximum != imageStatusPerPageConcurrency {
		t.Fatalf(
			"maximum per-page image concurrency = %d, want %d",
			maximum,
			imageStatusPerPageConcurrency,
		)
	}
}

func TestImageStatusChecksDeduplicateAcrossPages(t *testing.T) {
	const imageURL = "https://example.com/shared.png"
	fetcher := &fakeStatusFetcher{
		fakeFetcher: &fakeFetcher{},
		statuses:    map[string]int{imageURL: 404},
	}
	engine := NewEngine(
		Config{ResourceCheckLimit: 10, StatusConcurrency: 5},
		fetcher,
		fetcher,
		nil,
	)
	pages := []Page{
		{Links: []Link{{URL: imageURL, Placement: "image"}}},
		{Links: []Link{{URL: imageURL, Placement: "image"}}},
	}

	engine.checkImageStatusesForPages(context.Background(), pages, map[string]int{})

	if calls := fetcher.statusCallCount(imageURL); calls != 1 {
		t.Fatalf("shared image status calls = %d, want 1", calls)
	}
	for index, page := range pages {
		if page.Links[0].TargetStatus == nil || *page.Links[0].TargetStatus != 404 {
			t.Fatalf("page %d image status = %#v, want 404", index, page.Links[0].TargetStatus)
		}
		if len(page.BrokenImages) != 1 || page.BrokenImages[0].URL != imageURL {
			t.Fatalf("page %d broken images = %#v", index, page.BrokenImages)
		}
	}
}

func TestImageStatusChecksCapNewImagesPerPage(t *testing.T) {
	fetcher := &fakeStatusFetcher{
		fakeFetcher: &fakeFetcher{},
	}
	engine := NewEngine(
		Config{ResourceCheckLimit: 100, StatusConcurrency: 5},
		fetcher,
		fetcher,
		nil,
	)
	links := make([]Link, imageStatusPerPageLimit+1)
	for index := range links {
		links[index] = Link{
			URL:       fmt.Sprintf("https://example.com/%d.png", index),
			Placement: "image",
		}
	}
	pages := []Page{{Links: links}}

	engine.checkImageStatusesForPages(context.Background(), pages, map[string]int{})

	fetcher.statusMu.Lock()
	statusCalls := fetcher.statusCalls
	fetcher.statusMu.Unlock()
	if statusCalls != imageStatusPerPageLimit {
		t.Fatalf("image status calls = %d, want %d", statusCalls, imageStatusPerPageLimit)
	}
	if !engine.resourceChecksTruncated {
		t.Fatal("per-page image limit was not reported as truncated")
	}
	if pages[0].Links[imageStatusPerPageLimit].TargetStatus != nil {
		t.Fatal("image after the per-page limit unexpectedly received a status")
	}
}

func TestImageStatusSchedulerDefersWaitingUntilClose(t *testing.T) {
	const imageURL = "https://example.com/queued.png"
	release := make(chan struct{})
	fetcher := &blockingStatusFetcher{
		fakeFetcher: &fakeFetcher{},
		started:     make(chan string, 1),
		release:     release,
	}
	scheduler := newImageStatusScheduler(
		context.Background(),
		fetcher,
		Config{ResourceCheckLimit: 10, StatusConcurrency: 5},
		map[string]int{"https://example.com/cached.png": 200},
	)

	enqueued := make(chan struct{})
	go func() {
		scheduler.EnqueuePage(Page{Links: []Link{{
			URL:       imageURL,
			Placement: "image",
		}}})
		close(enqueued)
	}()
	select {
	case <-enqueued:
	case <-time.After(time.Second):
		close(release)
		scheduler.CloseAndWait()
		t.Fatal("enqueue waited for the image request")
	}
	select {
	case startedURL := <-fetcher.started:
		if startedURL != imageURL {
			t.Fatalf("started image = %q, want %q", startedURL, imageURL)
		}
	case <-time.After(time.Second):
		close(release)
		scheduler.CloseAndWait()
		t.Fatal("queued image request did not start")
	}

	finished := make(chan struct{})
	go func() {
		scheduler.CloseAndWait()
		close(finished)
	}()
	select {
	case <-finished:
		close(release)
		t.Fatal("scheduler finished before the image request")
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("scheduler did not finish after the image request")
	}

	statuses := scheduler.Snapshot()
	if statuses[imageURL] != 200 ||
		statuses["https://example.com/cached.png"] != 200 {
		t.Fatalf("image status snapshot = %#v", statuses)
	}
}

func TestLimitedPendingResourcesUsesStableURLOrder(t *testing.T) {
	limited, remaining := limitedPendingResources(
		map[string]string{
			"c": "https://example.com/c",
			"a": "https://example.com/a",
			"b": "https://example.com/b",
		},
		2,
	)

	if remaining != 0 || len(limited) != 2 {
		t.Fatalf("limited resources = %#v, remaining = %d", limited, remaining)
	}
	if _, exists := limited["a"]; !exists {
		t.Fatal("stable resource limit omitted a")
	}
	if _, exists := limited["b"]; !exists {
		t.Fatal("stable resource limit omitted b")
	}
}

func TestTechnicalAuditRetainsNoResponsePageAndIssue(t *testing.T) {
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeFetcher{
		resources: map[string]Resource{
			"https://example.com/": {
				URL:      "https://example.com/",
				FinalURL: "https://example.com/",
			},
		},
		errors: map[string]error{
			"https://example.com/": errors.New("dial timeout"),
		},
	}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 1},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "audit-run",
		Type:           TaskTechnicalAudit,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       1,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 1 || result.Pages[0].StatusCode != 0 {
		t.Fatalf("pages = %#v", result.Pages)
	}
	if result.Pages[0].Error != "dial timeout" || result.Pages[0].ResponseTimeMS <= 0 {
		t.Fatalf("no-response page metadata = %#v", result.Pages[0])
	}
	if !hasIssueCode(result.Issues, "crawl_error") {
		t.Fatalf("issues = %#v", result.Issues)
	}
	if pageFetcher.callCount("https://example.com/") != 1 {
		t.Fatalf("homepage fetch count = %d", pageFetcher.callCount("https://example.com/"))
	}
}

func TestSiteCrawlWithZeroPagesReturnsError(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "application/pdf",
			Body:        []byte("%PDF"),
			FetchedAt:   now,
		},
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 1},
		httpFetcher,
		pageFetcher,
		nil,
	)

	_, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "empty-run",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       1,
	})
	if err == nil {
		t.Fatal("Run() succeeded with zero pages")
	}
}

func TestDiscoveryLimitNeverFallsBelowMaxPages(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html><head><title>Home page title with enough detail</title></head>` +
					`<body><h1>Home</h1><a href="/one">One</a><a href="/two">Two</a></body></html>`,
			),
			FetchedAt: now,
		},
		"https://example.com/one": {
			URL:         "https://example.com/one",
			FinalURL:    "https://example.com/one",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><head><title>Page one with enough detail</title></head><body><h1>One</h1></body></html>`),
			FetchedAt:   now,
		},
		"https://example.com/two": {
			URL:         "https://example.com/two",
			FinalURL:    "https://example.com/two",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><head><title>Page two with enough detail</title></head><body><h1>Two</h1></body></html>`),
			FetchedAt:   now,
		},
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 1},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "discovery-run",
		Type:           TaskTechnicalAudit,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       3,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 3 {
		t.Fatalf("page count = %d, want 3", len(result.Pages))
	}
}

func TestSiteUnderstandingStopsAfterThreeCompleteBusinessPages(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html><head><title>Acme Cloud | Operations Platform</title>` +
					`<meta name="description" content="Acme automates operations work."></head>` +
					`<body><nav>` +
					`<a href="/about">About</a>` +
					`<a href="/products">Products</a>` +
					`<a href="/products/second">Second product</a>` +
					`<a href="/blog">Blog</a>` +
					`</nav><h1>Operations automation</h1></body></html>`,
			),
			FetchedAt: now,
		},
		"https://example.com/about": {
			URL:         "https://example.com/about",
			FinalURL:    "https://example.com/about",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><head><title>About Acme</title></head><body><h1>About Acme</h1></body></html>`),
			FetchedAt:   now,
		},
		"https://example.com/products": {
			URL:         "https://example.com/products",
			FinalURL:    "https://example.com/products",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><head><title>Acme Products</title></head><body><h1>Workflow Products</h1></body></html>`),
			FetchedAt:   now,
		},
		"https://example.com/products/second": {
			URL:         "https://example.com/products/second",
			FinalURL:    "https://example.com/products/second",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><head><title>Second Product</title></head><body><h1>Second Product</h1></body></html>`),
			FetchedAt:   now,
		},
		"https://example.com/blog": {
			URL:         "https://example.com/blog",
			FinalURL:    "https://example.com/blog",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><head><title>Blog</title></head><body><h1>Blog</h1></body></html>`),
			FetchedAt:   now,
		},
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 20},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "understanding-complete",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       5,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 3 {
		t.Fatalf("page count = %d, want 3", len(result.Pages))
	}
	if pageFetcher.callCount("https://example.com/about") != 1 ||
		pageFetcher.callCount("https://example.com/products") != 1 {
		t.Fatalf("important pages were not fetched")
	}
	if pageFetcher.callCount("https://example.com/products/second") != 0 ||
		pageFetcher.callCount("https://example.com/blog") != 0 {
		t.Fatalf("crawl continued after business profile was complete")
	}
}

func TestSiteUnderstandingUsesFivePagesWhenBusinessProfileIsIncomplete(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html><head><title>Example</title>` +
					`<meta name="description" content="Example company website."></head>` +
					`<body><nav>` +
					`<a href="/about">About</a>` +
					`<a href="/customers">Customers</a>` +
					`<a href="/contact">Contact</a>` +
					`<a href="/blog">Blog</a>` +
					`</nav><h1>Example</h1></body></html>`,
			),
			FetchedAt: now,
		},
	}}
	for _, path := range []string{"about", "customers", "contact", "blog"} {
		rawURL := "https://example.com/" + path
		pageFetcher.resources[rawURL] = Resource{
			URL:         rawURL,
			FinalURL:    rawURL,
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><head><title>` + path + `</title></head><body><h1>` + path + `</h1></body></html>`),
			FetchedAt:   now,
		}
	}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 20},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "understanding-incomplete",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 5 {
		t.Fatalf("page count = %d, want 5", len(result.Pages))
	}
}

func TestTechnicalAuditDoesNotUseBusinessProfileEarlyStop(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html><head><title>Acme Software</title>` +
					`<meta name="description" content="Acme software platform."></head>` +
					`<body><nav><a href="/about">About</a><a href="/products">Products</a>` +
					`<a href="/blog">Blog</a></nav><h1>Acme</h1></body></html>`,
			),
			FetchedAt: now,
		},
	}}
	for _, path := range []string{"about", "products", "blog"} {
		rawURL := "https://example.com/" + path
		pageFetcher.resources[rawURL] = Resource{
			URL:         rawURL,
			FinalURL:    rawURL,
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html><head><title>` + path + `</title></head><body><h1>` + path + `</h1></body></html>`),
			FetchedAt:   now,
		}
	}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 20},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "audit-no-early-stop",
		Type:           TaskTechnicalAudit,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       4,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 4 {
		t.Fatalf("page count = %d, want 4", len(result.Pages))
	}
}

func TestTechnicalAuditChecksUniqueUncrawledLinks(t *testing.T) {
	now := time.Now().UTC()
	const externalURL = "https://external.example/reference"
	httpFetcher := &fakeStatusFetcher{
		fakeFetcher: &fakeFetcher{resources: map[string]Resource{
			"https://example.com/robots.txt": {
				FinalURL:   "https://example.com/robots.txt",
				StatusCode: 404,
			},
			"https://example.com/sitemap.xml": {
				FinalURL:   "https://example.com/sitemap.xml",
				StatusCode: 404,
			},
			externalURL: {
				URL:         externalURL,
				FinalURL:    externalURL,
				StatusCode:  404,
				ContentType: "text/html",
				Body:        []byte(`<html><head><title>External reference</title></head></html>`),
				FetchedAt:   now,
			},
		}},
		statuses: map[string]int{externalURL: 404},
	}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html><head><title>Home</title></head><body>` +
					`<a href="/about">About one</a>` +
					`<a href="/about">About two</a>` +
					`<a href="` + externalURL + `">External</a>` +
					`</body></html>`,
			),
			FetchedAt: now,
		},
		"https://example.com/about": {
			URL:         "https://example.com/about",
			FinalURL:    "https://example.com/about",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html><head><title>About</title></head><body>` +
					`<a href="` + externalURL + `">External again</a>` +
					`</body></html>`,
			),
			FetchedAt: now,
		},
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 10},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "audit-link-statuses",
		Type:           TaskTechnicalAudit,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       2,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if httpFetcher.statusCallCount("https://example.com/about") != 0 {
		t.Fatal("crawled internal page was checked with an extra HTTP request")
	}
	if httpFetcher.statusCallCount(externalURL) != 0 {
		t.Fatalf(
			"external status calls = %d, want 0",
			httpFetcher.statusCallCount(externalURL),
		)
	}
	if httpFetcher.fakeFetcher.callCount(externalURL) != 1 {
		t.Fatalf(
			"external fetch calls = %d, want 1",
			httpFetcher.fakeFetcher.callCount(externalURL),
		)
	}
	if len(result.ExternalResources) != 1 {
		t.Fatalf("external resources = %#v, want 1 item", result.ExternalResources)
	}
	externalResource := result.ExternalResources[0]
	if externalResource.URL != externalURL ||
		externalResource.StatusCode != 404 ||
		externalResource.ContentType != "text/html" ||
		externalResource.SizeBytes <= 0 ||
		externalResource.Title != "External reference" {
		t.Fatalf("external resource = %#v", externalResource)
	}

	internalStatuses := 0
	externalStatuses := 0
	for _, page := range result.Pages {
		for _, link := range page.Links {
			switch link.URL {
			case "https://example.com/about":
				if link.TargetStatus == nil || *link.TargetStatus != 200 {
					t.Fatalf("internal link status = %#v, want 200", link.TargetStatus)
				}
				internalStatuses++
			case externalURL:
				if link.TargetStatus == nil || *link.TargetStatus != 404 {
					t.Fatalf("external link status = %#v, want 404", link.TargetStatus)
				}
				externalStatuses++
			}
		}
	}
	if internalStatuses != 2 {
		t.Fatalf("internal link count = %d, want 2", internalStatuses)
	}
	if externalStatuses != 2 {
		t.Fatalf("external link count = %d, want 2", externalStatuses)
	}
}

func TestTechnicalAuditCheckpointIncludesPagesIssuesAndExternalResources(t *testing.T) {
	now := time.Now().UTC()
	const externalURL = "https://external.example/missing"
	httpFetcher := &fakeStatusFetcher{
		fakeFetcher: &fakeFetcher{resources: map[string]Resource{
			"https://example.com/robots.txt": {
				FinalURL:   "https://example.com/robots.txt",
				StatusCode: 404,
			},
			"https://example.com/sitemap.xml": {
				FinalURL:   "https://example.com/sitemap.xml",
				StatusCode: 404,
			},
			externalURL: {
				URL:         externalURL,
				FinalURL:    externalURL,
				StatusCode:  404,
				ContentType: "text/html",
				Body:        []byte(`<html><head><title>Missing</title></head></html>`),
				FetchedAt:   now,
			},
		}},
	}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html><head><title></title></head><body>` +
					`<a href="` + externalURL + `">Missing</a>` +
					`</body></html>`,
			),
			FetchedAt: now,
		},
	}}
	checkpoints := &fakeCheckpointStore{}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 10},
		httpFetcher,
		pageFetcher,
		nil,
		WithCheckpointStore(checkpoints),
	)

	if _, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "checkpoint-live-data",
		Type:           TaskTechnicalAudit,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       1,
	}); err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}

	checkpoints.mu.Lock()
	defer checkpoints.mu.Unlock()
	if len(checkpoints.checkpoint.Pages) != 1 {
		t.Fatalf("checkpoint pages = %#v", checkpoints.checkpoint.Pages)
	}
	if len(checkpoints.checkpoint.Issues) == 0 {
		t.Fatal("checkpoint did not include page issues")
	}
	if len(checkpoints.checkpoint.ExternalResources) != 1 ||
		checkpoints.checkpoint.ExternalResources[0].URL != externalURL {
		t.Fatalf(
			"checkpoint external resources = %#v",
			checkpoints.checkpoint.ExternalResources,
		)
	}
}

func TestSiteUnderstandingLimitsFailedCandidateAttempts(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	links := ""
	pageFetcher := &fakeFetcher{
		resources: map[string]Resource{
			"https://example.com/": {
				URL:         "https://example.com/",
				FinalURL:    "https://example.com/",
				StatusCode:  200,
				ContentType: "text/html",
				FetchedAt:   now,
			},
		},
		errors: map[string]error{},
	}
	for index := 0; index < 20; index++ {
		rawURL := fmt.Sprintf("https://example.com/page-%02d", index)
		links += fmt.Sprintf(`<a href="/page-%02d">Page</a>`, index)
		pageFetcher.resources[rawURL] = Resource{URL: rawURL, FinalURL: rawURL}
		pageFetcher.errors[rawURL] = errors.New("dial timeout")
	}
	homepage := pageFetcher.resources["https://example.com/"]
	homepage.Body = []byte(`<html><head><title>Example</title></head><body>` + links + `</body></html>`)
	pageFetcher.resources["https://example.com/"] = homepage
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 100},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "understanding-attempt-limit",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 1 {
		t.Fatalf("page count = %d, want 1", len(result.Pages))
	}
	totalCalls := 0
	for rawURL := range pageFetcher.resources {
		totalCalls += pageFetcher.callCount(rawURL)
	}
	if totalCalls != 10 {
		t.Fatalf("page fetch attempts = %d, want 10", totalCalls)
	}
}

func TestRobotsDisallowedCandidatesDoNotConsumeFetchBudget(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 200,
			Body:       []byte("User-agent: *\nDisallow: /private\n"),
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html lang="en"><head><title>Example</title></head><body><nav>` +
					`<a href="/private/products">Private products</a>` +
					`<a href="/private/services">Private services</a>` +
					`<a href="/private/platform">Private platform</a>` +
					`<a href="/contact">Contact</a>` +
					`</nav><h1>Example</h1></body></html>`,
			),
			FetchedAt: now,
		},
		"https://example.com/contact": {
			URL:         "https://example.com/contact",
			FinalURL:    "https://example.com/contact",
			StatusCode:  200,
			ContentType: "text/html",
			Body:        []byte(`<html lang="en"><head><title>Contact</title></head><body><h1>Contact</h1></body></html>`),
			FetchedAt:   now,
		},
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 5},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "robots-budget",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       2,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 2 {
		t.Fatalf("page count = %d, want 2", len(result.Pages))
	}
	if pageFetcher.callCount("https://example.com/contact") != 1 {
		t.Fatalf(
			"contact fetch count = %d, want 1",
			pageFetcher.callCount("https://example.com/contact"),
		)
	}
	if pageFetcher.callCount("https://example.com/private/products") != 0 ||
		pageFetcher.callCount("https://example.com/private/services") != 0 ||
		pageFetcher.callCount("https://example.com/private/platform") != 0 {
		t.Fatal("robots-disallowed candidates were fetched")
	}
}

func TestSiteUnderstandingDoesNotCheckImageStatuses(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeStatusFetcher{fakeFetcher: &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}}
	pageFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/": {
			URL:         "https://example.com/",
			FinalURL:    "https://example.com/",
			StatusCode:  200,
			ContentType: "text/html",
			Body: []byte(
				`<html><head><title>Example</title></head>` +
					`<body><h1>Example</h1><img src="/hero.jpg" alt="Hero"></body></html>`,
			),
			FetchedAt: now,
		},
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 5},
		httpFetcher,
		pageFetcher,
		nil,
	)

	_, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "understanding-no-image-audit",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       1,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if httpFetcher.statusCalls != 0 {
		t.Fatalf("image status calls = %d, want 0", httpFetcher.statusCalls)
	}
}

func TestSiteUnderstandingFetchesRemainingCandidatesAsOneBatch(t *testing.T) {
	now := time.Now().UTC()
	httpFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	pageFetcher := &fakeBatchFetcher{fakeFetcher: &fakeFetcher{
		resources: map[string]Resource{
			"https://example.com/": {
				URL:         "https://example.com/",
				FinalURL:    "https://example.com/",
				StatusCode:  200,
				ContentType: "text/html",
				Body: []byte(
					`<html lang="en"><head><title>Acme Platform</title>` +
						`<meta name="description" content="Acme helps operations teams."></head>` +
						`<body><nav><a href="/about">About</a>` +
						`<a href="/products">Products</a><a href="/contact">Contact</a>` +
						`</nav><h1>Operations platform</h1></body></html>`,
				),
				FetchedAt: now,
			},
			"https://example.com/about": {
				URL:         "https://example.com/about",
				FinalURL:    "https://example.com/about",
				StatusCode:  200,
				ContentType: "text/html",
				Body:        []byte(`<html><head><title>About Acme</title></head><body><h1>About Acme</h1></body></html>`),
				FetchedAt:   now,
			},
			"https://example.com/products": {
				URL:         "https://example.com/products",
				FinalURL:    "https://example.com/products",
				StatusCode:  200,
				ContentType: "text/html",
				Body:        []byte(`<html><head><title>Acme Products</title></head><body><h1>Workflow Products</h1></body></html>`),
				FetchedAt:   now,
			},
			"https://example.com/contact": {
				URL:         "https://example.com/contact",
				FinalURL:    "https://example.com/contact",
				StatusCode:  200,
				ContentType: "text/html",
				Body:        []byte(`<html><head><title>Contact Acme</title></head><body><h1>Contact Acme</h1></body></html>`),
				FetchedAt:   now,
			},
		},
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 20},
		httpFetcher,
		pageFetcher,
		nil,
	)

	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "batch-understanding",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       4,
	})
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(pageFetcher.batches) != 1 {
		t.Fatalf("batch count = %d, want 1", len(pageFetcher.batches))
	}
	if len(pageFetcher.batches[0]) != 3 {
		t.Fatalf("batch URL count = %d, want 3", len(pageFetcher.batches[0]))
	}
	if pageFetcher.acceptValue != "en-US,en;q=0.9" {
		t.Fatalf("batch Accept-Language = %q", pageFetcher.acceptValue)
	}
	if result.CompletionStatus != CompletionComplete {
		t.Fatalf("completion status = %q", result.CompletionStatus)
	}
}

func TestSiteUnderstandingDoesNotWaitForSlowSitemapWhenNavigationIsEnough(t *testing.T) {
	now := time.Now().UTC()
	baseHTTPFetcher := &fakeFetcher{resources: map[string]Resource{
		"https://example.com/robots.txt": {
			FinalURL:   "https://example.com/robots.txt",
			StatusCode: 404,
		},
		"https://example.com/sitemap.xml": {
			FinalURL:   "https://example.com/sitemap.xml",
			StatusCode: 404,
		},
	}}
	httpFetcher := delayedURLFetcher{
		Fetcher: baseHTTPFetcher,
		url:     "https://example.com/sitemap.xml",
		delay:   750 * time.Millisecond,
	}
	pageFetcher := &fakeBatchFetcher{fakeFetcher: &fakeFetcher{
		resources: map[string]Resource{
			"https://example.com/": {
				URL:         "https://example.com/",
				FinalURL:    "https://example.com/",
				StatusCode:  200,
				ContentType: "text/html",
				Body: []byte(
					`<html lang="en"><head><title>Acme Platform</title></head>` +
						`<body><nav><a href="/about">About</a>` +
						`<a href="/products">Products</a></nav>` +
						`<h1>Operations platform</h1></body></html>`,
				),
				FetchedAt: now,
			},
			"https://example.com/about": {
				URL:         "https://example.com/about",
				FinalURL:    "https://example.com/about",
				StatusCode:  200,
				ContentType: "text/html",
				Body:        []byte(`<html lang="en"><head><title>About Acme</title></head><body><h1>About Acme</h1></body></html>`),
				FetchedAt:   now,
			},
			"https://example.com/products": {
				URL:         "https://example.com/products",
				FinalURL:    "https://example.com/products",
				StatusCode:  200,
				ContentType: "text/html",
				Body:        []byte(`<html lang="en"><head><title>Acme Products</title></head><body><h1>Workflow Products</h1></body></html>`),
				FetchedAt:   now,
			},
		},
	}}
	engine := NewEngine(
		Config{UserAgent: "SEOPlatformBot/1.0", DiscoveryLimit: 20},
		httpFetcher,
		pageFetcher,
		nil,
	)

	startedAt := time.Now()
	result, err := engine.Run(context.Background(), Task{
		OrganizationID: "org",
		ProjectID:      "project",
		RunID:          "navigation-before-sitemap",
		Type:           TaskSiteUnderstanding,
		TargetURL:      "https://example.com",
		Country:        "US",
		Language:       "en",
		MaxPages:       3,
	})
	elapsed := time.Since(startedAt)
	if err != nil {
		t.Fatalf("Run() returned an error: %v", err)
	}
	if len(result.Pages) != 3 {
		t.Fatalf("page count = %d, want 3", len(result.Pages))
	}
	if elapsed >= 400*time.Millisecond {
		t.Fatalf("site understanding waited %s for a nonessential sitemap", elapsed)
	}
}
