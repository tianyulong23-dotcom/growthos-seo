# Event Contracts

`registry.v1.json` is the authority for event ownership, versioning, outbox
publication, consumers, and cross-module projection rules.

The cross-module crawling flow is:

1. Platform, Audit, or Backlinks sends
   `crawling.evidence.requested.v1`.
2. Crawling deduplicates by `requestId` and may write evidence only.
3. Crawling returns `crawling.evidence.recorded.v1` as a Temporal result.
4. Consumers deduplicate by `requestId` and may write only their owned
   projection or conclusion.

The existing `backlinks.project-analysis.requested.v1` event remains a
Backlinks-owned Outbox event and is not converted into a shared event.
