# SEOnaut Reference Boundary

Source record: `OSS-PLC-02`

- Repository: `https://github.com/StJudeWasHere/seonaut`
- Audited commit: `880b312c28fab8b0bf7fe4f9449dc4746dbb82ff`
- License: MIT

## Allowed Reference Files

- `internal/services/parser.go`
- `internal/services/html_parser.go`
- `internal/services/html_parser_test.go`
- `internal/issues/page/canonical.go`
- `internal/issues/page/canonical_test.go`
- `internal/issues/errors/errors.go`
- `internal/repository/pagereport.go`
- `internal/urlutils/absoluteurl.go`

Allowed reuse is limited to independently verified HTML and HTTP canonical
semantics, relative and multiple canonicals, Meta and X-Robots-Tag directives,
and page-level nofollow test semantics.

The Go crawler, repository and issue state, data models, final URL or placement
decisions, and unverified branches are outside the allowed boundary.

BL-AI-143 registers provenance only. It does not copy upstream source code.
