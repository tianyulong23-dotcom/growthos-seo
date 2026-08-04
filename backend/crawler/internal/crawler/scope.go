package crawler

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path"
	"sort"
	"strings"

	"golang.org/x/net/publicsuffix"
)

type Scope struct {
	targetHost      string
	registrableHost string
	privateSuffix   bool
	mode            ScopeMode
	directory       string
	allowedPaths    []string
	excludedPaths   []string
	ignoredParams   []string
	allowedHosts    map[string]struct{}
}

type scopeContextKey struct{}

type contextWithoutScope struct {
	context.Context
}

func (ctx contextWithoutScope) Value(key any) any {
	if _, ok := key.(scopeContextKey); ok {
		return nil
	}
	return ctx.Context.Value(key)
}

func withScope(ctx context.Context, scope Scope) context.Context {
	return context.WithValue(ctx, scopeContextKey{}, scope)
}

func withoutScope(ctx context.Context) context.Context {
	return contextWithoutScope{Context: ctx}
}

func scopeFromContext(ctx context.Context) (Scope, bool) {
	scope, ok := ctx.Value(scopeContextKey{}).(Scope)
	return scope, ok
}

func validateContextScope(ctx context.Context, u *url.URL) error {
	scope, exists := scopeFromContext(ctx)
	if exists && !scope.Allows(u) {
		return errors.New("URL is outside the project domain")
	}
	return nil
}

func NewScope(rawTarget string) (Scope, *url.URL, error) {
	return NewScopeWithHosts(rawTarget, nil)
}

func NewScopeWithHosts(rawTarget string, additionalHosts []string) (Scope, *url.URL, error) {
	return NewScopeWithOptions(
		rawTarget,
		additionalHosts,
		ScopeDomain,
		"",
		nil,
		nil,
		nil,
	)
}

func NewScopeWithOptions(
	rawTarget string,
	additionalHosts []string,
	mode ScopeMode,
	directory string,
	allowedPaths []string,
	excludedPaths []string,
	ignoredParameters []string,
) (Scope, *url.URL, error) {
	target, err := parsedURL(rawTarget)
	if err != nil {
		return Scope{}, nil, err
	}
	target.RawQuery = ""
	target.Fragment = ""

	host := strings.ToLower(strings.TrimSuffix(target.Hostname(), "."))
	registrable, privateSuffix, err := registrableDomain(host)
	if err != nil {
		return Scope{}, nil, fmt.Errorf("target must use a public domain: %w", err)
	}

	if mode == "" {
		mode = ScopeDomain
	}
	if mode != ScopeDomain && mode != ScopeSubdomains && mode != ScopeDirectory {
		return Scope{}, nil, fmt.Errorf("unsupported scope %q", mode)
	}

	directory = normalizedPathPrefix(directory)
	if mode == ScopeDirectory {
		if directory == "" {
			return Scope{}, nil, errors.New("directory is required for directory scope")
		}
		target.Path = directory
	} else {
		target.Path = "/"
	}

	allowedHosts := map[string]struct{}{host: {}}
	if !privateSuffix && (host == registrable || host == "www."+registrable) {
		allowedHosts[registrable] = struct{}{}
		allowedHosts["www."+registrable] = struct{}{}
	}
	for _, rawHost := range additionalHosts {
		additionalHost, err := normalizedAdditionalHost(rawHost)
		if err != nil {
			return Scope{}, nil, err
		}
		additionalRegistrable, additionalPrivateSuffix, err := registrableDomain(additionalHost)
		if err != nil ||
			privateSuffix ||
			additionalPrivateSuffix ||
			additionalRegistrable != registrable {
			return Scope{}, nil, fmt.Errorf(
				"additional host %q must be a subdomain of %s",
				rawHost,
				registrable,
			)
		}
		allowedHosts[additionalHost] = struct{}{}
	}

	return Scope{
		targetHost:      host,
		registrableHost: registrable,
		privateSuffix:   privateSuffix,
		mode:            mode,
		directory:       directory,
		allowedPaths:    normalizedPathPrefixes(allowedPaths),
		excludedPaths:   normalizedPathPrefixes(excludedPaths),
		ignoredParams:   normalizedParameters(ignoredParameters),
		allowedHosts:    allowedHosts,
	}, target, nil
}

func (s Scope) Allows(u *url.URL) bool {
	if u == nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if !s.allowsHost(host) {
		return false
	}

	value := cleanURLPath(u.Path)
	if s.directory != "" && !pathMatches(value, s.directory) {
		return false
	}
	if len(s.allowedPaths) > 0 && !matchesAnyPath(value, s.allowedPaths) {
		return false
	}
	return !matchesAnyPath(value, s.excludedPaths)
}

func (s Scope) Normalize(raw string, base *url.URL) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return nil, err
	}
	if base != nil {
		u = base.ResolveReference(u)
	}
	if !s.Allows(u) {
		return nil, errors.New("URL is outside the project domain")
	}

	u.Fragment = ""
	u.Host = strings.ToLower(u.Host)
	if (u.Scheme == "https" && u.Port() == "443") || (u.Scheme == "http" && u.Port() == "80") {
		u.Host = u.Hostname()
	}
	u.Path = cleanURLPath(u.Path)

	query := u.Query()
	for key := range query {
		if s.ignoresParameter(key) {
			query.Del(key)
		}
	}
	u.RawQuery = query.Encode()
	return u, nil
}

func (s Scope) RootURL(scheme string) *url.URL {
	rootPath := "/"
	if s.directory != "" {
		rootPath = s.directory
	}
	return &url.URL{Scheme: scheme, Host: s.targetHost, Path: rootPath}
}

func (s Scope) allowsHost(host string) bool {
	if _, allowed := s.allowedHosts[host]; allowed {
		return true
	}
	if s.mode != ScopeSubdomains || s.privateSuffix {
		return false
	}

	baseHost := s.targetHost
	if baseHost == s.registrableHost || baseHost == "www."+s.registrableHost {
		baseHost = s.registrableHost
	}
	return strings.HasSuffix(host, "."+baseHost)
}

func registrableDomain(host string) (string, bool, error) {
	registrable, err := publicsuffix.EffectiveTLDPlusOne(host)
	if err == nil {
		return registrable, false, nil
	}

	suffix, icann := publicsuffix.PublicSuffix(host)
	if !icann && suffix == host && strings.Contains(host, ".") {
		return host, true, nil
	}
	return "", false, err
}

func (s Scope) ignoresParameter(value string) bool {
	lower := strings.ToLower(value)
	for _, pattern := range s.ignoredParams {
		if strings.HasSuffix(pattern, "*") {
			if strings.HasPrefix(lower, strings.TrimSuffix(pattern, "*")) {
				return true
			}
			continue
		}
		if lower == pattern {
			return true
		}
	}
	return false
}

func normalizedAdditionalHost(rawHost string) (string, error) {
	value := strings.TrimSpace(rawHost)
	if value == "" {
		return "", errors.New("additional host is empty")
	}
	if !strings.Contains(value, "://") {
		value = "https://" + value
	}
	u, err := url.Parse(value)
	if err != nil || u.Hostname() == "" {
		return "", fmt.Errorf("invalid additional host %q", rawHost)
	}
	if u.Port() != "" || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("additional host %q must contain only a hostname", rawHost)
	}
	return strings.ToLower(strings.TrimSuffix(u.Hostname(), ".")), nil
}

func cleanURLPath(value string) string {
	if value == "" {
		return "/"
	}
	cleaned := path.Clean("/" + strings.TrimPrefix(value, "/"))
	if cleaned != "/" {
		cleaned = strings.TrimSuffix(cleaned, "/")
	}
	return cleaned
}

func normalizedPathPrefixes(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if normalized := normalizedPathPrefix(value); normalized != "" {
			result = append(result, normalized)
		}
	}
	sort.Strings(result)
	return result
}

func normalizedPathPrefix(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	return cleanURLPath(value)
}

func normalizedParameters(values []string) []string {
	if values == nil {
		values = []string{"utm_*", "gclid", "fbclid"}
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value != "" {
			result = append(result, value)
		}
	}
	sort.Strings(result)
	return result
}

func matchesAnyPath(value string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if pathMatches(value, prefix) {
			return true
		}
	}
	return false
}

func pathMatches(value, prefix string) bool {
	if prefix == "/" {
		return true
	}
	return value == prefix || strings.HasPrefix(value, prefix+"/")
}

func ValidatePublicURL(ctx context.Context, resolver *net.Resolver, u *url.URL) error {
	if u == nil {
		return errors.New("URL is nil")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("unsupported URL scheme %q", u.Scheme)
	}
	port := u.Port()
	if port != "" && port != "80" && port != "443" {
		return fmt.Errorf("port %s is not allowed", port)
	}

	addresses, err := resolver.LookupIPAddr(ctx, u.Hostname())
	if err != nil {
		return fmt.Errorf("resolve target: %w", err)
	}
	if len(addresses) == 0 {
		return errors.New("target has no IP addresses")
	}
	for _, address := range addresses {
		if !isPublicIP(address.IP) {
			return fmt.Errorf("target resolves to a blocked address: %s", address.IP)
		}
	}
	return nil
}

func isPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	return !ip.IsLoopback() &&
		!ip.IsPrivate() &&
		!ip.IsLinkLocalUnicast() &&
		!ip.IsLinkLocalMulticast() &&
		!ip.IsMulticast() &&
		!ip.IsUnspecified()
}

func uniqueSortedURLs(urls []*url.URL) []*url.URL {
	byValue := make(map[string]*url.URL, len(urls))
	for _, u := range urls {
		if u != nil {
			byValue[u.String()] = u
		}
	}
	values := make([]string, 0, len(byValue))
	for value := range byValue {
		values = append(values, value)
	}
	sort.Strings(values)

	result := make([]*url.URL, 0, len(values))
	for _, value := range values {
		result = append(result, byValue[value])
	}
	return result
}
