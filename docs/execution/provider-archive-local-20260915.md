# Local archive activation

- Authorized scope: persistent local archive database, local capture/upload
  service, fixture verification. No cloud deployment or paid provider calls.
- Baseline: main, 506d88fac0fa81503e54aebdfc4ac9e68974997b, origin john3947/seo.
- Preserve existing dirty work. Own local archive bootstrap/lifecycle tooling,
  narrow dev-up integration and this evidence file.
- Reuse local PostgreSQL; create a separate archive DB and restricted login.
  Do not modify business tables, trigger jobs, send mail, commit or push.
- Stop after local persistence/service and retry acceptance. Real DataForSEO
  capture requires the business producers to run with the enabled configuration.

## Checkpoints

- [x] Existing PostgreSQL reachable; no archive listener found on port 7400.
- [x] Persistent database and secret/config initialization.
- [x] Local center/uploader lifecycle and native dev-up configuration.
- [x] Fixture persistence, duplicate history, retry and restart verification.

## Local runtime result

- Database: `growthos_provider_archive`, in the existing local PostgreSQL.
- Persistent Docker volume: `seo-main-ui_postgres-data`, mounted at
  `/var/lib/postgresql`. No project database migrations or container restarts.
- Runtime role: `growthos_provider_archive_app`, SELECT/INSERT and sequence
  permissions only; no table creation, delete or database-owner permissions.
- Center: `http://127.0.0.1:7400`, ready after process restart.
- Native center and uploader started hidden; ownership-checked PID files and
  logs under ignored `storage/provider-archive`.
- Secrets randomly generated, directory ACL restricted to current Windows user,
  Git ignore confirmed for configuration and credential files.
- 5 immutable fixture records retained: first pass stored two events; second
  pass stored two historical events plus one through the background uploader.
- Latest accepted run: `f990602e-ad54-45fe-a4e9-79413b31c731`,
  verified at `2026-09-15T02:43:12.253Z`.
- Actual stop/start of the archive processes followed by database checks retained
  all 5 records, including all 3 from the latest accepted run.
- Repeated setup reused the database; repeated start did not spawn another
  owned process. Both service stderr logs empty at verification.
- Uploader status after restart: queued=0, pendingCapture=0, incompleteWrites=0.

## Acceptance checks

- Real local PostgreSQL writes and administrative HTTP reads: PASS.
- Same fixture website, different metric values, separate events: PASS.
- Simulated offline upload retains both events: PASS.
- Commit followed by lost receipt and retry without duplicate rows: PASS.
- Raw response digest roundtrip: PASS.
- Upload token cannot read history: PASS.
- Runtime database role cannot DELETE or CREATE TABLE: PASS.
- Independent background uploader delivers from configured deployment spool:
  PASS, without the verifier directly uploading that event.
- Center/uploader process restart preserves stored records: PASS.
- New bootstrap JavaScript syntax and scoped ESLint: PASS.
- New lifecycle and modified dev-up PowerShell parsing: PASS.
- Existing archive unit suite: PASS, 10 tests.
- Scoped tracked-file whitespace check: PASS (line-ending warnings only).

## Activation boundary

The local center/uploader are running; cloud work is not started. There were zero
real DataForSEO, Gmail or AI calls. The 5 records are explicitly synthetic
acceptance fixtures, not historical provider data imported from elsewhere.

Native `dev-up.ps1` now detects this local configuration unless explicitly
disabled or replaced by remote configuration. Current environment has neither
an explicit archive disable nor a remote override. The business application
was not restarted in this task, so already-running producers are not claimed
to have picked up the new environment. The next normal native application
startup enables capture. No paid or business workflow was started to force it.

This check covers application process restart, not a PostgreSQL container,
machine reboot, physical disk-loss or cloud disaster-recovery test. See
`docs/provider-archive-setup.md` for normal commands and limitations.
