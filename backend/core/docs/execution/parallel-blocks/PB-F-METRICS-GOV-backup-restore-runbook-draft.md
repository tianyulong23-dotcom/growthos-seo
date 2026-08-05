# PB-F Metrics Governance Backup/Restore Runbook Draft

Status: integration-controller review required before shared runbook promotion.

## Guardrails

- Restore into a **temporary restore database** with isolated credentials.
- The procedure **must not target production** or overwrite a production database.
- Keep external providers, Gmail delivery, crawlers, and scheduled Jobs disabled.

## Procedure

1. Record the backup timestamp and validation start timestamp.
2. Create a PostgreSQL custom backup:

   ```powershell
   pg_dump --format=custom --file backlinks-validation.dump $env:SOURCE_DATABASE_URL
   ```

3. Create an empty temporary database and restore it:

   ```powershell
   pg_restore --clean --if-exists --no-owner --dbname $env:TEMP_RESTORE_DATABASE_URL backlinks-validation.dump
   ```

4. Run the normal migration command against the temporary database and record the migration head. The expected migration head for this block is `0031`.
5. Compare key table counts for metric snapshots, report revisions, task projections, notification projections, and notification read states.
6. Record validation completion time and evaluate:
   - RPO: no more than **60 minutes** between backup creation and validation start.
   - RTO: no more than **4 hours** between validation start and completion.
7. Destroy the temporary database after evidence has been retained.

The validation is successful only when the migration head matches, all key table counts match, and both RPO and RTO targets are met.
