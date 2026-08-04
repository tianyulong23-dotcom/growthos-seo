# jsdom Runtime Boundary

The BL-AI-133 dependency handoff approves `jsdom@29.1.1` under MIT. The
audited `v29.1.1` source resolves to commit
`9b9ea7e10b7842cd38c61458a38774cc3b60c24c`.

jsdom is allowed only as the server-side DOM environment required by the
approved DOMPurify wrapper inside the Gmail sanitizer adapter.

Resource loading, script execution, browser-worker emulation, external
navigation, provider access, persistence, and business decisions are
forbidden. The Sanitizer must not enable `runScripts` or `resources`, and a
sanitization failure must fall back to safe plain text.

This directory contains provenance only. It does not implement BL-AI-133.
