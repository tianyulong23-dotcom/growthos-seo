package crawler

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/temoto/robotstxt"
)

type RobotsPolicy struct {
	data      *robotstxt.RobotsData
	userAgent string
	disallow  bool
	Sitemaps  []string
}

type RobotsPolicyCache struct {
	fetcher   Fetcher
	userAgent string
	mu        sync.Mutex
	policies  map[string]RobotsPolicy
}

func NewRobotsPolicyCache(fetcher Fetcher, userAgent string) *RobotsPolicyCache {
	return &RobotsPolicyCache{
		fetcher:   fetcher,
		userAgent: userAgent,
		policies:  make(map[string]RobotsPolicy),
	}
}

func (c *RobotsPolicyCache) Policy(
	ctx context.Context,
	target *url.URL,
) (RobotsPolicy, error) {
	if target == nil || target.Hostname() == "" {
		return RobotsPolicy{userAgent: c.userAgent}, nil
	}
	origin := &url.URL{
		Scheme: strings.ToLower(target.Scheme),
		Host:   strings.ToLower(target.Host),
		Path:   "/",
	}
	key := origin.Scheme + "://" + origin.Host
	c.mu.Lock()
	defer c.mu.Unlock()
	if policy, exists := c.policies[key]; exists {
		return policy, nil
	}
	policy, err := LoadRobots(ctx, c.fetcher, origin, c.userAgent)
	if err != nil {
		return RobotsPolicy{}, err
	}
	c.policies[key] = policy
	return policy, nil
}

func (c *RobotsPolicyCache) Allows(ctx context.Context, target *url.URL) (bool, error) {
	policy, err := c.Policy(ctx, target)
	if err != nil {
		return false, err
	}
	return policy.Allows(target), nil
}

func (p RobotsPolicy) Allows(u *url.URL) bool {
	if p.disallow {
		return false
	}
	if p.data == nil || u == nil {
		return true
	}
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	if u.RawQuery != "" {
		path += "?" + u.RawQuery
	}
	return p.data.TestAgent(path, p.userAgent)
}

func LoadRobots(ctx context.Context, fetcher Fetcher, root *url.URL, userAgent string) (RobotsPolicy, error) {
	robotsURL := root.ResolveReference(&url.URL{Path: "/robots.txt"})
	resource, err := fetcher.Fetch(ctx, robotsURL.String())
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return RobotsPolicy{}, ctxErr
		}
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return RobotsPolicy{}, err
		}
		return RobotsPolicy{userAgent: userAgent}, nil
	}
	if resource.StatusCode == http.StatusUnauthorized ||
		resource.StatusCode == http.StatusForbidden {
		return RobotsPolicy{userAgent: userAgent, disallow: true}, nil
	}
	if resource.StatusCode >= http.StatusBadRequest || resource.StatusCode == 0 {
		return RobotsPolicy{userAgent: userAgent}, nil
	}
	data, parseErr := robotstxt.FromStatusAndBytes(resource.StatusCode, resource.Body)
	if parseErr != nil {
		return RobotsPolicy{userAgent: userAgent}, nil
	}
	return RobotsPolicy{
		data:      data,
		userAgent: userAgent,
		Sitemaps:  data.Sitemaps,
	}, nil
}
