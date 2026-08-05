# DOMPurify Runtime Boundary

The BL-AI-133 dependency handoff approves `isomorphic-dompurify@3.18.0`
under MIT. Its locked sanitizer engine is `dompurify@3.4.12` under
`MPL-2.0 OR Apache-2.0`.

The npm artifacts are fixed by `package-lock.json`. The audited upstream
sources are:

- isomorphic-dompurify tag `3.18.0`, commit
  `1d5745c69d4c7dd2ec76dc7fa2ab3ccfdf3fc0ee`
- DOMPurify package commit
  `a9ca1e537422319a557a9a2aa61f003b23b4a197`

Allowed use is limited to constructing the server-side DOMPurify runtime and
calling `sanitize` from the Gmail HTML sanitizer adapter with an explicit
GrowthOS-owned strict policy.

Raw email HTML, DOMPurify defaults, remote images, tracking pixels, scripts,
iframes, forms, event attributes, inline style, dangerous URL protocols, SVG,
MathML, and post-sanitize concatenation are not approved by this dependency
registration. Parsed and sanitized output remains untrusted until the
BL-AI-133 adapter applies and proves its policy.

This directory contains provenance only. It does not implement BL-AI-133.
