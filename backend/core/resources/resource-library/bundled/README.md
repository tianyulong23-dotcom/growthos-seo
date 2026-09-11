# Bundled Publisher Catalog

This directory is application data intended to travel with the repository.
Commit `publishers.sqlite` and `manifest.json` together with the code.

- Complete publisher catalog exported on 2026-09-10: 49,742 rows, 49,737 distinct
  domains. Duplicate rows and missing metrics are preserved, not fabricated.
- Includes all 16 publisher columns: identity/URL, categories, language, DR,
  monthly traffic, Moz DA, pricing/currency, link terms and source-page metadata.
- Excludes the source import-metadata table, credentials, local filesystem paths,
  user projects, contact-crawl state, email contents and OAuth grants.
- This is a versioned data snapshot, not a live sync with the original catalog.
  The recommendation adapter reads it in read-only mode and applies its existing
  filtering, deduplication, giant-site exclusions and batch limits.
- Library monthly traffic is not DataForSEO natural-search ETV. Source listings
  are not verified cooperation or confirmed-contact evidence.

From `backend/core`, run `npm run resource-library:check`. Every normal build
also checks the file digest, schema, integrity and full-row content digest.
This file is carried directly in Git; no external download or Git LFS step is
required for this snapshot.

To refresh, export an authorized source into a NEW directory:

```text
npm run resource-library:export -- <source.sqlite> <new-output-directory>
```

Review the generated catalog and manifest before replacing the bundled pair.
The exporter refuses to overwrite existing output and opens the source read-only.
It includes only the explicit publisher-field allowlist, never extra tables or
future unknown columns. Update the expected catalog counts in portability tests
when accepting a new snapshot.

Data is included for the user's requested team handoff. This does not establish
third-party redistribution rights. Confirm the source-data permissions before
publishing the repository publicly; no new license grant is asserted here.
