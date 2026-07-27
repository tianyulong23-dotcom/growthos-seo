package crawler

import (
	"context"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type RequestLimiter struct {
	delay           time.Duration
	randomDelay     time.Duration
	mu              sync.Mutex
	lastRequest     time.Time
	blockedUntil    time.Time
	adaptiveDelay   time.Duration
	successfulCount int
	random          *rand.Rand
}

const (
	minimumAdaptiveDelay = 100 * time.Millisecond
	maximumAdaptiveDelay = 10 * time.Second
	backoffRecoveryCount = 20
)

func NewRequestLimiter(delay, randomDelay time.Duration) *RequestLimiter {
	return &RequestLimiter{
		delay:       max(delay, 0),
		randomDelay: max(randomDelay, 0),
		random:      rand.New(rand.NewSource(time.Now().UnixNano())),
	}
}

func (l *RequestLimiter) Wait(ctx context.Context) error {
	if l == nil {
		return nil
	}

	l.mu.Lock()
	interval := max(l.delay, l.adaptiveDelay)
	if l.randomDelay > 0 {
		interval += time.Duration(l.random.Int63n(int64(l.randomDelay) + 1))
	}
	now := time.Now()
	readyAt := now
	if nextRequest := l.lastRequest.Add(interval); nextRequest.After(readyAt) {
		readyAt = nextRequest
	}
	if l.blockedUntil.After(readyAt) {
		readyAt = l.blockedUntil
	}
	l.lastRequest = readyAt
	l.mu.Unlock()

	wait := time.Until(readyAt)
	if wait <= 0 {
		return ctx.Err()
	}

	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (l *RequestLimiter) Observe(statusCode int, retryAfter string) {
	if l == nil || statusCode == 0 {
		return
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()
	if statusCode == http.StatusTooManyRequests ||
		statusCode == http.StatusServiceUnavailable {
		baseDelay := max(l.delay, minimumAdaptiveDelay)
		if l.adaptiveDelay < baseDelay {
			l.adaptiveDelay = baseDelay
		}
		l.adaptiveDelay = min(l.adaptiveDelay*2, maximumAdaptiveDelay)
		l.successfulCount = 0
		if retryAt, ok := retryAfterTime(retryAfter, now); ok && retryAt.After(l.blockedUntil) {
			l.blockedUntil = retryAt
			if l.lastRequest.Before(retryAt) {
				l.lastRequest = retryAt
			}
		}
		return
	}

	if statusCode < 200 || statusCode >= 500 || l.adaptiveDelay == 0 {
		return
	}
	l.successfulCount++
	if l.successfulCount < backoffRecoveryCount {
		return
	}
	l.successfulCount = 0
	l.adaptiveDelay /= 2
	if l.adaptiveDelay <= l.delay {
		l.adaptiveDelay = 0
	}
}

func retryAfterTime(value string, now time.Time) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, false
	}
	if seconds, err := strconv.Atoi(value); err == nil {
		if seconds < 0 {
			return time.Time{}, false
		}
		return now.Add(time.Duration(seconds) * time.Second), true
	}
	parsed, err := http.ParseTime(value)
	if err != nil || parsed.Before(now) {
		return time.Time{}, false
	}
	return parsed, true
}
