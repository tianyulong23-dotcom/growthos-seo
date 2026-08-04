# OpenSEO Source Provenance

BL-AI-052 registered the upstream provenance. BL-AI-053 independently rewrites
only the approved single-task envelope, billing metadata, empty-result handling,
and referring-domain mapping in `referring-domains.ts`.

- Upstream: `https://github.com/every-app/open-seo`
- Audited commit: `927e931e51f6024323ada746816aaa6a51ce83ef`
- License: MIT
- Upstream license SHA-256:
  `c23e0aa0cdc924726993ffc8eb96e5283a7e8aaa7e068f1200277eb6df0f0f06`
- Adoption state: conditional and default-disabled; the implementation remains
  isolated and is not wired to the DataForSEO Adapter.

## Implemented Port

`referring-domains.ts` is derived only from the registered `envelope.ts`,
`envelope.test.ts`, and `backlinksServiceData.ts` behavior. It accepts an
already obtained JSON value and has no network, retry, cache, database, route,
authentication, billing-account, or application-state integration.

## Approved References

| Upstream file | SHA-256 |
|---|---|
| `src/server/lib/dataforseo/core.ts` | `ba825d96a774f296f33b07debb2d54d418d6c03b14a215ee5c02c80c9e600670` |
| `src/server/lib/dataforseo/envelope.ts` | `f919004730ebc6f7ccd2a8724f43eecd1825e6cd579485fb404f07720294688b` |
| `src/server/lib/dataforseo/backlinks.ts` | `6716e8a70733e5c068b6595e1b5624e3e0f572a73301508e2db79b1e8201747b` |
| `src/server/lib/dataforseo/labs.ts` | `24a07ee4d2b82db29d50b8f7ead54461d09b390c7bd917648e5c1fe9530dc934` |
| `src/server/features/backlinks/services/backlinksServiceData.ts` | `75d4dbe91616256f02563cba11e1f93bf73427ff32cdc5e28048620accbe0330` |
| `src/server/features/domain/services/DomainService.ts` | `b88a11c1d511e3da73b159d70d0744c291fd8f60b2c4b48e77a4b8b24ce5b5c9` |
| `src/server/lib/r2-cache.ts` | `9874baeaae9013ae555138049b1190f04cdb3516aa164aecd46c89b06ba686f6` |
| `src/server/lib/dataforseo/envelope.test.ts` | `b36701f5a4c2af3567531fc26701bea95716faaf1793e5733ee64df0d364eabd` |
| `scripts/backlinks-cost-profile.ts` | `31c67259769eb1471e93f5d47857a5146bb2f05370ae7a590f351dfe66a188a6` |

## Reuse Boundary

Allowed concepts are task-envelope validation, empty-result handling, field
normalization, deterministic cache keys, cost metadata, and test vectors.

OAuth, sessions, organizations, projects, subscriptions, Autumn billing, R2
bindings, routes, page state, hosted data, MCP routes, paid POST 5xx retries,
OpenSEO configuration, and OpenSEO database models are prohibited.
