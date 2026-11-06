# Runbook Draft

## Daily ingestion

1. Scheduled Workflow starts from `schedules` in Wrangler configuration.
2. Workflow determines the lookback window, default 3 days.
3. Workflow lists R2 by date prefix with bounded `limit` and persisted `cursor`.
4. R2 objects already present in `processed_files` with status `processed` are skipped.
5. Successful `Allowed=true`, `Action=login` records are upserted into D1.
6. Ownership snapshots are refreshed from Resource Tagging or override mapping.
7. Workflow clears cursor state only after a prefix is complete.

## Monthly visualization and export

1. Wait configured lag, default 3 days after month end.
2. Re-run ingestion for the final lookback window.
3. Review unassigned apps.
4. Review unallocated or unexplained gaps only if Finance provides a separate billable-seat source.
5. Generate separate exports for team seat-equivalent totals and permission-controlled user-application relationships.
6. Persist report context: report ID, period, timezone, generated-at time, data-as-of time, coverage status, method version, ownership snapshot, session assumption, disclaimer, and applied settings.
7. Provide the exports to Finance for internal allocation decisions. The tool does not perform invoice reconciliation, determine billable seats, or approve monetary charges.

## Required viewer disclaimer

Reports are based on observed successful Cloudflare Access login events for the selected period. If a user authenticated before the period and reused an existing session inside the period, that activity may not appear in the logs used for attribution. The default deployment assumption is 24-hour Access application sessions, but customers must validate this against their actual Access app policies.

## Privacy defaults

- Aggregate reporting enabled by default.
- Per-user reporting restricted to approved admin roles.
- Retention target: 13 months unless customer policy differs.
- Do not use user group membership for allocation.
