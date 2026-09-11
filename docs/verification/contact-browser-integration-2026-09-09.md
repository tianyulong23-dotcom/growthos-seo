# Contact Browser Integration: Local Verification

Date: 2026-09-09 (Asia/Shanghai)

## Scope

Connect the existing browser renderer to shared contact discovery, persist
parsed evidence, and display eligible contacts discovered after publication.
No new recommendation generation, DataForSEO discovery, Hunter calls, Gmail
sends, or historical project-sync resumption was requested by this execution.

## Shared Changes

- Keep SafeFetch as the first attempt. Use the authorized browser fallback
  for supported failures and dynamic pages.
- Follow same-site contact links found in rendered HTML within the existing
  depth, page, and attempt limits. Prioritize contact/advertising pages.
- A failed follow-up render no longer disables remaining browser pages after
  a successful browser fetch.
- Use the normal contact parser and repository for rendered HTML. Do not
  inject contacts into recommendation data.
- Treat an embedded contact-form CAPTCHA separately from a blocking challenge.
  Keep blocking challenges, private-address restrictions, scope restrictions,
  and login restrictions enforced.
- On Windows, avoid the blocked leakless helper without changing antivirus
  settings. Keep the Rod session alive across request-scoped page operations.
- Block out-of-scope document requests without making an embedded third-party
  frame failure invalidate the whole accessible public page.
- Keep a boot-started local crawler service available instead of terminating
  it because its Temporal idle tracker does not observe HTTP render traffic.
- Overlay later eligible public contact evidence in recommendation list/export
  reads, scoped to tenant, project, prospect, and recommendation context.
  Preserve immutable release records and existing release email values.

## Local Runtime

- Corrected the local browser endpoint override to port 7310 and timeout to
  60000 ms. The local service uses the rebuilt Windows crawler executable.
- Core API and worker both reported build
  `local-product-27168f93c26834f432c853d0`.
- Crawler health on port 7310 returned `ok` after the verification.
- These are local-runtime results, not evidence of production deployment.

## Tests

- Core: 64 tests passed across contact activity, convergence, parser,
  synchronization, V2 preparation, feed repository, and PostgreSQL feed tests.
- PostgreSQL regression verifies late-contact list/export, unchanged release
  facts, rejection of guessed/support/low-confidence contacts, expired evidence,
  and the database constraint against changing a candidate to another context.
- API worker launcher: 4 tests passed.
- Go: `go test ./internal/crawler ./internal/worker` passed.
- Core TypeScript build passed.

## Real Aiper Results

Project: `b35ab775-fabd-44a9-a7c7-82406242893d`.

| Domain | Persisted candidates | Evidence | Result |
| --- | ---: | ---: | --- |
| poolmagazine.com | 8 | 10 | PUBLIC_EMAIL_FOUND |
| intheswim.com | 0 | 0 | CAPTCHA_OR_BOT_CHALLENGE |
| bhg.com | 0 | 0 | ACCESS_DENIED |

The latter two sites were attempted with the browser but did not complete a
successful browser fetch; their `browser_used=false` flag is not proof that
the browser was never attempted. All three jobs ended `partially_completed`;
PoolMagazine has successful contact evidence despite incomplete page coverage.

PoolMagazine candidates include editor, sales, advertising, webmaster, and
other public addresses. Candidate count does not imply eight verified mailboxes
or eight appropriate outreach recipients. One candidate belongs to a third
party referenced on the source site, not PoolMagazine itself.

The normal authenticated recommendation-feed GET returned HTTP 200 with
`webmaster@poolmagazine.com`, its contact-page source, and `PUBLIC_EMAIL_FOUND`.
Playwright reloaded the Aiper recommendation page and confirmed the email
was visible. Screenshot:
`storage/runtime/aiper-browser-contact-20260909.png`.

The original failed contact status remains in the immutable release record.
No additional crawl was needed to refresh the feed after fixing its projection.

## Limits

Browser integration is implemented and locally verified, but does not guarantee
access to every site or bypass CAPTCHA/WAF/login controls. SMTP deliverability,
email sending, and the entire subsequent outreach chain were not tested.
Existing missing SEO metrics and unrelated UI issues are outside this change.
