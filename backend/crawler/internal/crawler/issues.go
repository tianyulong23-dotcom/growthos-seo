package crawler

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

const duplicateSimilarityThreshold = 0.85

type IssueDetector struct {
	ExclusionPatterns  []string
	DuplicationEnabled *bool
	DuplicationLimit   *float64
}

func (detector IssueDetector) Detect(pages []Page) []Issue {
	issues := detector.DetectPageIssues(pages)

	if detector.DuplicationEnabled != nil && !*detector.DuplicationEnabled {
		return issues
	}
	threshold := duplicateSimilarityThreshold
	if detector.DuplicationLimit != nil {
		threshold = *detector.DuplicationLimit
	}
	excluded := make([]bool, len(pages))
	signals := make([]duplicatePageSignals, len(pages))
	for index, page := range pages {
		excluded[index] = detector.shouldExclude(page.URL)
		signals[index] = newDuplicatePageSignals(page)
	}
	scratch := duplicateComparisonScratch{}
	bestMatches := make([]duplicateMatch, len(pages))
	for leftIndex := 0; leftIndex < len(pages); leftIndex++ {
		if excluded[leftIndex] {
			continue
		}
		for rightIndex := leftIndex + 1; rightIndex < len(pages); rightIndex++ {
			if excluded[rightIndex] {
				continue
			}
			similarity := duplicateSimilaritySignalsWithScratch(
				signals[leftIndex],
				signals[rightIndex],
				&scratch,
			)
			if similarity < threshold {
				continue
			}
			bestMatches[leftIndex].consider(rightIndex, similarity)
			bestMatches[rightIndex].consider(leftIndex, similarity)
		}
	}
	for pageIndex, match := range bestMatches {
		if !match.found {
			continue
		}
		issues = append(
			issues,
			duplicateIssue(pages[pageIndex], pages[match.relatedIndex], match.similarity),
		)
	}
	return issues
}

type duplicateMatch struct {
	relatedIndex int
	similarity   float64
	found        bool
}

func (match *duplicateMatch) consider(relatedIndex int, similarity float64) {
	if match.found && similarity <= match.similarity {
		return
	}
	match.relatedIndex = relatedIndex
	match.similarity = similarity
	match.found = true
}

func (detector IssueDetector) DetectPageIssues(pages []Page) []Issue {
	issues := make([]Issue, 0)
	for _, page := range pages {
		if detector.shouldExclude(page.URL) {
			continue
		}
		issues = append(issues, detectPageIssues(page)...)
	}
	return issues
}

func detectPageIssues(page Page) []Issue {
	issues := make([]Issue, 0)
	title := strings.TrimSpace(page.Title)
	switch {
	case title == "":
		issues = append(issues, pageIssue(
			page, "error", "SEO", "missing_title",
			"Missing Title Tag", "Page has no title tag",
		))
	case len([]rune(title)) > 60:
		issues = append(issues, pageIssue(
			page, "warning", "SEO", "title_too_long",
			"Title Too Long",
			fmt.Sprintf("Title is %d characters (recommended: <=60)", len([]rune(title))),
		))
	case len([]rune(title)) < 30:
		issues = append(issues, pageIssue(
			page, "warning", "SEO", "title_too_short",
			"Title Too Short",
			fmt.Sprintf("Title is %d characters (recommended: 30-60)", len([]rune(title))),
		))
	}

	description := strings.TrimSpace(page.Description)
	switch {
	case description == "":
		issues = append(issues, pageIssue(
			page, "error", "SEO", "missing_meta_description",
			"Missing Meta Description", "Page has no meta description",
		))
	case len([]rune(description)) > 160:
		issues = append(issues, pageIssue(
			page, "warning", "SEO", "meta_description_too_long",
			"Meta Description Too Long",
			fmt.Sprintf(
				"Description is %d characters (recommended: <=160)",
				len([]rune(description)),
			),
		))
	case len([]rune(description)) < 120:
		issues = append(issues, pageIssue(
			page, "warning", "SEO", "meta_description_too_short",
			"Meta Description Too Short",
			fmt.Sprintf(
				"Description is %d characters (recommended: 120-160)",
				len([]rune(description)),
			),
		))
	}

	if len(page.H1) == 0 {
		issues = append(issues, pageIssue(
			page, "error", "SEO", "missing_h1",
			"Missing H1 Tag", "Page has no H1 heading",
		))
	}
	if page.WordCount < 300 {
		issues = append(issues, pageIssue(
			page, "warning", "Content", "thin_content",
			"Thin Content",
			fmt.Sprintf("Page has only %d words (recommended: >=300)", page.WordCount),
		))
	}

	if page.StatusCode == 0 &&
		strings.TrimSpace(page.ErrorType) != "" &&
		page.ErrorType != "file_too_large" {
		issue, details := noResponseIssue(page)
		issues = append(issues, pageIssue(
			page, "error", "Technical", "crawl_error", issue, details,
		))
	}
	switch {
	case page.StatusCode >= 400 && page.StatusCode < 500:
		issues = append(issues, pageIssue(
			page, "error", "Technical", "client_error",
			fmt.Sprintf("%d Client Error", page.StatusCode),
			statusCodeMessage(page.StatusCode),
		))
	case page.StatusCode >= 500:
		issues = append(issues, pageIssue(
			page, "error", "Technical", "server_error",
			fmt.Sprintf("%d Server Error", page.StatusCode),
			statusCodeMessage(page.StatusCode),
		))
	case page.StatusCode >= 300:
		issues = append(issues, pageIssue(
			page, "info", "Technical", "redirect",
			fmt.Sprintf("%d Redirect", page.StatusCode),
			"URL redirects to another location",
		))
	}

	canonical := strings.TrimSpace(page.Canonical)
	if canonical == "" {
		issues = append(issues, pageIssue(
			page, "warning", "Technical", "missing_canonical",
			"Missing Canonical URL", "Page has no canonical URL specified",
		))
	} else if canonical != page.URL {
		issues = append(issues, pageIssue(
			page, "warning", "Technical", "canonical_different",
			"Canonical URL Different", "Canonical points to: "+canonical,
		))
	}

	if strings.TrimSpace(page.Viewport) == "" {
		issues = append(issues, pageIssue(
			page, "error", "Mobile", "missing_viewport",
			"Missing Viewport Meta Tag", "Page is not mobile-optimized",
		))
	}
	if strings.TrimSpace(page.Language) == "" {
		issues = append(issues, pageIssue(
			page, "warning", "Accessibility", "missing_language",
			"Missing Language Attribute", "HTML tag has no lang attribute",
		))
	}
	missingAlt := 0
	for _, image := range page.Images {
		if strings.TrimSpace(image.Alt) == "" {
			missingAlt++
		}
	}
	if missingAlt > 0 {
		issues = append(issues, pageIssue(
			page, "warning", "Accessibility", "image_missing_alt",
			"Images Without Alt Text",
			fmt.Sprintf("%d of %d images lack alt text", missingAlt, len(page.Images)),
		))
	}
	if len(page.OpenGraph) == 0 {
		issues = append(issues, pageIssue(
			page, "warning", "Social", "missing_open_graph",
			"Missing OpenGraph Tags", "Page has no OpenGraph tags for social sharing",
		))
	}
	if len(page.TwitterTags) == 0 {
		issues = append(issues, pageIssue(
			page, "warning", "Social", "missing_twitter_card",
			"Missing Twitter Card Tags", "Page has no Twitter Card tags",
		))
	}
	if len(page.StructuredData) == 0 && len(page.SchemaMicrodata) == 0 {
		issues = append(issues, pageIssue(
			page, "error", "Structured Data", "no_structured_data",
			"No Structured Data", "Page has no JSON-LD or Schema.org markup",
		))
	}

	switch {
	case page.ResponseTimeMS > 3000:
		issues = append(issues, pageIssue(
			page, "error", "Performance", "slow_response",
			"Slow Response Time",
			fmt.Sprintf(
				"Page took %dms to respond (recommended: <3000ms)",
				page.ResponseTimeMS,
			),
		))
	case page.ResponseTimeMS > 1000:
		issues = append(issues, pageIssue(
			page, "warning", "Performance", "moderate_response",
			"Moderate Response Time",
			fmt.Sprintf(
				"Page took %dms to respond (recommended: <1000ms)",
				page.ResponseTimeMS,
			),
		))
	}
	switch {
	case page.SizeBytes > 3*1024*1024:
		issues = append(issues, pageIssue(
			page, "error", "Performance", "large_page",
			"Large Page Size",
			fmt.Sprintf(
				"Page size is %.1fMB (recommended: <3MB)",
				float64(page.SizeBytes)/1024/1024,
			),
		))
	case page.SizeBytes > 1024*1024:
		issues = append(issues, pageIssue(
			page, "warning", "Performance", "moderate_page_size",
			"Moderate Page Size",
			fmt.Sprintf(
				"Page size is %.1fMB (recommended: <1MB)",
				float64(page.SizeBytes)/1024/1024,
			),
		))
	}

	robots := strings.ToLower(page.Robots)
	if strings.Contains(robots, "noindex") {
		issues = append(issues, pageIssue(
			page, "error", "Indexability", "noindex",
			"Noindex Tag Present",
			"Page is BLOCKED from search engines - has noindex directive",
		))
	}
	if strings.Contains(robots, "nofollow") {
		issues = append(issues, pageIssue(
			page, "error", "Indexability", "nofollow",
			"Nofollow Tag Present",
			"Links on this page are NOT followed by search engines - has nofollow directive",
		))
	}
	for _, image := range page.BrokenImages {
		switch {
		case image.StatusCode == 0:
			issues = append(issues, pageIssue(
				page, "error", "Content", "broken_image",
				"Broken Image (No Response)",
				"Image does not respond: "+image.URL,
			))
		case image.StatusCode >= 400:
			issues = append(issues, pageIssue(
				page, "error", "Content", "broken_image",
				fmt.Sprintf("Broken Image (%d)", image.StatusCode),
				fmt.Sprintf("Image returned %d: %s", image.StatusCode, image.URL),
			))
		}
	}

	return issues
}

func noResponseIssue(page Page) (string, string) {
	defaults := map[string][2]string{
		"dns_not_found": {
			"DNS Not Found",
			"Domain does not resolve. The site may be expired or misconfigured.",
		},
		"connection_refused": {
			"Connection Refused",
			"Server actively refused the connection.",
		},
		"timeout": {
			"Request Timeout",
			"Server did not respond before the request timed out.",
		},
		"ssl_error": {
			"SSL/TLS Error",
			"Could not establish a secure connection (certificate or TLS issue).",
		},
		"connection_error": {
			"Connection Error",
			"Could not connect to the server.",
		},
	}
	value, ok := defaults[page.ErrorType]
	if !ok {
		value = [2]string{"No Response", "No HTTP response received."}
	}
	if strings.TrimSpace(page.Error) != "" {
		value[1] = page.Error
	}
	return value[0], value[1]
}

func statusCodeMessage(statusCode int) string {
	messages := map[int]string{
		400: "Bad Request",
		401: "Unauthorized",
		403: "Forbidden",
		404: "Not Found",
		405: "Method Not Allowed",
		406: "Not Acceptable",
		408: "Request Timeout",
		410: "Gone",
		429: "Too Many Requests",
		500: "Internal Server Error",
		501: "Not Implemented",
		502: "Bad Gateway",
		503: "Service Unavailable",
		504: "Gateway Timeout",
		505: "HTTP Version Not Supported",
	}
	if message, ok := messages[statusCode]; ok {
		return message
	}
	return fmt.Sprintf("HTTP %d Error", statusCode)
}

func pageIssue(page Page, severity, category, code, issue, details string) Issue {
	return Issue{
		Type:     severity,
		Category: category,
		Code:     code,
		Issue:    issue,
		Details:  details,
		URL:      page.URL,
	}
}

func duplicateIssue(page, related Page, similarity float64) Issue {
	return Issue{
		Type:     "warning",
		Category: "Duplication",
		Code:     "duplicate_content",
		Issue:    "Duplicate Content Detected",
		Details: fmt.Sprintf(
			"Content is %.1f%% similar to %s",
			similarity*100,
			related.URL,
		),
		URL:        page.URL,
		RelatedURL: related.URL,
		Similarity: similarity,
	}
}

func duplicateSimilarity(left, right Page) float64 {
	return duplicateSimilaritySignals(
		newDuplicatePageSignals(left),
		newDuplicatePageSignals(right),
	)
}

type duplicatePageSignals struct {
	title       sequenceSignal
	description sequenceSignal
	h1          sequenceSignal
	wordCount   int
}

func newDuplicatePageSignals(page Page) duplicatePageSignals {
	return duplicatePageSignals{
		title:       newSequenceSignal(page.Title),
		description: newSequenceSignal(page.Description),
		h1:          newSequenceSignal(firstH1(page)),
		wordCount:   page.WordCount,
	}
}

func duplicateSimilaritySignals(left, right duplicatePageSignals) float64 {
	score := 0.35*right.title.similarity(left.title) +
		0.35*right.description.similarity(left.description) +
		0.20*right.h1.similarity(left.h1) +
		0.10*wordCountSimilarity(left.wordCount, right.wordCount)
	return score
}

type duplicateComparisonScratch struct {
	title       runeSequenceMatcherScratch
	description runeSequenceMatcherScratch
	h1          runeSequenceMatcherScratch
}

func duplicateSimilaritySignalsWithScratch(
	left,
	right duplicatePageSignals,
	scratch *duplicateComparisonScratch,
) float64 {
	score := 0.35*right.title.similarityWithScratch(left.title, &scratch.title) +
		0.35*right.description.similarityWithScratch(
			left.description,
			&scratch.description,
		) +
		0.20*right.h1.similarityWithScratch(left.h1, &scratch.h1) +
		0.10*wordCountSimilarity(left.wordCount, right.wordCount)
	return score
}

func firstH1(page Page) string {
	if len(page.H1) == 0 {
		return ""
	}
	return page.H1[0]
}

func wordCountSimilarity(left, right int) float64 {
	if left <= 0 || right <= 0 {
		return 0
	}
	return float64(min(left, right)) / float64(max(left, right))
}

func sequenceMatcherSimilarity(left, right string) float64 {
	return newSequenceSignal(right).similarity(newSequenceSignal(left))
}

type sequenceSignal struct {
	runes   []rune
	matcher runeSequenceMatcher
}

func newSequenceSignal(value string) sequenceSignal {
	runes := []rune(strings.ToLower(strings.TrimSpace(value)))
	return sequenceSignal{
		runes:   runes,
		matcher: newRuneSequenceMatcher(runes),
	}
}

func (right sequenceSignal) similarity(left sequenceSignal) float64 {
	scratch := runeSequenceMatcherScratch{}
	return right.similarityWithScratch(left, &scratch)
}

func (right sequenceSignal) similarityWithScratch(
	left sequenceSignal,
	scratch *runeSequenceMatcherScratch,
) float64 {
	if len(left.runes) == 0 || len(right.runes) == 0 {
		return 0
	}
	matches := right.matcher.matchingCountWithReusableScratch(
		left.runes,
		0,
		len(left.runes),
		0,
		len(right.runes),
		scratch,
	)
	return float64(2*matches) / float64(len(left.runes)+len(right.runes))
}

type runeSequenceMatcher struct {
	right []rune
	index map[rune][]int
}

func newRuneSequenceMatcher(right []rune) runeSequenceMatcher {
	index := make(map[rune][]int)
	for position, current := range right {
		index[current] = append(index[current], position)
	}
	if len(right) >= 200 {
		popularThreshold := len(right)/100 + 1
		for current, positions := range index {
			if len(positions) > popularThreshold {
				delete(index, current)
			}
		}
	}
	return runeSequenceMatcher{right: right, index: index}
}

func (matcher runeSequenceMatcher) matchingCount(
	left []rune,
	leftLow, leftHigh, rightLow, rightHigh int,
) int {
	scratch := runeSequenceMatcherScratch{}
	return matcher.matchingCountWithReusableScratch(
		left,
		leftLow,
		leftHigh,
		rightLow,
		rightHigh,
		&scratch,
	)
}

func (matcher runeSequenceMatcher) matchingCountWithReusableScratch(
	left []rune,
	leftLow, leftHigh, rightLow, rightHigh int,
	scratch *runeSequenceMatcherScratch,
) int {
	scratch.ensureSize(len(matcher.right) + 1)
	return matcher.matchingCountWithScratch(
		left,
		leftLow,
		leftHigh,
		rightLow,
		rightHigh,
		scratch,
	)
}

type runeSequenceMatcherScratch struct {
	values     []int
	stamps     []int
	generation int
}

func (scratch *runeSequenceMatcherScratch) ensureSize(size int) {
	if len(scratch.values) >= size {
		return
	}
	scratch.values = make([]int, size)
	scratch.stamps = make([]int, size)
	scratch.generation = 0
}

func (matcher runeSequenceMatcher) matchingCountWithScratch(
	left []rune,
	leftLow, leftHigh, rightLow, rightHigh int,
	scratch *runeSequenceMatcherScratch,
) int {
	leftStart, rightStart, length := matcher.longestMatch(
		left,
		leftLow,
		leftHigh,
		rightLow,
		rightHigh,
		scratch,
	)
	if length == 0 {
		return 0
	}
	return length +
		matcher.matchingCountWithScratch(
			left,
			leftLow,
			leftStart,
			rightLow,
			rightStart,
			scratch,
		) +
		matcher.matchingCountWithScratch(
			left,
			leftStart+length,
			leftHigh,
			rightStart+length,
			rightHigh,
			scratch,
		)
}

func (matcher runeSequenceMatcher) longestMatch(
	left []rune,
	leftLow, leftHigh, rightLow, rightHigh int,
	scratch *runeSequenceMatcherScratch,
) (int, int, int) {
	bestLeft, bestRight, bestLength := leftLow, rightLow, 0
	previousGeneration := -1
	for leftIndex := leftLow; leftIndex < leftHigh; leftIndex++ {
		scratch.generation++
		currentGeneration := scratch.generation
		for _, rightIndex := range matcher.index[left[leftIndex]] {
			if rightIndex < rightLow {
				continue
			}
			if rightIndex >= rightHigh {
				break
			}
			length := 1
			if scratch.stamps[rightIndex] == previousGeneration {
				length = scratch.values[rightIndex] + 1
			}
			scratch.values[rightIndex+1] = length
			scratch.stamps[rightIndex+1] = currentGeneration
			if length > bestLength {
				bestLength = length
				bestLeft = leftIndex - length + 1
				bestRight = rightIndex - length + 1
			}
		}
		previousGeneration = currentGeneration
	}

	for bestLeft > leftLow &&
		bestRight > rightLow &&
		left[bestLeft-1] == matcher.right[bestRight-1] {
		bestLeft--
		bestRight--
		bestLength++
	}
	for bestLeft+bestLength < leftHigh &&
		bestRight+bestLength < rightHigh &&
		left[bestLeft+bestLength] == matcher.right[bestRight+bestLength] {
		bestLength++
	}
	return bestLeft, bestRight, bestLength
}

func (detector IssueDetector) shouldExclude(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	path := parsed.Path
	for _, rawPattern := range detector.ExclusionPatterns {
		pattern := strings.TrimSpace(rawPattern)
		if pattern == "" {
			continue
		}
		if strings.Contains(pattern, "*") {
			if wildcardPattern(pattern).MatchString(path) {
				return true
			}
			continue
		}
		if path == pattern || strings.HasPrefix(path, strings.TrimSuffix(pattern, "*")) {
			return true
		}
	}
	return false
}

func wildcardPattern(pattern string) *regexp.Regexp {
	parts := strings.Split(regexp.QuoteMeta(pattern), `\*`)
	return regexp.MustCompile("^" + strings.Join(parts, ".*") + "$")
}
