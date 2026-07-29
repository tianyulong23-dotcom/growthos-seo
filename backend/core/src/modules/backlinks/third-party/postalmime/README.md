# PostalMime Boundary

`BL-AI-131` approves `postal-mime@2.7.5` under the MIT-0 license. The npm
artifact is pinned by its lockfile SHA-512 integrity, and the corresponding
upstream source revision is
`a70ee5ca7bdd1867574518f1ea8329782245f3f9`.

PostalMime may only parse raw RFC 5322 and MIME input inside the Gmail adapter
boundary. It may decode headers, body parts, nested MIME structures, and
attachment data so later Core-owned code can validate and map the result.

Parsed output remains untrusted. This dependency must not own `MailMessage`
mapping, thread or reply matching, campaign decisions, persistence, provider
calls, OAuth, network delivery, or mail sending. HTML must not be trusted or
rendered before the separate sanitizer task. Attachments must not be executed,
and remote resources must not be loaded.

The authoritative version, integrity, license, source paths, source revision,
and target boundary are registered as `OSS-MAIL-02` in
`source-manifest.json`. The fixtures under `test/fixtures/mail` are parser
contract inputs only; they do not prove Gmail or production integration.
