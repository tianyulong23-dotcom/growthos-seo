package crawler

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"path"
	"sort"
	"strings"

	"golang.org/x/net/publicsuffix"
)

type Scope struct {
	targetHost      string
	registrableHost string
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
	registrable, err := publicsuffix.EffectiveTLDPlusOne(host)
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
	if host == registrable || host == "www."+registrable {
		allowedHosts[registrable] = struct{}{}
		allowedHosts["www."+registrable] = struct{}{}
	}
	for _, rawHost := range additionalHosts {
		additionalHost, err := normalizedAdditionalHost(rawHost)
		if err != nil {
			return Scope{}, nil, err
		}
		additionalRegistrable, err := publicsuffix.EffectiveTLDPlusOne(additionalHost)
		if err != nil || additionalRegistrable != registrable {
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
	if s.mode != ScopeSubdomains {
		return false
	}

	baseHost := s.targetHost
	if baseHost == s.registrableHost || baseHost == "www."+s.registrableHost {
		baseHost = s.registrableHost
	}
	return strings.HasSuffix(host, "."+baseHost)
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

type IPResolver interface {
	LookupIPAddr(context.Context, string) ([]net.IPAddr, error)
}

func ValidatePublicURL(ctx context.Context, resolver IPResolver, u *url.URL) error {
	_, err := resolvePublicURL(ctx, resolver, u)
	return err
}

func resolvePublicURL(
	ctx context.Context,
	resolver IPResolver,
	u *url.URL,
) ([]string, error) {
	if u == nil {
		return nil, errors.New("URL is nil")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported URL scheme %q", u.Scheme)
	}
	if u.User != nil {
		return nil, errors.New("URL userinfo is not allowed")
	}
	port := u.Port()
	if port != "" && port != "80" && port != "443" {
		return nil, fmt.Errorf("port %s is not allowed", port)
	}
	host := strings.TrimSpace(strings.TrimSuffix(u.Hostname(), "."))
	if host == "" {
		return nil, errors.New("URL hostname is empty")
	}
	if ambiguousNumericHost(host) {
		return nil, errors.New("ambiguous numeric hostname is not allowed")
	}

	addresses, err := resolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, fmt.Errorf("resolve target: %w", err)
	}
	if len(addresses) == 0 {
		return nil, errors.New("target has no IP addresses")
	}
	resolved := make([]string, 0, len(addresses))
	for _, address := range addresses {
		if !isPublicIP(address.IP) {
			return nil, fmt.Errorf("target resolves to a blocked address: %s", address.IP)
		}
		resolved = append(resolved, address.IP.String())
	}
	sort.Strings(resolved)
	return resolved, nil
}

func isPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	address, ok := netip.AddrFromSlice(ip)
	if !ok {
		return false
	}
	address = address.Unmap()
	if !address.IsGlobalUnicast() ||
		address.IsLoopback() ||
		address.IsPrivate() ||
		address.IsLinkLocalUnicast() ||
		address.IsMulticast() ||
		address.IsUnspecified() {
		return false
	}
	for _, prefix := range blockedPublicPrefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

var blockedPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"),
	netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
	netip.MustParsePrefix("2001:db8::/32"),
}

func ambiguousNumericHost(host string) bool {
	lower := strings.ToLower(host)
	if strings.HasPrefix(lower, "0x") {
		return true
	}
	allDigits := true
	for _, character := range lower {
		if character < '0' || character > '9' {
			allDigits = false
			break
		}
	}
	if allDigits {
		return true
	}
	parts := strings.Split(lower, ".")
	if len(parts) != 4 {
		return false
	}
	for _, part := range parts {
		if strings.HasPrefix(part, "0x") ||
			len(part) > 1 && strings.HasPrefix(part, "0") {
			return true
		}
	}
	return false
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
