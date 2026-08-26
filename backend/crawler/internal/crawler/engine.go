package crawler

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/PuerkitoBio/goquery"
)

type Engine struct {
	config                  Config
	http                    Fetcher
	status                  StatusChecker
	fetcher                 Fetcher
	parser                  Parser
	reporter                ProgressReporter
	processor               PageArtifactProcessor
	checkpoint              CheckpointStore
	pagespeed               PageSpeedAnalyzer
	resourceChecksTruncated bool
}

const (
	siteUnderstandingSitemapDocumentLimit = 4
	siteUnderstandingSitemapTimeout       = 5 * time.Second
	siteUnderstandingBatchSize            = 5
	technicalAuditBatchSize               = 50
	imageStatusPageConcurrency            = 5
	imageStatusPerPageConcurrency         = 5
	imageStatusPerPageLimit               = 50
	checkpointAttemptBatchSize            = 50
	checkpointInterval                    = 30 * time.Second
)

type EngineOption func(*Engine)

func WithPageArtifactProcessor(processor PageArtifactProcessor) EngineOption {
	return func(engine *Engine) {
		engine.processor = processor
	}
}

func WithCheckpointStore(store CheckpointStore) EngineOption {
	return func(engine *Engine) {
		engine.checkpoint = store
	}
}

func WithPageSpeedAnalyzer(analyzer PageSpeedAnalyzer) EngineOption {
	return func(engine *Engine) {
		engine.pagespeed = analyzer
	}
}

func NewEngine(
	config Config,
	httpFetcher,
	fetcher Fetcher,
	reporter ProgressReporter,
	options ...EngineOption,
) *Engine {
	if reporter == nil {
		reporter = ProgressReporterFunc(func(Progress) {})
	}
	engine := &Engine{
		config:    config,
		http:      httpFetcher,
		fetcher:   fetcher,
		parser:    Parser{},
		reporter:  reporter,
		pagespeed: NewGooglePageSpeedAnalyzer(config),
	}
	if checker, ok := httpFetcher.(StatusChecker); ok {
		engine.status = checker
	}
	for _, option := range options {
		option(engine)
	}
	return engine
}

func (e *Engine) Run(ctx context.Context, task Task) (result Result, err error) {
	if err := task.Validate(); err != nil {
		return Result{}, err
	}
	result = Result{TaskType: task.Type, RunID: task.RunID, StartedAt: time.Now().UTC()}
	e.resourceChecksTruncated = false

	switch task.Type {
	case TaskSiteUnderstanding, TaskTechnicalAudit:
		result.Pages, err = e.crawlSite(ctx, task)
		if err == nil && task.Type == TaskSiteUnderstanding {
			result.CompletionStatus = CompletionComplete
		}
		if err == nil && task.Type == TaskTechnicalAudit {
			e.report(
				StageCheckingLinks,
				"正在检查页面链接",
				len(result.Pages),
				len(result.Pages),
				len(result.Pages),
			)
			result.ExternalResources, err = e.checkLinkStatuses(ctx, result.Pages)
			if err == nil {
				err = e.updateResultCheckpoint(
					ctx,
					task,
					result.Pages,
					nil,
					result.ExternalResources,
				)
			}
			if e.resourceChecksTruncated {
				result.ResourceChecksTruncated = true
				result.CompletionNote = "技术审计已完成，但部分附加资源超过检查保护上限，部分图片或链接未检查状态"
			}
		}
		if err == nil && task.Type == TaskTechnicalAudit {
			result.CompletionStatus = CompletionComplete
			result.Issues = (IssueDetector{
				ExclusionPatterns:  task.IssueExclusions,
				DuplicationEnabled: task.EnableDuplication,
				DuplicationLimit:   task.DuplicationLimit,
			}).Detect(result.Pages)
			err = e.updateResultCheckpoint(
				ctx,
				task,
				result.Pages,
				result.Issues,
				result.ExternalResources,
			)
			if err == nil && task.EnablePageSpeed && e.pagespeed != nil {
				e.report(
					StagePageSpeed,
					"正在运行 PageSpeed 分析",
					len(result.Pages),
					len(result.Pages),
					len(result.Pages),
				)
				result.PageSpeed = e.pagespeed.Analyze(ctx, result.Pages)
				if ctx.Err() != nil {
					err = ctx.Err()
				}
			}
			if err == nil {
				e.report(
					StageCompleted,
					"技术审计处理完成",
					len(result.Pages),
					len(result.Pages),
					len(result.Pages),
				)
			}
		}
	case TaskBacklinkValidation:
		result.Backlinks, err = e.validateBacklinks(ctx, task)
		if err == nil {
			result.CompletionStatus = CompletionComplete
		}
	case TaskContentResearch, TaskSourceVerification:
		result.Pages, result.CompletionStatus, err = e.crawlRequestedURLs(ctx, task)
		if err == nil && result.CompletionStatus == CompletionPartial {
			result.CompletionNote = "部分页面抓取失败，已保留成功页面并继续处理"
		}
	default:
		err = fmt.Errorf("unsupported task type %q", task.Type)
	}
	return result, err
}

func (e *Engine) crawlRequestedURLs(
	ctx context.Context,
	task Task,
) ([]Page, CompletionStatus, error) {
	ctx = withRequestLocale(ctx, task.Language, task.Country)
	limit := task.PageLimit()
	pages := make([]Page, 0, limit)
	successful := 0
	e.report(StageAnalyzing, "正在抓取指定资料页面", limit, 0, 0)

	for index, rawURL := range task.URLs[:limit] {
		if err := ctx.Err(); err != nil {
			return pages, CompletionPartial, err
		}
		resource, fetchErr := e.fetchResource(ctx, rawURL)
		page := pageFromResource(resource, 0, "")
		if fetchErr == nil && resource.StatusCode >= 200 && resource.StatusCode < 400 && isHTML(resource) {
			parsed, parseErr := e.parser.Parse(resource, 0, "")
			if parseErr == nil {
				page = parsed
				page.Score = ScorePage(page)
				if e.processor != nil {
					page, parseErr = e.processor.ProcessPage(ctx, task, page, resource)
				}
			}
			if parseErr == nil {
				successful++
			} else {
				page = pageFromResource(resource, 0, "")
				page.Error = parseErr.Error()
				page.ErrorType = "parse_error"
			}
		} else if fetchErr == nil {
			switch {
			case resource.StatusCode < 200 || resource.StatusCode >= 400:
				page.Error = fmt.Sprintf("HTTP status %d", resource.StatusCode)
				page.ErrorType = "http_status"
			case !isHTML(resource):
				page.Error = "response is not an HTML page"
				page.ErrorType = "unsupported_content_type"
			}
		}
		pages = append(pages, page)
		e.report(StageExtracting, "正在整理资料页面", limit, index+1, successful)
	}

	status := CompletionComplete
	if successful != limit {
		status = CompletionPartial
	}
	e.report(StageCompleted, "资料页面抓取完成", limit, limit, successful)
	return pages, status, nil
}

func (e *Engine) crawlSite(ctx context.Context, task Task) ([]Page, error) {
	scope, root, err := NewScopeWithOptions(
		task.TargetURL,
		task.AdditionalHosts,
		task.ScopeMode(),
		task.Directory,
		task.AllowedPaths,
		task.ExcludedPaths,
		task.IgnoredParameters,
	)
	if err != nil {
		return nil, err
	}
	ctx = withScope(ctx, scope)
	ctx = withRequestLocale(ctx, task.Language, task.Country)
	if err := ValidatePublicURL(ctx, net.DefaultResolver, root); err != nil {
		return nil, err
	}
	limit := task.PageLimit()
	discoveryLimit := max(e.config.DiscoveryLimit, limit)
	attemptLimit := discoveryLimit
	if task.Type == TaskSiteUnderstanding {
		attemptLimit = min(discoveryLimit, max(limit*2, siteUnderstandingMinimumAttempts))
	}

	e.report(StageAnalyzing, "正在分析网站", 0, 0, 0)
	candidates := make(map[string]Candidate)
	processed := make(map[string]struct{})
	selectedURLs := make(map[string]struct{})
	pages := make([]Page, 0, limit)
	attempted := 0
	imageStatusCache := make(map[string]int)
	rejectedLanguages := make(map[string]struct{})
	prefetched := make(map[string]Resource)
	prefetchedErrors := make(map[string]error)
	restored := false
	if e.checkpoint != nil {
		checkpoint, found, loadErr := e.checkpoint.LoadCheckpoint(ctx, task)
		if loadErr != nil {
			return nil, loadErr
		}
		if found {
			for index, state := range checkpoint.Candidates {
				candidate, candidateErr := candidateFromState(state)
				if candidateErr == nil && scope.Allows(candidate.URL) {
					if candidate.DiscoveryOrder <= 0 {
						candidate.DiscoveryOrder = index + 1
					}
					candidates[candidate.URL.String()] = candidate
				}
			}
			for _, value := range checkpoint.Processed {
				processed[value] = struct{}{}
			}
			pages = append(pages, checkpoint.Pages...)
			attempted = checkpoint.Attempted
			for key, status := range checkpoint.ImageStatus {
				imageStatusCache[key] = status
			}
			for _, language := range checkpoint.RejectedLanguages {
				rejectedLanguages[language] = struct{}{}
			}
			for _, page := range pages {
				selectedURLs[crawlURLKey(defaultString(page.FinalURL, page.URL))] = struct{}{}
			}
			restored = attempted > 0 || len(processed) > 0 || len(pages) > 0
			if restored {
				e.report(
					StageDiscovering,
					"已从检查点恢复抓取进度",
					len(candidates),
					attempted,
					len(pages),
				)
			}
		}
	}
	if !restored {
		addCandidate(candidates, Candidate{URL: root, Depth: 0})
		if err := e.saveCheckpoint(
			ctx,
			task,
			candidates,
			processed,
			pages,
			attempted,
			imageStatusCache,
			rejectedLanguages,
		); err != nil {
			return nil, err
		}
	}
	var homepageResource Resource
	var homepageErr error
	homepageFetched := false
	robots := NewRobotsPolicyCache(
		e.http,
		defaultString(e.config.RobotsUserAgent, defaultRobotsUserAgent),
	)
	policy := RobotsPolicy{}
	if task.Type == TaskTechnicalAudit {
		var policyErr error
		policy, policyErr = robots.Policy(ctx, root)
		if policyErr != nil {
			return nil, policyErr
		}
	}
	rootAllowed, robotsErr := taskURLAllowed(ctx, task.Type, robots, root)
	if robotsErr != nil {
		return nil, robotsErr
	}
	if !restored && rootAllowed {
		homepageResource, homepageErr = e.fetchResource(ctx, root.String())
		homepageFetched = true
	}
	if !restored {
		addCandidate(candidates, Candidate{URL: root, Depth: 0})
		cacheHomepage := false
		if homepageFetched {
			cacheHomepage = task.Type == TaskTechnicalAudit ||
				homepageErr == nil ||
				homepageResource.StatusCode != 0
			if cacheHomepage {
				prefetched[root.String()] = homepageResource
				prefetchedErrors[root.String()] = homepageErr
			}
		}
		if homepageFetched && (homepageErr == nil || homepageResource.StatusCode != 0) {
			finalURL, parseErr := url.Parse(homepageResource.FinalURL)
			if parseErr == nil && scope.Allows(finalURL) {
				normalized, normalizeErr := scope.Normalize(finalURL.String(), nil)
				if normalizeErr == nil {
					addCandidate(candidates, Candidate{URL: normalized, Depth: 0})
					if cacheHomepage {
						prefetched[normalized.String()] = homepageResource
						prefetchedErrors[normalized.String()] = homepageErr
					}
				}
				if isHTML(homepageResource) {
					homepage, pageErr := e.parser.Parse(homepageResource, 0, "")
					if pageErr == nil {
						addMatchingHreflangCandidates(
							candidates,
							scope,
							homepage,
							task,
							discoveryLimit,
						)
						if pageMatchesRequestedLocale(task, homepage) {
							addPageLinks(
								candidates,
								scope,
								homepage,
								discoveryLimit,
								task.Type,
							)
						}
					}
				}
			}
		}

		if task.Type == TaskTechnicalAudit {
			sitemapCandidates, _ := DiscoverSitemapURLs(
				ctx,
				e.http,
				scope,
				defaultSitemapURLs(root, policy.Sitemaps),
				discoveryLimit,
			)
			for _, candidate := range sitemapCandidates {
				addCandidate(candidates, candidate)
			}
		}
		e.report(StageDiscovering, "已发现页面", len(candidates), 0, 0)
		if err := e.saveCheckpoint(
			ctx,
			task,
			candidates,
			processed,
			pages,
			attempted,
			imageStatusCache,
			rejectedLanguages,
		); err != nil {
			return nil, err
		}
	}
	lastCheckpointAttempted := attempted
	lastCheckpointAt := time.Now()
	var imageScheduler *imageStatusScheduler
	if task.Type == TaskTechnicalAudit && e.status != nil {
		imageCtx, cancelImages := context.WithCancel(ctx)
		imageScheduler = newImageStatusScheduler(
			imageCtx,
			e.status,
			e.config,
			imageStatusCache,
		)
		defer func() {
			cancelImages()
			imageScheduler.CloseAndWait()
		}()
		for _, page := range pages {
			imageScheduler.EnqueuePage(page)
		}
	}
	for len(pages) < limit && attempted < attemptLimit {
		if err := ctx.Err(); err != nil {
			return pages, err
		}
		candidate, ok := bestCandidate(candidates, processed, task.Type, pages)
		if !ok {
			break
		}
		value := candidate.URL.String()
		processed[value] = struct{}{}
		allowed, robotsErr := taskURLAllowed(ctx, task.Type, robots, candidate.URL)
		if robotsErr != nil {
			return nil, robotsErr
		}
		if !allowed {
			continue
		}
		attempted++

		batch := []Candidate{candidate}
		_, firstIsPrefetched := prefetched[value]
		batchFetcher, supportsBatch := e.fetcher.(BatchFetcher)
		if task.Type == TaskSiteUnderstanding && supportsBatch && !firstIsPrefetched {
			batchLimit := min(
				siteUnderstandingBatchSize,
				limit-len(pages),
				attemptLimit-attempted+1,
			)
			occupiedRoles := siteUnderstandingPageRoleCounts(pages)
			occupiedRoles[CandidateBusinessRole(candidate)]++
			for _, additional := range pendingSiteUnderstandingCandidates(
				candidates,
				processed,
				occupiedRoles,
				batchLimit-1,
			) {
				processed[additional.URL.String()] = struct{}{}
				allowed, robotsErr := taskURLAllowed(ctx, task.Type, robots, additional.URL)
				if robotsErr != nil {
					return nil, robotsErr
				}
				if allowed {
					attempted++
					batch = append(batch, additional)
				}
			}
		}
		if task.Type == TaskTechnicalAudit && supportsBatch && !firstIsPrefetched {
			batchLimit := min(
				technicalAuditBatchSize,
				limit-len(pages),
				attemptLimit-attempted+1,
			)
			for _, additional := range pendingTechnicalCandidates(
				candidates,
				processed,
				batchLimit-len(batch),
			) {
				additionalURL := additional.URL.String()
				processed[additionalURL] = struct{}{}
				allowed, robotsErr := taskURLAllowed(ctx, task.Type, robots, additional.URL)
				if robotsErr != nil {
					return nil, robotsErr
				}
				if !allowed {
					continue
				}
				attempted++
				batch = append(batch, additional)
			}
		}

		outcomes := make([]FetchOutcome, len(batch))
		if firstIsPrefetched {
			resource, fetchErr := normalizeFetchedResource(
				value,
				prefetched[value],
				prefetchedErrors[value],
				time.Now(),
			)
			outcomes[0] = FetchOutcome{Resource: resource, Err: fetchErr}
		} else if supportsBatch {
			startedAt := time.Now()
			rawURLs := make([]string, len(batch))
			for index, item := range batch {
				rawURLs[index] = item.URL.String()
			}
			fetched := batchFetcher.FetchMany(ctx, rawURLs)
			for index, rawURL := range rawURLs {
				if index >= len(fetched) {
					outcomes[index] = FetchOutcome{
						Resource: Resource{URL: rawURL, FinalURL: rawURL},
						Err:      errors.New("batch fetcher returned fewer results than requested"),
					}
					continue
				}
				resource, fetchErr := normalizeFetchedResource(
					rawURL,
					fetched[index].Resource,
					fetched[index].Err,
					startedAt,
				)
				outcomes[index] = FetchOutcome{Resource: resource, Err: fetchErr}
			}
		} else {
			resource, fetchErr := e.fetchResource(ctx, value)
			outcomes[0] = FetchOutcome{Resource: resource, Err: fetchErr}
		}

		batchPageStart := len(pages)
		for index, candidate := range batch {
			value := candidate.URL.String()
			resource := outcomes[index].Resource
			fetchErr := outcomes[index].Err
			if fetchErr != nil && resource.StatusCode == 0 {
				if task.Type == TaskTechnicalAudit {
					page := pageFromResource(resource, candidate.Depth, candidate.DiscoveredFrom)
					page.Score = candidate.Score
					pages = append(pages, page)
					selectedURLs[crawlURLKey(value)] = struct{}{}
					e.report(
						StageExtracting,
						"正在整理重要页面",
						len(candidates),
						attempted,
						len(pages),
					)
				}
				continue
			}
			finalURL, parseErr := url.Parse(resource.FinalURL)
			if parseErr != nil || !scope.Allows(finalURL) {
				continue
			}
			normalizedFinal, normalizeErr := scope.Normalize(finalURL.String(), nil)
			if normalizeErr != nil {
				continue
			}
			processed[normalizedFinal.String()] = struct{}{}
			finalKey := crawlURLKey(normalizedFinal.String())
			if _, exists := selectedURLs[finalKey]; exists {
				continue
			}
			if !isHTML(resource) {
				if task.Type == TaskTechnicalAudit {
					page := pageFromResource(resource, candidate.Depth, candidate.DiscoveredFrom)
					page.Score = candidate.Score
					pages = append(pages, page)
					selectedURLs[finalKey] = struct{}{}
				}
				continue
			}

			page, parseErr := e.parser.Parse(resource, candidate.Depth, candidate.DiscoveredFrom)
			if parseErr != nil {
				if task.Type == TaskTechnicalAudit {
					resource.Error = parseErr.Error()
					resource.ErrorType = "parse_error"
					page := pageFromResource(resource, candidate.Depth, candidate.DiscoveredFrom)
					page.Score = candidate.Score
					pages = append(pages, page)
					selectedURLs[finalKey] = struct{}{}
				}
				continue
			}
			page.Score = ScorePage(page)

			if task.Type == TaskSiteUnderstanding && (page.StatusCode < 200 || page.StatusCode >= 400) {
				continue
			}
			if task.Type == TaskSiteUnderstanding {
				addMatchingHreflangCandidates(
					candidates,
					scope,
					page,
					task,
					discoveryLimit,
				)
				// Prefer the requested locale when the site advertises one. If it does
				// not, business understanding must use the language the site actually
				// serves instead of failing the whole project.
				if !pageMatchesRequestedLocale(task, page) &&
					pageHasRequestedLocaleAlternate(task, page) {
					if language := strings.TrimSpace(page.Language); language != "" {
						rejectedLanguages[language] = struct{}{}
					}
					continue
				}
			}
			addPageLinks(candidates, scope, page, discoveryLimit, task.Type)
			if task.Type == TaskSiteUnderstanding && !siteUnderstandingPageEligible(page, pages) {
				continue
			}
			if e.processor != nil {
				page, err = e.processor.ProcessPage(ctx, task, page, resource)
				if err != nil {
					return nil, err
				}
			}
			pages = append(pages, page)
			selectedURLs[finalKey] = struct{}{}
			e.report(StageExtracting, "正在整理重要页面", len(candidates), attempted, len(pages))
		}
		if imageScheduler != nil && len(pages) > batchPageStart {
			for index := batchPageStart; index < len(pages); index++ {
				imageScheduler.EnqueuePage(pages[index])
			}
		}
		now := time.Now()
		if checkpointDue(
			lastCheckpointAttempted,
			attempted,
			lastCheckpointAt,
			now,
		) {
			if imageScheduler != nil {
				imageStatusCache = imageScheduler.Snapshot()
			}
			if err := e.saveCheckpoint(
				ctx,
				task,
				candidates,
				processed,
				pages,
				attempted,
				imageStatusCache,
				rejectedLanguages,
			); err != nil {
				return nil, err
			}
			lastCheckpointAttempted = attempted
			lastCheckpointAt = now
		}
	}
	if imageScheduler != nil {
		for _, page := range pages {
			imageScheduler.EnqueuePage(page)
		}
		imageScheduler.CloseAndWait()
		imageStatusCache = imageScheduler.Snapshot()
		applyImageStatuses(pages, imageStatusCache)
		if imageScheduler.Truncated() {
			e.resourceChecksTruncated = true
		}
	}
	if err := e.saveCheckpoint(
		ctx,
		task,
		candidates,
		processed,
		pages,
		attempted,
		imageStatusCache,
		rejectedLanguages,
	); err != nil {
		return nil, err
	}

	if task.Type == TaskSiteUnderstanding {
		iconCtx, cancelIcon := context.WithTimeout(withoutScope(ctx), 5*time.Second)
		icon := resolveSiteIcon(iconCtx, e.http, pages)
		cancelIcon()
		if icon.URL != "" {
			homepageIndex := representativeHomepageIndex(task.TargetURL, pages)
			if homepageIndex >= 0 {
				pages[homepageIndex].FaviconURL = icon.URL
				pages[homepageIndex].FaviconContentType = icon.ContentType
				pages[homepageIndex].FaviconBody = icon.Body
			}
		}
	}
	if len(pages) > limit {
		pages = pages[:limit]
	}
	if task.Type == TaskSiteUnderstanding && len(pages) == 0 {
		if len(rejectedLanguages) > 0 {
			languages := make([]string, 0, len(rejectedLanguages))
			for language := range rejectedLanguages {
				languages = append(languages, language)
			}
			sort.Strings(languages)
			return nil, fmt.Errorf(
				"未找到符合项目语言 %s 的页面；网站返回的页面语言为 %s",
				task.Language,
				strings.Join(languages, "、"),
			)
		}
		return nil, errors.New("site crawl returned no usable HTML pages")
	}
	if task.Type == TaskTechnicalAudit && len(pages) == 0 {
		return nil, errors.New("technical audit returned no crawlable pages")
	}
	e.report(StageSelecting, "正在整理重要页面", len(candidates), attempted, len(pages))
	return pages, nil
}

func checkpointDue(
	lastAttempted int,
	attempted int,
	lastSavedAt time.Time,
	now time.Time,
) bool {
	return attempted-lastAttempted >= checkpointAttemptBatchSize ||
		(!lastSavedAt.IsZero() && now.Sub(lastSavedAt) >= checkpointInterval)
}

func (e *Engine) saveCheckpoint(
	ctx context.Context,
	task Task,
	candidates map[string]Candidate,
	processed map[string]struct{},
	pages []Page,
	attempted int,
	imageStatus map[string]int,
	rejectedLanguages map[string]struct{},
) error {
	if e.checkpoint == nil {
		return nil
	}
	checkpoint := CrawlCheckpoint{
		Candidates:  make([]CandidateState, 0, len(candidates)),
		Processed:   make([]string, 0, len(processed)),
		Pages:       checkpointPages(task, pages),
		Attempted:   attempted,
		ImageStatus: make(map[string]int, len(imageStatus)),
	}
	for language := range rejectedLanguages {
		checkpoint.RejectedLanguages = append(checkpoint.RejectedLanguages, language)
	}
	sort.Strings(checkpoint.RejectedLanguages)
	if task.Type == TaskTechnicalAudit {
		checkpoint.Issues = (IssueDetector{
			ExclusionPatterns: task.IssueExclusions,
		}).DetectPageIssues(pages)
	}
	for _, candidate := range candidates {
		checkpoint.Candidates = append(checkpoint.Candidates, candidateState(candidate))
	}
	sort.Slice(checkpoint.Candidates, func(i, j int) bool {
		return checkpoint.Candidates[i].URL < checkpoint.Candidates[j].URL
	})
	for value := range processed {
		checkpoint.Processed = append(checkpoint.Processed, value)
	}
	sort.Strings(checkpoint.Processed)
	for key, status := range imageStatus {
		checkpoint.ImageStatus[key] = status
	}
	return e.checkpoint.SaveCheckpoint(ctx, task, checkpoint)
}

func (e *Engine) updateResultCheckpoint(
	ctx context.Context,
	task Task,
	pages []Page,
	issues []Issue,
	externalResources []ExternalResource,
) error {
	if e.checkpoint == nil {
		return nil
	}
	checkpoint, found, err := e.checkpoint.LoadCheckpoint(ctx, task)
	if err != nil || !found {
		return err
	}
	checkpoint.Pages = checkpointPages(task, pages)
	if issues != nil {
		checkpoint.Issues = append([]Issue(nil), issues...)
	}
	if externalResources != nil {
		checkpoint.ExternalResources = append(
			[]ExternalResource(nil),
			externalResources...,
		)
	}
	return e.checkpoint.SaveCheckpoint(ctx, task, checkpoint)
}

func checkpointPages(task Task, pages []Page) []Page {
	checkpointPages := append([]Page(nil), pages...)
	if task.Type != TaskTechnicalAudit {
		return checkpointPages
	}
	for index := range checkpointPages {
		checkpointPages[index].MainText = ""
		checkpointPages[index].MainHTML = ""
	}
	return checkpointPages
}

func candidateState(candidate Candidate) CandidateState {
	value := ""
	if candidate.URL != nil {
		value = candidate.URL.String()
	}
	return CandidateState{
		URL:             value,
		Depth:           candidate.Depth,
		DiscoveryOrder:  candidate.DiscoveryOrder,
		DiscoveredFrom:  candidate.DiscoveredFrom,
		AnchorText:      candidate.AnchorText,
		Placement:       candidate.Placement,
		InNavigation:    candidate.InNavigation,
		FromSitemap:     candidate.FromSitemap,
		SitemapPriority: candidate.SitemapPriority,
		LocalePriority:  candidate.LocalePriority,
		Score:           candidate.Score,
	}
}

func candidateFromState(state CandidateState) (Candidate, error) {
	candidateURL, err := url.Parse(state.URL)
	if err != nil || candidateURL.Hostname() == "" {
		return Candidate{}, fmt.Errorf("invalid checkpoint candidate URL %q", state.URL)
	}
	return Candidate{
		URL:             candidateURL,
		Depth:           state.Depth,
		DiscoveryOrder:  state.DiscoveryOrder,
		DiscoveredFrom:  state.DiscoveredFrom,
		AnchorText:      state.AnchorText,
		Placement:       state.Placement,
		InNavigation:    state.InNavigation,
		FromSitemap:     state.FromSitemap,
		SitemapPriority: state.SitemapPriority,
		LocalePriority:  state.LocalePriority,
		Score:           state.Score,
	}, nil
}

func (e *Engine) checkImageStatuses(
	ctx context.Context,
	page *Page,
	cache map[string]int,
) {
	pages := []Page{*page}
	e.checkImageStatusesForPages(ctx, pages, cache)
	*page = pages[0]
}

type imageStatusScheduler struct {
	ctx                context.Context
	checker            StatusChecker
	perPageConcurrency int
	resourceLimit      int
	pageJobs           chan []string
	workerGroup        sync.WaitGroup
	closeOnce          sync.Once

	mu        sync.Mutex
	statuses  map[string]int
	pending   map[string]struct{}
	truncated bool
}

func newImageStatusScheduler(
	ctx context.Context,
	checker StatusChecker,
	config Config,
	initial map[string]int,
) *imageStatusScheduler {
	statuses := make(map[string]int, len(initial))
	for rawURL, status := range initial {
		statuses[rawURL] = status
	}
	scheduler := &imageStatusScheduler{
		ctx:     ctx,
		checker: checker,
		perPageConcurrency: min(
			positiveOrDefault(config.StatusConcurrency, imageStatusPerPageConcurrency),
			imageStatusPerPageConcurrency,
		),
		resourceLimit: positiveOrDefault(config.ResourceCheckLimit, 50_000),
		pageJobs:      make(chan []string, technicalAuditBatchSize),
		statuses:      statuses,
		pending:       make(map[string]struct{}),
	}
	for range imageStatusPageConcurrency {
		scheduler.workerGroup.Add(1)
		go func() {
			defer scheduler.workerGroup.Done()
			for urls := range scheduler.pageJobs {
				scheduler.checkPage(urls)
			}
		}()
	}
	return scheduler
}

func (s *imageStatusScheduler) EnqueuePage(page Page) {
	if s == nil {
		return
	}
	urls := make([]string, 0, imageStatusPerPageLimit)
	for _, link := range page.Links {
		if link.Placement != "image" {
			continue
		}
		s.mu.Lock()
		_, completed := s.statuses[link.URL]
		_, queued := s.pending[link.URL]
		if completed || queued {
			s.mu.Unlock()
			continue
		}
		if len(urls) >= imageStatusPerPageLimit ||
			len(s.statuses)+len(s.pending) >= s.resourceLimit {
			s.truncated = true
			s.mu.Unlock()
			continue
		}
		s.pending[link.URL] = struct{}{}
		s.mu.Unlock()
		urls = append(urls, link.URL)
	}
	if len(urls) == 0 {
		return
	}
	select {
	case s.pageJobs <- urls:
	case <-s.ctx.Done():
		s.releasePending(urls)
	}
}

func (s *imageStatusScheduler) checkPage(urls []string) {
	jobs := make(chan string, len(urls))
	for _, rawURL := range urls {
		jobs <- rawURL
	}
	close(jobs)

	var group sync.WaitGroup
	for range min(s.perPageConcurrency, len(urls)) {
		group.Add(1)
		go func() {
			defer group.Done()
			for rawURL := range jobs {
				status, err := s.checker.CheckStatus(s.ctx, rawURL)
				if err != nil {
					status = 0
				}
				s.mu.Lock()
				s.statuses[rawURL] = status
				delete(s.pending, rawURL)
				s.mu.Unlock()
			}
		}()
	}
	group.Wait()
}

func (s *imageStatusScheduler) releasePending(urls []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, rawURL := range urls {
		delete(s.pending, rawURL)
	}
}

func (s *imageStatusScheduler) CloseAndWait() {
	if s == nil {
		return
	}
	s.closeOnce.Do(func() {
		close(s.pageJobs)
	})
	s.workerGroup.Wait()
}

func (s *imageStatusScheduler) Snapshot() map[string]int {
	if s == nil {
		return map[string]int{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	statuses := make(map[string]int, len(s.statuses))
	for rawURL, status := range s.statuses {
		statuses[rawURL] = status
	}
	return statuses
}

func (s *imageStatusScheduler) Truncated() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.truncated
}

func (e *Engine) checkImageStatusesForPages(
	ctx context.Context,
	pages []Page,
	cache map[string]int,
) {
	if e.status == nil {
		return
	}
	imageCtx, cancelImages := context.WithCancel(ctx)
	defer cancelImages()
	scheduler := newImageStatusScheduler(imageCtx, e.status, e.config, cache)
	for _, page := range pages {
		scheduler.EnqueuePage(page)
	}
	scheduler.CloseAndWait()
	statuses := scheduler.Snapshot()
	clear(cache)
	for rawURL, status := range statuses {
		cache[rawURL] = status
	}
	applyImageStatuses(pages, cache)
	if scheduler.Truncated() {
		e.resourceChecksTruncated = true
	}
}

func applyImageStatuses(pages []Page, statuses map[string]int) {
	for pageIndex := range pages {
		page := &pages[pageIndex]
		page.BrokenImages = page.BrokenImages[:0]
		for linkIndex := range page.Links {
			link := &page.Links[linkIndex]
			if link.Placement != "image" {
				continue
			}
			if status, exists := statuses[link.URL]; exists {
				link.TargetStatus = intPointer(status)
			}
			if link.TargetStatus != nil &&
				(*link.TargetStatus == 0 || *link.TargetStatus >= 400) {
				page.BrokenImages = append(page.BrokenImages, BrokenImage{
					URL:        link.URL,
					StatusCode: *link.TargetStatus,
				})
			}
		}
	}
}

func (e *Engine) checkLinkStatuses(
	ctx context.Context,
	pages []Page,
) ([]ExternalResource, error) {
	statusByURL := make(map[string]int, len(pages)*2)
	checkedResourceKeys := make(map[string]struct{})
	for _, page := range pages {
		statusByURL[crawlURLKey(page.URL)] = page.StatusCode
		statusByURL[crawlURLKey(defaultString(page.FinalURL, page.URL))] = page.StatusCode
		for _, link := range page.Links {
			if link.TargetStatus != nil {
				key := crawlURLKey(link.URL)
				statusByURL[key] = *link.TargetStatus
				checkedResourceKeys[key] = struct{}{}
			}
		}
	}

	pendingInternalByURL := make(map[string]string)
	pendingExternalByURL := make(map[string]string)
	for pageIndex := range pages {
		for linkIndex := range pages[pageIndex].Links {
			link := &pages[pageIndex].Links[linkIndex]
			key := crawlURLKey(link.URL)
			if status, exists := statusByURL[key]; exists {
				link.TargetStatus = intPointer(status)
				continue
			}
			if link.IsInternal {
				if e.status != nil {
					pendingInternalByURL[key] = link.URL
				}
			} else if e.http != nil {
				pendingExternalByURL[key] = link.URL
			}
		}
	}
	resourceLimit := positiveOrDefault(e.config.ResourceCheckLimit, 50_000)
	remainingChecks := max(resourceLimit-len(checkedResourceKeys), 0)
	if len(pendingInternalByURL)+len(pendingExternalByURL) > remainingChecks {
		e.resourceChecksTruncated = true
	}
	pendingInternalByURL, remainingChecks = limitedPendingResources(
		pendingInternalByURL,
		remainingChecks,
	)
	pendingExternalByURL, _ = limitedPendingResources(
		pendingExternalByURL,
		remainingChecks,
	)
	if len(pendingInternalByURL) == 0 && len(pendingExternalByURL) == 0 {
		return nil, ctx.Err()
	}

	type linkStatusJob struct {
		key      string
		rawURL   string
		external bool
	}
	jobs := make(chan linkStatusJob, len(pendingInternalByURL)+len(pendingExternalByURL))
	for key, rawURL := range pendingInternalByURL {
		jobs <- linkStatusJob{key: key, rawURL: rawURL}
	}
	for key, rawURL := range pendingExternalByURL {
		jobs <- linkStatusJob{key: key, rawURL: rawURL, external: true}
	}
	close(jobs)

	var mutex sync.Mutex
	var group sync.WaitGroup
	externalByURL := make(map[string]ExternalResource, len(pendingExternalByURL))
	workerCount := min(
		positiveOrDefault(e.config.StatusConcurrency, 5),
		len(pendingInternalByURL)+len(pendingExternalByURL),
	)
	for range workerCount {
		group.Add(1)
		go func() {
			defer group.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case job, ok := <-jobs:
					if !ok {
						return
					}
					status := 0
					var externalResource ExternalResource
					if job.external {
						startedAt := time.Now()
						resource, fetchErr := e.http.Fetch(withoutScope(ctx), job.rawURL)
						resource, _ = normalizeFetchedResource(
							job.rawURL,
							resource,
							fetchErr,
							startedAt,
						)
						status = resource.StatusCode
						externalResource = externalResourceFromFetched(resource)
					} else {
						var statusErr error
						status, statusErr = e.status.CheckStatus(ctx, job.rawURL)
						if statusErr != nil {
							status = 0
						}
					}
					mutex.Lock()
					statusByURL[job.key] = status
					if job.external {
						externalByURL[job.key] = externalResource
					}
					mutex.Unlock()
				}
			}
		}()
	}
	group.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	for pageIndex := range pages {
		for linkIndex := range pages[pageIndex].Links {
			link := &pages[pageIndex].Links[linkIndex]
			if status, exists := statusByURL[crawlURLKey(link.URL)]; exists {
				link.TargetStatus = intPointer(status)
			}
		}
	}
	externalResources := make([]ExternalResource, 0, len(externalByURL))
	for _, resource := range externalByURL {
		externalResources = append(externalResources, resource)
	}
	sort.Slice(externalResources, func(i, j int) bool {
		return externalResources[i].URL < externalResources[j].URL
	})
	return externalResources, nil
}

func limitedPendingResources(
	resources map[string]string,
	remaining int,
) (map[string]string, int) {
	if len(resources) <= remaining {
		return resources, remaining - len(resources)
	}
	keys := make([]string, 0, len(resources))
	for key := range resources {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	limited := make(map[string]string, remaining)
	for _, key := range keys[:remaining] {
		limited[key] = resources[key]
	}
	return limited, 0
}

func externalResourceFromFetched(resource Resource) ExternalResource {
	title := ""
	if strings.Contains(strings.ToLower(resource.ContentType), "html") && len(resource.Body) > 0 {
		document, err := goquery.NewDocumentFromReader(strings.NewReader(string(resource.Body)))
		if err == nil {
			title = cleanText(document.Find("title").First().Text())
		}
	}
	return ExternalResource{
		URL:         resource.URL,
		FinalURL:    resource.FinalURL,
		StatusCode:  resource.StatusCode,
		ContentType: resource.ContentType,
		SizeBytes:   resource.SizeBytes,
		Title:       title,
		Error:       resource.Error,
		ErrorType:   resource.ErrorType,
		CheckedAt:   resource.FetchedAt,
	}
}

func intPointer(value int) *int {
	return &value
}

func (e *Engine) fetchResource(ctx context.Context, rawURL string) (Resource, error) {
	startedAt := time.Now()
	resource, err := e.fetcher.Fetch(ctx, rawURL)
	return normalizeFetchedResource(rawURL, resource, err, startedAt)
}

func normalizeFetchedResource(
	rawURL string,
	resource Resource,
	err error,
	startedAt time.Time,
) (Resource, error) {
	if resource.URL == "" {
		resource.URL = rawURL
	}
	if resource.FinalURL == "" {
		resource.FinalURL = rawURL
	}
	if resource.FetchedAt.IsZero() {
		resource.FetchedAt = time.Now().UTC()
	}
	if resource.ResponseTimeMS <= 0 {
		resource.ResponseTimeMS = max(1, int(time.Since(startedAt).Milliseconds()))
	}
	if resource.SizeBytes <= 0 {
		resource.SizeBytes = int64(len(resource.Body))
	}
	if err != nil {
		resource.Error = err.Error()
		resource.ErrorType = classifyFetchError(err)
	}
	return resource, err
}

func pageFromResource(resource Resource, depth int, discoveredFrom string) Page {
	finalURL := resource.FinalURL
	if finalURL == "" {
		finalURL = resource.URL
	}
	return Page{
		URL:            resource.URL,
		FinalURL:       finalURL,
		StatusCode:     resource.StatusCode,
		ContentType:    resource.ContentType,
		Rendered:       resource.Rendered,
		ResponseTimeMS: resource.ResponseTimeMS,
		SizeBytes:      resource.SizeBytes,
		Redirects:      append([]Redirect(nil), resource.Redirects...),
		Error:          resource.Error,
		ErrorType:      resource.ErrorType,
		Depth:          depth,
		DiscoveredFrom: discoveredFrom,
		FetchedAt:      resource.FetchedAt,
	}
}

func classifyFetchError(err error) string {
	if err == nil {
		return ""
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "dns_not_found"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "timeout"
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "connection refused"):
		return "connection_refused"
	case strings.Contains(message, "certificate"),
		strings.Contains(message, "tls"),
		strings.Contains(message, "ssl"):
		return "ssl_error"
	case strings.Contains(message, "timeout"),
		strings.Contains(message, "deadline exceeded"):
		return "timeout"
	default:
		return "connection_error"
	}
}

func (e *Engine) validateBacklinks(ctx context.Context, task Task) ([]BacklinkResult, error) {
	results := make([]BacklinkResult, 0, len(task.URLs))
	e.report(StageAnalyzing, "正在检查外链页面", len(task.URLs), 0, 0)
	for index, rawURL := range task.URLs {
		item := BacklinkResult{URL: rawURL, CheckedAt: time.Now().UTC()}
		resource, err := e.fetcher.Fetch(ctx, rawURL)
		item.FinalURL = resource.FinalURL
		item.StatusCode = resource.StatusCode
		if err != nil && resource.StatusCode == 0 {
			item.Error = err.Error()
			results = append(results, item)
			continue
		}
		if isHTML(resource) {
			page, parseErr := e.parser.Parse(resource, 0, "")
			if parseErr != nil {
				item.Error = parseErr.Error()
			} else {
				item.FoundLinks = matchingLinks(page.Links, task.ExpectedLinks)
			}
		}
		results = append(results, item)
		e.report(StageExtracting, "正在检查外链页面", len(task.URLs), index+1, len(results))
	}
	e.report(StageCompleted, "外链检查完成", len(task.URLs), len(results), len(results))
	return results, nil
}

func (e *Engine) report(stage ProgressStage, message string, discovered, processed, selected int) {
	e.reporter.Report(Progress{
		Stage:      stage,
		Message:    message,
		Discovered: discovered,
		Processed:  processed,
		Selected:   selected,
		OccurredAt: time.Now().UTC(),
	})
}

func taskURLAllowed(
	ctx context.Context,
	taskType TaskType,
	robots *RobotsPolicyCache,
	target *url.URL,
) (bool, error) {
	if taskType == TaskSiteUnderstanding {
		return true, nil
	}
	return robots.Allows(ctx, target)
}

func addCandidate(candidates map[string]Candidate, candidate Candidate) {
	if candidate.URL == nil {
		return
	}
	candidate.Score = ScoreCandidate(candidate)
	value := candidate.URL.String()
	previous, exists := candidates[value]
	if !exists {
		if candidate.DiscoveryOrder <= 0 {
			candidate.DiscoveryOrder = len(candidates) + 1
		}
		candidates[value] = candidate
		return
	}
	previousWasInNavigation := previous.InNavigation
	previous.InNavigation = previous.InNavigation || candidate.InNavigation
	previous.FromSitemap = previous.FromSitemap || candidate.FromSitemap
	if candidate.AnchorText != "" &&
		(previous.AnchorText == "" || candidate.InNavigation && !previousWasInNavigation) {
		previous.AnchorText = candidate.AnchorText
	}
	if previous.Placement == "" || candidate.InNavigation {
		previous.Placement = candidate.Placement
	}
	if candidate.SitemapPriority > previous.SitemapPriority {
		previous.SitemapPriority = candidate.SitemapPriority
	}
	if candidate.LocalePriority > previous.LocalePriority {
		previous.LocalePriority = candidate.LocalePriority
	}
	if candidate.Depth < previous.Depth {
		previous.Depth = candidate.Depth
		previous.DiscoveredFrom = candidate.DiscoveredFrom
	}
	previous.Score = ScoreCandidate(previous)
	candidates[value] = previous
}

func addPageLinks(
	candidates map[string]Candidate,
	scope Scope,
	page Page,
	limit int,
	taskType TaskType,
) {
	if len(candidates) >= limit {
		return
	}
	if taskType == TaskSiteUnderstanding && page.Depth >= 2 {
		return
	}
	base, err := url.Parse(page.FinalURL)
	if err != nil {
		return
	}
	for _, link := range page.Links {
		if link.Placement == "image" {
			continue
		}
		normalized, err := scope.Normalize(link.URL, base)
		if err != nil {
			continue
		}
		if taskType == TaskTechnicalAudit && !technicalAuditURLAllowed(normalized) {
			continue
		}
		addCandidate(candidates, Candidate{
			URL:            normalized,
			Depth:          page.Depth + 1,
			DiscoveredFrom: page.FinalURL,
			AnchorText:     link.Text,
			Placement:      link.Placement,
			InNavigation:   link.InNavigation,
		})
		if len(candidates) >= limit {
			return
		}
	}
}

func bestCandidate(
	candidates map[string]Candidate,
	processed map[string]struct{},
	taskType TaskType,
	pages []Page,
) (Candidate, bool) {
	if taskType == TaskTechnicalAudit {
		var selected Candidate
		selectedKey := ""
		found := false
		for value, candidate := range candidates {
			if _, exists := processed[value]; exists {
				continue
			}
			if !technicalAuditURLAllowed(candidate.URL) {
				continue
			}
			if !found ||
				candidate.Depth < selected.Depth ||
				candidate.Depth == selected.Depth && value < selectedKey {
				selected = candidate
				selectedKey = value
				found = true
			}
		}
		return selected, found
	}

	pending := make([]Candidate, 0, len(candidates))
	for value, candidate := range candidates {
		if _, exists := processed[value]; !exists {
			if taskType == TaskSiteUnderstanding &&
				(candidate.Depth > 2 || CandidateBusinessRole(candidate) == BusinessPageUtility) {
				continue
			}
			pending = append(pending, candidate)
		}
	}
	if len(pending) == 0 {
		return Candidate{}, false
	}
	if taskType == TaskSiteUnderstanding {
		selected := selectSiteUnderstandingCandidates(
			pending,
			siteUnderstandingPageRoleCounts(pages),
			1,
		)
		if len(selected) == 0 {
			return Candidate{}, false
		}
		return selected[0], true
	}
	return Candidate{}, false
}

func pendingTechnicalCandidates(
	candidates map[string]Candidate,
	processed map[string]struct{},
	limit int,
) []Candidate {
	if limit <= 0 {
		return nil
	}
	pending := make([]technicalCandidateChoice, 0, limit)
	for value, candidate := range candidates {
		if _, exists := processed[value]; exists {
			continue
		}
		if !technicalAuditURLAllowed(candidate.URL) {
			continue
		}
		choice := technicalCandidateChoice{candidate: candidate, key: value}
		if len(pending) < limit {
			pending = append(pending, choice)
			sort.Slice(pending, func(i, j int) bool {
				return technicalCandidateChoiceLess(pending[i], pending[j])
			})
			continue
		}
		if !technicalCandidateChoiceLess(choice, pending[len(pending)-1]) {
			continue
		}
		pending[len(pending)-1] = choice
		sort.Slice(pending, func(i, j int) bool {
			return technicalCandidateChoiceLess(pending[i], pending[j])
		})
	}
	result := make([]Candidate, len(pending))
	for index, choice := range pending {
		result[index] = choice.candidate
	}
	return result
}

type technicalCandidateChoice struct {
	candidate Candidate
	key       string
}

func technicalCandidateChoiceLess(left, right technicalCandidateChoice) bool {
	if left.candidate.Depth == right.candidate.Depth {
		return left.key < right.key
	}
	return left.candidate.Depth < right.candidate.Depth
}

func technicalAuditURLAllowed(value *url.URL) bool {
	if value == nil {
		return false
	}
	segment := value.Path
	if index := strings.LastIndex(segment, "/"); index >= 0 {
		segment = segment[index+1:]
	}
	index := strings.LastIndex(segment, ".")
	if index < 0 {
		return true
	}
	extension := strings.ToLower(strings.TrimSpace(segment[index+1:]))
	switch extension {
	case "html", "htm", "php", "asp", "aspx", "jsp":
		return true
	default:
		return false
	}
}

func defaultSitemapURLs(root *url.URL, declared []string) []string {
	values := append([]string(nil), declared...)
	for _, path := range []string{
		"/sitemap.xml",
		"/sitemap_index.xml",
		"/sitemaps.xml",
		"/sitemap/sitemap.xml",
	} {
		values = append(values, root.ResolveReference(&url.URL{Path: path}).String())
	}
	return uniqueStrings(values)
}

func pendingSiteUnderstandingCandidates(
	candidates map[string]Candidate,
	processed map[string]struct{},
	occupiedRoles map[BusinessPageRole]int,
	limit int,
) []Candidate {
	if limit <= 0 {
		return nil
	}
	pending := make([]Candidate, 0, len(candidates))
	for value, candidate := range candidates {
		if _, exists := processed[value]; !exists {
			if candidate.Depth > 2 || !siteUnderstandingCandidateEligible(candidate) {
				continue
			}
			pending = append(pending, candidate)
		}
	}
	return selectSiteUnderstandingCandidates(pending, occupiedRoles, limit)
}

func selectSiteUnderstandingCandidates(
	candidates []Candidate,
	occupiedRoles map[BusinessPageRole]int,
	limit int,
) []Candidate {
	selected := make([]Candidate, 0, min(limit, len(candidates)))
	roleCounts := make(map[BusinessPageRole]int, len(occupiedRoles))
	for role, count := range occupiedRoles {
		roleCounts[role] = count
	}
	used := make([]bool, len(candidates))
	for len(selected) < limit {
		bestIndex := -1
		for index, candidate := range candidates {
			role := CandidateBusinessRole(candidate)
			if used[index] || !siteUnderstandingCandidateEligible(candidate) ||
				roleCounts[role] >= siteUnderstandingCandidateRoleLimit(role) {
				continue
			}
			if bestIndex < 0 || siteUnderstandingCandidateLess(
				candidate,
				candidates[bestIndex],
				roleCounts,
			) {
				bestIndex = index
			}
		}
		if bestIndex < 0 {
			break
		}
		candidate := candidates[bestIndex]
		role := CandidateBusinessRole(candidate)
		used[bestIndex] = true
		roleCounts[role]++
		selected = append(selected, candidate)
	}
	return selected
}

func siteUnderstandingCandidateLess(
	left Candidate,
	right Candidate,
	roleCounts map[BusinessPageRole]int,
) bool {
	leftPriority := siteUnderstandingRolePriority(
		CandidateBusinessRole(left),
		roleCounts[CandidateBusinessRole(left)],
	)
	rightPriority := siteUnderstandingRolePriority(
		CandidateBusinessRole(right),
		roleCounts[CandidateBusinessRole(right)],
	)
	if leftPriority != rightPriority {
		return leftPriority < rightPriority
	}
	if left.Depth != right.Depth {
		return left.Depth < right.Depth
	}
	if candidatePathDepth(left) != candidatePathDepth(right) {
		return candidatePathDepth(left) < candidatePathDepth(right)
	}
	if left.DiscoveryOrder != right.DiscoveryOrder {
		return left.DiscoveryOrder < right.DiscoveryOrder
	}
	return left.URL.String() < right.URL.String()
}

func candidatePathDepth(candidate Candidate) int {
	if candidate.URL == nil {
		return 0
	}
	path := strings.Trim(candidate.URL.Path, "/")
	if path == "" {
		return 0
	}
	return len(strings.Split(path, "/"))
}

func siteUnderstandingPageRoleCounts(pages []Page) map[BusinessPageRole]int {
	roles := make(map[BusinessPageRole]int, len(pages))
	for _, page := range pages {
		role := PageBusinessRole(page)
		if siteUnderstandingRoleEligible(role) {
			roles[role]++
		}
	}
	return roles
}

func siteUnderstandingRoleLimit(role BusinessPageRole) int {
	if role == BusinessPageOffering {
		return 2
	}
	return 1
}

func siteUnderstandingRoleEligible(role BusinessPageRole) bool {
	switch role {
	case BusinessPageHomepage, BusinessPageAbout, BusinessPageOffering,
		BusinessPagePricing, BusinessPageProof:
		return true
	default:
		return false
	}
}

func siteUnderstandingCandidateEligible(candidate Candidate) bool {
	if candidate.Depth > 2 {
		return false
	}
	return CandidateBusinessRole(candidate) != BusinessPageUtility
}

func siteUnderstandingCandidateRoleLimit(role BusinessPageRole) int {
	if role == BusinessPageOther {
		return siteUnderstandingHardLimit
	}
	return siteUnderstandingRoleLimit(role)
}

func siteUnderstandingPageEligible(page Page, selected []Page) bool {
	if pageLooksLikeErrorShell(page) {
		return false
	}
	role := PageBusinessRole(page)
	if !siteUnderstandingRoleEligible(role) || siteUnderstandingPageValue(page) < 0 {
		return false
	}
	for _, retained := range selected {
		if PageBusinessRole(retained) == role &&
			duplicateSimilarity(retained, page) >= 0.85 {
			return false
		}
	}
	return siteUnderstandingPageRoleCounts(selected)[role] < siteUnderstandingRoleLimit(role)
}

func siteUnderstandingRolePriority(role BusinessPageRole, occupied int) int {
	switch role {
	case BusinessPageHomepage:
		return 0
	case BusinessPageAbout:
		return 1
	case BusinessPageOffering:
		if occupied > 0 {
			return 5
		}
		return 2
	case BusinessPagePricing:
		return 3
	case BusinessPageProof:
		return 4
	case BusinessPageOther:
		return 6
	case BusinessPageContact:
		return 7
	case BusinessPageContent:
		return 8
	default:
		return 9
	}
}

func isHTML(resource Resource) bool {
	contentType := strings.ToLower(resource.ContentType)
	if strings.Contains(contentType, "text/html") || strings.Contains(contentType, "application/xhtml+xml") {
		return true
	}
	trimmed := strings.TrimSpace(strings.ToLower(string(resource.Body[:min(len(resource.Body), 256)])))
	return strings.HasPrefix(trimmed, "<!doctype html") || strings.HasPrefix(trimmed, "<html")
}

func matchingLinks(links []Link, expected []string) []Link {
	if len(expected) == 0 {
		return links
	}
	expectedSet := make(map[string]struct{}, len(expected))
	for _, value := range expected {
		expectedSet[normalizeComparisonURL(value)] = struct{}{}
	}
	result := make([]Link, 0)
	for _, link := range links {
		if _, exists := expectedSet[normalizeComparisonURL(link.URL)]; exists {
			result = append(result, link)
		}
	}
	return result
}

func normalizeComparisonURL(value string) string {
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil {
		return strings.TrimSpace(value)
	}
	u.Fragment = ""
	u.Host = strings.ToLower(u.Host)
	u.Path = strings.TrimSuffix(u.Path, "/")
	return u.String()
}

func crawlURLKey(value string) string {
	return normalizeComparisonURL(value)
}

func preferredLocaleValues(language, country string) []string {
	language = strings.ReplaceAll(strings.TrimSpace(language), "_", "-")
	country = strings.ToUpper(strings.TrimSpace(country))
	if language == "" {
		return nil
	}
	parts := strings.Split(language, "-")
	primary := strings.ToLower(parts[0])
	values := []string{language}
	if len(parts) == 1 && len(country) == 2 {
		values = append([]string{primary + "-" + country}, values...)
	}
	if !strings.EqualFold(values[len(values)-1], primary) {
		values = append(values, primary)
	}
	return uniqueStrings(values)
}
