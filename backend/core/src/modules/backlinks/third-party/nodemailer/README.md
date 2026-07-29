# Nodemailer MailComposer Boundary

`BL-AI-112` approves `nodemailer@9.0.3` only for the
`nodemailer/lib/mail-composer/index.js` RFC 5322 and MIME builder used by the
Gmail adapter.

The Backlinks domain and application layers must not import Nodemailer. SMTP,
sendmail, SES, stream, JSON transports, OAuth handling, DKIM signing, retries,
and network delivery remain outside this dependency boundary.

The authoritative version, integrity, license, source paths, and target path
are registered as `OSS-MAIL-01` in `source-manifest.json`.
