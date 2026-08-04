# PB-SHARED-DEPS Result

Status: BL-AI-143-INTEGRATED; BL-AI-112-INTEGRATED; BL-AI-131-INTEGRATED; BL-AI-133-DEPS-HANDOFF_READY
Integration: DOMPurify/jsdom dependency surfaces are present in the canonical root; BL-AI-133 is not marked DONE or INTEGRATED
Workspace: `C:\Users\DELL\Documents\缝合\john3947-seo`
Baseline time: `2026-07-27 11:03:47 +08:00`
BL-AI-131 completion time: `2026-07-28 +08:00`
BL-AI-133 dependency handoff time: `2026-07-28 +08:00`
Integrated tasks: `BL-AI-143`; `BL-AI-112`; `BL-AI-131`
Shared dependency handoff: `BL-AI-133`
Remaining shared dependency task: none; PB-D still owns the BL-AI-133 sanitizer implementation

## Scope

- Single objective: pin Cybokron and SEOnaut source, license, commit, allowed
  reference files, provenance hashes, NOTICE, and supply-chain tests.
- BL-AI-112 additionally pins Nodemailer MailComposer as the only approved
  RFC 5322/MIME serializer for the Gmail adapter boundary.
- BL-AI-131 pins PostalMime as a parse-only dependency and registers complex,
  attachment, encoded, nested, and malformed MIME contract fixtures.
- The BL-AI-133 dependency handoff pins isomorphic DOMPurify, its resolved
  DOMPurify engine, and jsdom without implementing the sanitizer adapter.
- The repository's canonical manifest remains
  `backend/core/src/modules/backlinks/third-party/source-manifest.json`, which
  is already consumed by its validator, license generator, SBOM generator, and
  tests. No duplicate top-level manifest was introduced.
- Prohibited paths touched: none.
- Business functionality added: none.
- Upstream PHP or Go source copied: none.

## BL-AI-112 MailComposer Dependency

- Nodemailer is pinned exactly at `9.0.3` with declared license `MIT-0`,
  package integrity, source repository, and source file inventory.
- The approved runtime boundary is
  `nodemailer/lib/mail-composer/index.js`; SMTP, sendmail, SES, transport,
  OAuth, DKIM, retry, and provider-send behavior are outside the task.
- The manifest maps the reviewed MailComposer, MIME node/functions, and address
  parser sources to the local Gmail message-builder adapter.
- A dedicated third-party README records the allowed and forbidden usage.

## BL-AI-131 PostalMime Dependency

- PostalMime is pinned exactly at `2.7.5` under `MIT-0`.
- The npm artifact integrity is
  `sha512-GNEXKvWFQnbgO5NlrGzVa0FmWzBZ24PersAWErttSg1Hjpf0ATxTwS5DOMGaOpTG6bUh5cTr7xi0jAD942wCJA==`;
  the corresponding upstream source commit is
  `a70ee5ca7bdd1867574518f1ea8329782245f3f9`.
- `OSS-MAIL-02` records the repository, source files, future Gmail
  message-parser target, allowed parsing boundary, and forbidden business,
  provider, rendering, persistence, and sending behavior.
- Three raw mail fixtures cover multipart alternatives, quoted-printable and
  base64 decoding, attachments, nested `message/rfc822`, and a malformed
  unclosed boundary.
- No `MailMessage` mapping, sanitizer, reply matching, Gmail Adapter
  implementation, API, workflow, or persistence was added.

## BL-AI-133 DOMPurify/jsdom Dependency Handoff

- `isomorphic-dompurify` is pinned exactly at `3.18.0` under MIT with npm
  integrity
  `sha512-ajp0D8laIHeoYlhBTevpE2HUhqWaqLXFk6K/wV3Ok8kDraBZpZsifwVWaY8IfJntMRIo1VSksgKV+lXyet9Q7A==`.
- Its locked sanitizer engine is `dompurify@3.4.12` under
  `MPL-2.0 OR Apache-2.0`, with npm integrity
  `sha512-zQvGet8Z2sWbQhCmfFz/T5QWH2oBmjnqK3qvOjaqaNLrLEF912WamU+ohnTp0TCep/MFVHpdJuCZEdFOdTnEFg==`.
- `jsdom` is pinned exactly at `29.1.1` under MIT with npm integrity
  `sha512-ECi4Fi2f7BdJtUKTflYRTiaMxIB0O6zfR1fX0GXpUrf6flp8QIYn1UT20YQqdSOfk2dfkCwS8LAFoJDEppNK5Q==`.
- `OSS-MAIL-03` records isomorphic-dompurify commit
  `1d5745c69d4c7dd2ec76dc7fa2ab3ccfdf3fc0ee`; the resolved DOMPurify package
  source was audited at commit `a9ca1e537422319a557a9a2aa61f003b23b4a197`.
- `OSS-MAIL-04` records jsdom commit
  `9b9ea7e10b7842cd38c61458a38774cc3b60c24c`.
- Clean read-only clones verified license SHA-256 values:
  isomorphic-dompurify MIT
  `B7C774AEB8A76CA92F0BF136FC0439F3EB606FEF2BBE879F28DD933CA87D4573`,
  jsdom MIT
  `9CFFC6240F87CD4D366EC97BAF2715FD6D5D95423348230B2A5958F7A97C137E`,
  DOMPurify Apache-2.0
  `CFC7749B96F63BD31C3C42B5C471BF756814053E847C10F3EB003417BC523D30`,
  and DOMPurify MPL-2.0
  `FAB3DD6BDAB226F1C08630B1DD917E11FCB4EC5E1E020E2C16F83A0A13863E85`.
- Allowed use is limited to the future server-side Gmail HTML sanitizer.
  jsdom script execution, resource loading, navigation, provider access,
  persistence, and business authority are forbidden.
- The runtime smoke sanitized
  `<p>ok</p><script>alert(1)</script>` to `<p>ok</p>` and parsed the clean
  output through jsdom without executing scripts.
- No `sanitizer.ts`, Gmail provider call, rendering path, API, workflow,
  migration, persistence, or frontend behavior was added.

## Changed Files

- `backend/core/scripts/check-third-party-licenses.ts`
- `backend/core/package.json`
- `backend/core/package-lock.json`
- `backend/core/src/modules/backlinks/third-party/source-manifest.json`
- `backend/core/src/modules/backlinks/third-party/THIRD_PARTY_NOTICES.md`
- `backend/core/src/modules/backlinks/third-party/cybokron/README.md`
- `backend/core/src/modules/backlinks/third-party/seonaut/README.md`
- `backend/core/src/modules/backlinks/third-party/nodemailer/README.md`
- `backend/core/src/modules/backlinks/third-party/postalmime/README.md`
- `backend/core/src/modules/backlinks/third-party/dompurify/README.md`
- `backend/core/src/modules/backlinks/third-party/jsdom/README.md`
- `backend/core/test/fixtures/mail/complex-multipart.eml`
- `backend/core/test/fixtures/mail/nested-message.eml`
- `backend/core/test/fixtures/mail/malformed-boundary.eml`
- `backend/core/test/unit/dependency-allowlist.test.ts`
- `backend/core/test/unit/source-manifest.test.ts`
- `backend/core/test/unit/third-party-licenses.test.ts`
- `backend/core/artifacts/sbom/backlinks-core-0.0.0.cdx.json`
- `backend/core/docs/execution/parallel-blocks/PB-SHARED-DEPS-result.md`
- `backend/core/docs/execution/backlinks-ai-coding-state.md`

## Verification

| Command | Exit code | Result |
|---|---:|---|
| `npx vitest run test/unit/source-manifest.test.ts` before implementation | `1` | Expected failure: `OSS-PLC-01` was absent; 1 failed, 5 passed |
| `npx vitest run test/unit/source-manifest.test.ts` | `0` | 6/6 passed |
| `npx vitest run test/unit/third-party-licenses.test.ts` before NOTICE generation | `1` | Expected stale NOTICE failure; 1 failed, 2 passed |
| `npm run licenses:check -- --write` | `0` | NOTICE generated; 603 packages valid |
| `npm run source:manifest:check` | `0` | 21/21 source records valid |
| Pinned clone commit/license/source-hash comparison | `0` | Cybokron 4/4 and SEOnaut 6/6 source hashes matched |
| Third-party copied-source scan | `0` | 0 PHP/Go source files copied |
| `npm run sbom:backlinks` | `0` | 591 exact components; 0 sensitive fields |
| `npm run typecheck` | `0` | Passed |
| `npm run lint` | `0` | Passed |
| `npm run dependencies:allowlist` | `0` | Passed |
| `npm run licenses:check` | `0` | 603 packages valid |
| `npm run test:backlinks:unit` | `0` | 88/88 passed |
| `npm run test:backlinks:contract` | `0` | 36/36 passed |
| `npm audit --omit=dev` | `0` | 0 vulnerabilities |
| Scoped Prettier check for new README files and source-manifest test | `0` | Passed |
| `git diff --check` | `0` | Passed; unrelated working-tree line-ending warnings only |
| BL-AI-112 failure-first dependency/manifest/NOTICE suite | `1` | Expected failure: missing package and `OSS-MAIL-01`, stale NOTICE; 3 failed, 12 passed |
| BL-AI-112 focused dependency/manifest/NOTICE suite | `0` | 15/15 passed |
| `npm run source:manifest:check` after BL-AI-112 | `0` | 22/22 source records valid |
| `npm run dependencies:allowlist` after BL-AI-112 | `0` | Exact Nodemailer version and integrity passed |
| `npm run licenses:check -- --write` after BL-AI-112 | `0` | NOTICE generated; 604 packages valid |
| `npm run sbom:backlinks` after BL-AI-112 | `0` | 592 exact components; 0 sensitive fields |
| `npm audit --omit=dev --json` after BL-AI-112 | `0` | 0 production vulnerabilities |
| Joint BL-AI-112/113 `npm run verify:backlinks` | `0` | Unit 157/157, API 55/55, Contract 75/75, Integration 106 passed with 13 skipped, Security 95/95, Resilience 3/3 |
| BL-AI-131 failure-first dependency/manifest/fixture/NOTICE suite | `1` | Expected baseline: 4 failed, 14 passed because PostalMime, `OSS-MAIL-02`, parser import, and NOTICE row were absent |
| `npm install postal-mime@2.7.5 --save-exact --ignore-scripts --no-audit` | `0` | Exact dependency and lockfile integrity installed |
| BL-AI-131 focused dependency/manifest/fixture suite before NOTICE generation | `0` | 15/15 passed |
| `npm run licenses:check -- --write` for BL-AI-131 | `0` | NOTICE generated; 605 packages valid |
| `npm run sbom:backlinks` for BL-AI-131 | `0` | 593 exact components; 0 sensitive fields |
| NOTICE/SBOM second-generation hash comparison | `0` | Both generated files retained identical SHA-256 values |
| `npm run licenses:check` after second generation | `0` | Read-only NOTICE drift check passed |
| `npm ci --ignore-scripts` | `0` | Lockfile installed; lifecycle scripts disabled |
| `npm run source:manifest:check` | `0` | 24/24 source records valid |
| `npm run dependencies:allowlist` | `0` | Exact PostalMime version and integrity passed |
| `npm run licenses:check` | `0` | 605 packages valid |
| `npm run sbom:backlinks` | `0` | 593 exact components; 0 sensitive fields |
| `npm audit --omit=dev` | `0` | 0 production vulnerabilities |
| `npm run typecheck` | `0` | Passed |
| `npm run lint` | `0` | Passed |
| `npm run test:backlinks:unit` | `0` | 229/229 passed |
| `npm run test:backlinks:contract` | `0` | 128/128 passed |
| BL-AI-131 final dependency/manifest/fixture/NOTICE suite | `0` | 18/18 passed |
| `npm run verify:backlinks` | `0` | Unit 229/229, API 59/59, Contract 128/128, Integration 124 passed with 13 skipped, Security 95/95, Resilience 3/3; OpenAPI 23 paths; migrations 19 files through 0026 |
| BL-AI-133 dependency/manifest/NOTICE failure-first suite | `1` | Expected baseline: missing direct packages, lock entries, `OSS-MAIL-03`, `OSS-MAIL-04`, and NOTICE rows; 3 failed, 17 passed |
| `npm install isomorphic-dompurify@3.18.0 jsdom@29.1.1 --save-exact --ignore-scripts --no-audit` | `0` | Added 37 packages with lifecycle scripts disabled |
| `npm run licenses:check` before NOTICE regeneration | `1` | Expected stale NOTICE; initial audit also required explicit approval of transitive `CC0-1.0` and `(MPL-2.0 OR Apache-2.0)` licenses |
| `npm run licenses:check -- --write` | `0` | NOTICE generated; 642 locked package entries valid |
| `npm run sbom:backlinks` | `0` | 629 exact components; 0 sensitive fields |
| NOTICE/SBOM second-generation hash comparison | `0` | NOTICE `054A6580...DCF19` and SBOM `069F6C6B...D322F` remained identical |
| BL-AI-133 dependency/manifest/NOTICE/SBOM focused suite | `0` | 22/22 passed |
| `npm ls isomorphic-dompurify dompurify jsdom --depth=1` | `0` | Exact direct packages and `dompurify@3.4.12` resolved as expected |
| Clean upstream commit/license verification | `0` | isomorphic-dompurify, DOMPurify, and jsdom commits and four license-file SHA-256 values matched; clone worktrees were clean |
| DOMPurify/jsdom direct runtime smoke | `0` | Script element removed; jsdom parsed only the clean `ok` text |
| `npm ci --ignore-scripts` | `0` | Clean lockfile install completed with lifecycle scripts disabled |
| `npm run source:manifest:check` | `0` | 26/26 source records valid |
| `npm run dependencies:allowlist` | `0` | Exact package versions, integrity values, licenses, and dependency edges passed |
| `npm run licenses:check` | `0` | Read-only NOTICE drift check passed; 642 packages valid |
| `npm audit --omit=dev` | `0` | 0 production vulnerabilities |
| `npm run typecheck` | `0` | Passed |
| `npm run lint` | `0` | Passed |
| `npm run verify:backlinks` | `1` | Deliberately preserved BL-AI-133 RED: `gmail-html-sanitizer.test.ts` cannot import absent `sanitizer.js`; other unit tests 237/237 passed |
| `npm run test:backlinks:api` | `0` | 59/59 passed |
| `npm run test:backlinks:contract` | `0` | 128/128 passed |
| `npm run test:backlinks:integration` | `0` | 124 passed, 13 skipped |
| `npm run test:backlinks:security` | `0` | 95/95 passed |
| `npm run test:backlinks:resilience` | `0` | 3/3 passed |

The broad touched-file Prettier probe returned `1` because existing generated
NOTICE/manifest and compact governance files do not use repository-wide
Prettier output. They were not mechanically reformatted because that would
create unrelated churn and would desynchronize the generated NOTICE.

## Shared Change Requests

- Public FastAPI/OpenAPI: none.
- Fastify route registration: none.
- Temporal/event registry: none.
- Migration manifest/PostgreSQL gate: none.
- Dependency/NOTICE/SBOM: Nodemailer `9.0.3`, PostalMime `2.7.5`,
  isomorphic-dompurify `3.18.0`, DOMPurify `3.4.12`, and jsdom `29.1.1`
  package lock, manifest, NOTICE, license policy, and SBOM surfaces are present
  in the canonical root.
- Frontend registration/global client: none.

## External Effects

- Real network: npm registry metadata, package installation, and production
  audit for PostalMime, DOMPurify, and jsdom; read-only GitHub source/license
  verification clones. No Gmail, DataForSEO, AI, or other provider endpoint
  was called.
- Credentials: none.
- Persistent database: none; the full Core gate used only disposable test
  infrastructure.
- Production resource: none.
- Git commit/push: none.
- Three read-only verification clones remain under `%TEMP%`; the cleanup command
  was rejected by the execution policy.

## Unverified

- No placement parser, validator, crawler, scheduler, repository, or business
  state behavior was implemented or claimed by this source-governance task.
- BL-AI-112 does not claim SMTP transport, provider delivery, real Gmail use,
  or production activation.
- BL-AI-131 proves the pinned package can parse the registered local fixtures;
  it does not prove Gmail payload retrieval, production MIME diversity,
  sanitizer safety, `MailMessage` mapping, reply/thread matching, rendering,
  or production activation.
- The BL-AI-133 dependency handoff proves exact dependency resolution,
  provenance, license compatibility, deterministic NOTICE/SBOM generation,
  production audit, and a minimal local runtime smoke. It does not prove the
  future GrowthOS sanitizer policy, malicious fixture coverage, rendering
  safety, Gmail payload behavior, or production activation.
- The canonical coding state was not advanced and BL-AI-133 was not marked
  DONE or INTEGRATED because the required full Core command exits `1` until
  PB-D implements `sanitizer.ts` and makes its preserved RED test pass.
- `npm ci` reported eight high-severity findings in the complete
  development-inclusive tree, while the required production-only
  `npm audit --omit=dev` reported zero vulnerabilities. No dependency upgrade
  beyond the exact DOMPurify/jsdom dependency handoff was authorized.
- PB-D reports BL-AI-132 as `HANDOFF_READY`; this shared-dependency task did
  not formally integrate BL-AI-132 or modify its parser implementation.
