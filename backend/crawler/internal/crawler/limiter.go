package crawler

import (
	"context"
	"math/rand"
	"sync"
	"time"
)

type RequestLimiter struct {
	delay       time.Duration
	randomDelay time.Duration
	mu          sync.Mutex
	lastRequest time.Time
	random      *rand.Rand
}

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
	defer l.mu.Unlock()

	interval := l.delay
	if l.randomDelay > 0 {
		interval += time.Duration(l.random.Int63n(int64(l.randomDelay) + 1))
	}
	wait := time.Until(l.lastRequest.Add(interval))
	if l.lastRequest.IsZero() || wait <= 0 {
		l.lastRequest = time.Now()
		return ctx.Err()
	}

	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		l.lastRequest = time.Now()
		return nil
	}
}
