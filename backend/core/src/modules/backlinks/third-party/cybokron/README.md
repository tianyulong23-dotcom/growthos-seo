# Cybokron Reference Boundary

Source record: `OSS-PLC-01`

- Repository: `https://github.com/ercanatay/cybokron-backlink-checker`
- Audited commit: `f71c66d5b8520ecba3e61ca96a8d1d0383f91c23`
- Investigated release: `v2.1.7`
- License: MIT

## Allowed Reference Files

- `src/Services/BacklinkAnalyzerService.php`
- `src/Services/HttpClient.php`
- `src/Domain/Url/LinkClassifier.php`
- `src/Domain/Url/UrlNormalizer.php`
- `tests/Unit/LinkClassifierTest.php`
- `tests/Unit/UrlNormalizerTest.php`
- `tests/Unit/BacklinkAnalyzerSsrfTest.php`

Allowed reuse is limited to rel classification, strongest-link selection, host
equivalence boundaries, redirect evidence, and independently verified SSRF
test vectors.

The upstream HTTP client must not replace GrowthOS SafeFetch. The PHP
application, database, scheduler, tasks, pages, and direct
`active/lost/recovered` decisions are outside the allowed boundary.

BL-AI-143 registers provenance only. It does not copy upstream source code.
