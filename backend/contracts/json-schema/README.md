# JSON Schema

Shared JSON Schema contracts for the frontend, FastAPI Gateway, Go crawler,
and module Workers live in this directory.

`crawler-evidence-request.v1.schema.json` fixes the cross-module request and
dedupe envelope. `crawler-evidence.v1.schema.json` fixes evidence-only output:
page observations, contact observations, backlink observations, technical
observations, and object-store references. It deliberately excludes final
Project, Audit, Opportunity, Placement, and lifecycle state.
