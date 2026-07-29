# Temporal Contracts

`registry.v1.json` is the authority for module Task Queues, Workflow IDs,
Workflow and Activity types, Worker database permissions, and Provider Kill
Switch namespaces.

Registered module queues are:

- `growthos.platform.v1`
- `growthos.audit.v1`
- `growthos.crawling.v1`
- `growthos.backlinks.v1`

Platform and Audit entries are target contracts. Crawling and Backlinks are
proved executable in this checkout. The source crawler bindings `crawler-go`,
`CrawlWorkflow`, `RecalculateIssuesWorkflow`,
`Activities.RunTask`, `Activities.RecalculateIssues`, `pause`, and `stop` are
recorded as `replacement-required`; they are not accepted shared identifiers.

Crawling has no database role or schema grant in this contract and returns
evidence/object-store references only. Platform, Audit, and Backlinks remain
the sole writers of their business facts.

Provider Kill Switches are owner-prefixed:

- `platform.business-profile-ai.v1`
- `audit.google-pagespeed.v1`
- `backlinks.dataforseo.v1`
