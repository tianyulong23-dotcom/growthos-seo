# Business Profile AI Autofill

Date: 2026-09-08

## Scope

- Reuse the existing project-create, site-understanding, persistence and onboarding flow.
- Fill an editable business profile from crawled website evidence.
- Preserve unsaved field edits, including deliberate empty values.
- Keep unrelated dirty work intact. No backlink discovery, Gmail send or historical
  provider-waiting job resume was requested or performed.

## Root Cause and Fix

The new elephtvza.com project had a deterministic profile, empty audience/product
arrays and no AI invocation. Business-profile AI was not configured.
Additionally, AI settings endpoints used the process default organization while
the crawler loaded settings using the project's authenticated organization.

AI settings now resolve collection/project authority and use a request-scoped
settings copy. Reads and writes follow that organization without changing global
cached settings. The local startup script preserves explicit business-profile
AI configuration instead of blanking its URL and key.

The existing provider was configured through the normal platform settings API.
No provider credentials were added to source files. The accidental default-scope
configuration created while reproducing the issue was removed by its exact
organization and creation timestamp; no project/profile rows were patched.

Frontend recognition updates now merge only untouched fields. Switching projects
resets field-edit tracking. Partial results no longer claim successful AI synthesis.

## Verification

- API: 73 focused tests passed across settings, tenant scope, projects, worker
  launcher and local runtime configuration.
- Frontend: 14 form/onboarding tests passed.
- Frontend application TypeScript check passed.
- PowerShell startup syntax passed.
- Existing saved-profile overrides remain protected by the crawler's persistence
  merge; this change does not auto-confirm the user's profile.

Real project: 7e1c7515-b9b3-4247-80ed-12b3eecee3a2 (elephtvza.com).

- Original run: 1d94f777-3688-4b63-a96f-dec6b5724094, partial/unconfigured.
- First configured invocation: 6189155d-2189-414e-8898-fe034b3f2f96,
  connection EOF after approximately 60 seconds; no success was inferred.
- Connection test passed with low reasoning effort.
- Successful run: d98c67f2-2094-4edb-9875-91b1ef0aeaa2, completed,
  AI invocation HTTP 200, 22,757 ms, 3,700 recorded tokens.
- Stored extraction method: ai_synthesized.
- Stored and browser-visible arrays: 5 audiences, 6 products/services,
  6 value propositions. All six form fields are editable.
- Desktop and 390px mobile checks found no horizontal overflow or form fields
  extending outside the viewport.
- Automatic provider retries are disabled in this local configuration.
  The provider did not supply a monetary cost for the successful invocation;
  token counts are not a verified charge.

This is local runtime verification of the shared recognition flow on an existing
new project, not a claim of production deployment or completed human UAT.

The adjacent agent conversation sidebar returns an independent HTTP 404 for this
project. It does not prevent business-profile recognition or form rendering and
was not changed in this scope.
