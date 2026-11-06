# PRD: Cloudflare Access User-to-Application Seat Chargeback

Owner: Customer deployment owner
Status: Draft
Last updated: 2026-11-04

## 1. Summary

Build a lightweight, customer-deployable visualization and export tool that maps observed successful Cloudflare Access logins to applications during a selected reporting period. It produces seat-equivalent allocation evidence by splitting one observed user's seat-equivalent across distinct application-owning teams. Finance decides how to use those exports for internal allocation; the tool is not an invoice or contractual billable-seat source of truth.

The revised architecture is:

```
Cloudflare Access access_requests Logpush -> R2 -> scheduled Workflow -> D1 -> Access-protected viewer Worker
```

The system is batch-oriented. It does not ingest every R2 object as it lands because the business output is monthly chargeback, not near-real-time security analytics. A scheduled Workflow is preferred over a single cron Worker because it can process R2 in durable bounded steps, use retries per step, persist cursor state, and resume or restart safely when there are too many files for one Worker invocation.

## 2. Problem statement

The customer pays for Zero Trust / Access seats and needs defensible evidence to support internal cost allocation. Today they can see Access applications and users, but they cannot easily answer:

- Which Access applications did each user use during the billing period?
- Which users used each Access application?
- Which application-owning teams should receive a share of one observed user's seat-equivalent?
- Which apps are missing an owner?
- Which seats cannot be allocated because there is no corresponding Access app usage?

Without this, the customer either allocates cost centrally or uses manual estimates, both of which can be disputed by application teams. The tool supplies transparent evidence and reproducible exports; Finance remains responsible for the actual monetary chargeback decision.

## 3. Goals

1. Attribute each active Access user to one or more Access applications during a billing period.
2. Attribute each Access application to an owning team using structured tags or a fallback mapping table.
3. Split one observed user's seat-equivalent across distinct owning teams for the apps they used.
4. Provide user-to-app and app-to-user reporting.
5. Provide monthly team-level allocated seat-equivalents and distinct observed user counts.
6. Identify unassigned applications and unallocated or unexplained seat-equivalent gaps for Finance review.
7. Apply privacy controls suitable for employee activity data.
8. Use Workflows so ingestion can scale beyond one Worker invocation without moving to event-per-file processing.

## 4. Non-goals

- Measure traffic volume, bytes, request count, or app dwell time. Access seats are charged per user seat, not by data usage.
- Determine billable seat counts, reconcile invoices, calculate monetary charges, or approve financial allocations. The tool produces evidence for Finance, not the financial close itself.
- Infer allocation from user group membership. Group membership is intentionally out of scope.
- Provide real-time security analytics.
- Replace Zero Trust Analytics or Log Explorer.
- Create or modify Cloudflare account resources automatically in the first version.
- Produce payroll, HR, disciplinary, invoice reconciliation, or contractual billing reporting.
- Build a generalized SIEM pipeline.
- Use R2 object-create notifications or Queues for MVP ingestion.

## 5. Source facts and references

| Area | Fact used | Source |
|---|---|---|
| Access logs | The `access_requests` dataset includes `Action`, `Allowed`, `AppDomain`, `AppUUID`, `CreatedAt`, `Email`, `RayID`, and `UserUID`. It does not expose IdP group membership. | [Access Requests dataset](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/access_requests/) |
| Log Explorer alternative | Log Explorer can query `access_requests` with SQL where available. | [Log Explorer API](https://developers.cloudflare.com/observability/logs/log-explorer/api/) |
| Logpush to R2 | Logpush can send logs to R2 and recommends using daily folders. | [Logpush R2 destination](https://developers.cloudflare.com/logs/logpush/logpush-job/enable-destinations/r2/) |
| Workflows scheduling | Workflow instances can be created directly on a schedule using `schedules` in the Workflow binding. This avoids a separate cron Worker just to trigger a Workflow. | [Scheduled Workflows changelog](https://developers.cloudflare.com/changelog/post/2026-06-02-cron-workflows/) and [Trigger Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/) |
| Workflow R2 batching | Workflows can list R2 in bounded batches, persist a cursor, process files, and restart when the listing is truncated. | [Trigger Workflows R2 example](https://developers.cloudflare.com/workflows/build/trigger-workflows/) |
| R2 listing | R2 `list()` supports `prefix`, `limit`, `cursor`, and returns `truncated` plus `cursor` for pagination. Max list page size is 1000, and callers must use `truncated`, not object count, to know if more data exists. | [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) |
| D1 binding | Workers can bind to D1 databases and query through the D1 Workers Binding API. | [D1 get started](https://developers.cloudflare.com/d1/get-started/) |
| Resource Tagging | Resource Tagging supports key-value metadata, includes Access applications, and supports account and zone-level CRUD APIs. | [Resource Tagging public beta](https://developers.cloudflare.com/changelog/post/2026-04-27-resource-tagging-public-beta/) and [resource types](https://developers.cloudflare.com/resource-tagging/reference/resource-types/) |

## 6. Personas

### Finance / chargeback owner

Needs monthly allocated seat-equivalents by internal team and exportable evidence that ties back to an agreed allocation rule. Finance decides how this evidence maps to actual monetary chargeback.

### Zero Trust platform administrator

Needs to configure Logpush, R2, D1, Access policies, app ownership tags, Workflow schedule, and ingestion health checks.

### Application team owner

Needs to see the applications they own, the users attributed to those apps where approved, and the allocated seat share.

### Privacy / compliance reviewer

Needs assurance that employee activity data is minimized, access-controlled, retained for a defined period, and not exposed broadly.

## 7. User stories

1. As a finance owner, I can select a reporting month and see allocated seat-equivalents by team.
2. As a finance owner, I can export a CSV containing team, allocated seat-equivalents, unassigned apps, unallocated or unexplained gaps, report generation time, data-as-of time, ownership snapshot, and method version.
3. As a platform admin, I can see which Access apps have no owner tag.
4. As a platform admin, I can see ingestion status, Workflow instance status, records processed, failed files, and remaining cursors.
5. As a team owner, I can view only the apps owned by my team and the seat seat-equivalent allocation for those apps.
6. As a privacy reviewer, I can disable per-user exports or restrict them to approved roles.
7. As a platform admin, I can rerun ingestion for a date range without duplicating usage rows.
8. As a platform admin, I can tune batch size and lookback window without code changes.

## 8. Architecture

### 9.1 Logical flow

1. Access generates `access_requests` records.
2. Logpush writes account-level `access_requests` logs to R2 using daily folders.
3. A scheduled Workflow runs daily and processes a rolling lookback window.
4. The Workflow lists R2 by date prefix in bounded pages using `limit` and `cursor`.
5. The Workflow processes each file in a separate retryable step.
6. Usage, file state, run state, and app ownership snapshots are written to D1.
7. The viewer Worker is protected by Access and queries D1 for reports.
8. App ownership comes from Access application Resource Tags or a manual override table.

### 9.2 Diagram

See [solution-architecture.svg](solution-architecture.svg).

```text
Access -> Logpush -> R2 -> scheduled Workflow -> D1 -> viewer Worker -> finance and app owners
                         |                 ^
                         |                 |
                         +-> Resource Tagging API -> app owner snapshot
```

## 9. Functional requirements

### 10.1 Log collection

- Create a Logpush job for the account-level `access_requests` dataset.
- Destination is R2 with daily folders, preferably using date-based prefixes.
- Required fields:
  - `Action`
  - `Allowed`
  - `AppDomain`
  - `AppUUID`
  - `CreatedAt`
  - `Email`
  - `RayID`
  - `UserUID`
- Recommended fields:
  - `Connection`
  - `Country`
- Excluded from MVP reporting unless privacy-approved:
  - `IPAddress`
  - purpose justification fields
- Explicitly out of scope:
  - group membership from Access logs. It is not present in `access_requests` and should not drive chargeback.

### 10.2 Scheduled ingestion Workflow

- Runs daily using Workflow `schedules` in `wrangler.jsonc`.
- Does not require a separate cron Worker for the scheduled path.
- Processes a rolling lookback window, default 3 days, to handle late-arriving Logpush files.
- Lists R2 keys by date prefix where possible.
- Uses bounded list pages, default `limit=100` to `500`, not an unbounded full-day scan.
- Uses R2 `truncated` and `cursor` to continue processing.
- Persists cursor or run progress outside the Workflow instance before restart or continuation.
- Processes each R2 object in a retryable `step.do`.
- Maintains a `processed_files` table in D1.
- Reprocessing the same file must be safe.
- Filters events to:
  - `Allowed = true`
  - `Action = login`
  - `UserUID IS NOT NULL`
  - `AppUUID IS NOT NULL`
- Excludes configured application IDs, such as the chargeback viewer app and internal admin apps.
- Stores user identity separately from usage rows.

### 10.3 Workflow continuation and large R2 volumes

The Workflow must not assume one invocation can process all daily files.

Required behaviour:

1. Read the list cursor for `run_id + prefix`, if present.
2. List up to `batch_size` R2 objects under that prefix.
3. Skip files already present in `processed_files` with status `processed`.
4. Process the remaining files using retryable steps.
5. Write per-file status and aggregate counts to D1.
6. If R2 returns `truncated=true`, persist the cursor and continue with another step or restart the Workflow instance.
7. If the prefix is complete, clear the cursor and move to the next date prefix.
8. Mark the Workflow run complete only after every prefix in the lookback window is complete.

Scale-up option:

- If one Workflow instance cannot process the daily lookback within the target window, add controlled fan-out later: Workflow lists keys and enqueues bounded batches to Queues or creates child Workflow instances. This is not MVP.

### 10.4 App ownership

Preferred implementation:

- Use Resource Tagging on Access applications.
- Required tag: `owner_team`.
- Optional tags: `cost_center`, `business_unit`, `environment`, `chargeback_scope`.

Fallback implementation:

- Maintain `app_owner_override` in D1 or a versioned CSV in the repository.

Rules:

- Monthly reports use a snapshot of ownership at report time.
- Historical reports do not change when app ownership changes later.
- Untagged apps are allocated to `unassigned` and highlighted.
- User group membership must not be used as the allocation source.

### 10.5 Allocation engine

Default allocation rule:

1. For each reporting period, find each unique user with at least one successful Access login event.
2. For each user, find the distinct owning teams of the apps used during the period.
3. Split one observed user's seat-equivalent equally across those distinct teams.
4. If multiple apps map to the same team, that team still receives only one share for that user.
5. If ownership is missing, allocate the share to `unassigned`.
6. If Finance provides a billable-seat source that contains users absent from the observed Access login dataset, report the gap as `unallocated` for review rather than automatically assigning cost.

Example:

| User | Apps used | Owning teams | Allocation |
|---|---|---|---|
| user-1 | App A, App B | Team X, Team Y | Team X 0.5 seat-equivalent, Team Y 0.5 seat-equivalent |
| user-2 | App C, App D | Team X, Team X | Team X 1.0 seat-equivalent |
| user-3 | App E | Missing owner | unassigned 1.0 seat-equivalent |

### 10.6 Viewer Worker

- Protected by Cloudflare Access.
- Also validates the Access JWT inside the Worker, not only at the Access policy layer.
- Provides role-based views:
  - Finance/admin: all team seat-equivalent allocations, unassigned apps, unallocated or unexplained gaps, and exports.
  - Platform admin: ingestion health, Workflow health, mapping health, rerun controls.
  - Team owner: own apps and own team's allocation only.
- Supports CSV export for Finance review and internal allocation decisions.
- Per-user detail is off by default for team owners unless customer privacy approval exists.
- Role mapping is configuration-driven. It is not inferred from the historical Access logs.

### 10.7 Administration

- Configuration file or D1 settings table for:
  - billing period timezone
  - report cutoff day
  - lookback window
  - R2 prefix pattern
  - Workflow schedule
  - batch size
  - excluded app UUIDs
  - approved admin roles or identities
  - team owner role mapping
  - retention period
- Health page for:
  - last successful Workflow run
  - last failed Workflow run
  - active Workflow instance ID
  - current prefix and cursor
  - file count processed
  - records inserted
  - untagged app count
  - duplicate file count

### 10.8 Export context and reproducibility

Every generated report or CSV export must retain enough context for Finance to understand and reproduce the numbers later. At minimum, each export must record:

- report ID
- reporting period start and end
- timezone
- generated-at timestamp
- data-as-of timestamp
- coverage status, for example complete, partial, or backfill
- method version
- session assumption, for example 24-hour Access application sessions
- disclaimer text shown to the viewer
- settings and exclusions applied
- ownership snapshot reference
- creator identity where available

Team allocation exports and permission-controlled user-application relationship exports must be separate artifacts. Team totals must be additive. User-application relationship exports must not duplicate team shares across rows.


## 10. Non-functional requirements

### Security

- Deploy HTTP-accessible Workers behind Access.
- Store API tokens as Worker secrets.
- Use least-privilege API tokens for tag reads, Access app reads, and Logpush setup.
- Do not expose raw R2 logs through the viewer.
- Do not rely on user groups in logs for chargeback, because they are not present in `access_requests`.

### Privacy

- The viewer must prominently disclose that login-based attribution may miss activity where a user authenticated before the reporting period and reused an existing session inside the period. The default deployment assumption is 24-hour Access application sessions, but this must be validated with the customer's actual Access app policies.
- Treat data as employee activity metadata.
- Minimize stored fields.
- Store email separately from usage events.
- Support per-user data suppression in UI and exports.
- Define retention before production, suggested default 13 months.
- Document that customer privacy/legal/HR review may be required, especially in EU contexts.

### Reliability

- Ingestion must be idempotent.
- Failed files remain retryable.
- Workflow steps must have explicit retry limits and timeouts.
- Daily job failure must not lose data if the lookback window still covers the missed period.
- Monthly close should include a configurable lag, for example close month after 3 days, to absorb late Logpush files.
- Cursor state must survive Workflow restarts.

### Performance

- MVP should handle moderate enterprise Access event volume with a scheduled Workflow and bounded file batches.
- R2 listing must use `truncated` and `cursor`, never a single full bucket scan.
- If daily volume exceeds one Workflow instance target duration, add Workflow-controlled fan-out as a later phase.
- Queues are not part of MVP because near-real-time ingestion is not required.

## 11. D1 schema proposal

```sql
CREATE TABLE processed_files (
  key TEXT PRIMARY KEY,
  etag TEXT,
  size INTEGER,
  processed_at TEXT NOT NULL,
  records_seen INTEGER NOT NULL DEFAULT 0,
  records_inserted INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'processed',
  error TEXT
);

CREATE TABLE workflow_runs (
  run_id TEXT PRIMARY KEY,
  period TEXT,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  current_prefix TEXT,
  current_cursor TEXT,
  files_seen INTEGER NOT NULL DEFAULT 0,
  files_processed INTEGER NOT NULL DEFAULT 0,
  records_inserted INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

CREATE TABLE users (
  user_uid TEXT PRIMARY KEY,
  email TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE usage (
  period TEXT NOT NULL,
  user_uid TEXT NOT NULL,
  app_uuid TEXT NOT NULL,
  app_domain TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  login_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (period, user_uid, app_uuid)
);

CREATE TABLE app_owner_snapshot (
  period TEXT NOT NULL,
  app_uuid TEXT NOT NULL,
  app_domain TEXT,
  owner_team TEXT,
  cost_center TEXT,
  source TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  PRIMARY KEY (period, app_uuid)
);

CREATE TABLE app_owner_override (
  app_uuid TEXT PRIMARY KEY,
  owner_team TEXT NOT NULL,
  cost_center TEXT,
  reason TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE report_exports (
  report_id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  timezone TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  data_as_of TEXT NOT NULL,
  coverage_status TEXT NOT NULL,
  method_version TEXT NOT NULL,
  session_assumption TEXT NOT NULL,
  disclaimer_text TEXT NOT NULL,
  settings_json TEXT NOT NULL,
  ownership_snapshot_ref TEXT,
  created_by TEXT,
  scope TEXT NOT NULL DEFAULT 'finance_review'
);

CREATE TABLE report_export_files (
  report_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  storage_key TEXT,
  checksum TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (report_id, artifact_type),
  FOREIGN KEY (report_id) REFERENCES report_exports(report_id)
);


CREATE TABLE run_state (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 12. Allocation query shape

```sql
WITH user_team AS (
  SELECT DISTINCT
    u.period,
    u.user_uid,
    COALESCE(a.owner_team, 'unassigned') AS owner_team
  FROM usage u
  LEFT JOIN app_owner_snapshot a
    ON a.period = u.period
   AND a.app_uuid = u.app_uuid
),
team_counts AS (
  SELECT
    period,
    user_uid,
    COUNT(*) AS team_count
  FROM user_team
  GROUP BY period, user_uid
)
SELECT
  ut.period,
  ut.owner_team,
  SUM(1.0 / tc.team_count) AS allocated_seats
FROM user_team ut
JOIN team_counts tc
  ON tc.period = ut.period
 AND tc.user_uid = ut.user_uid
GROUP BY ut.period, ut.owner_team
ORDER BY allocated_seats DESC;
```

## 13. Edge cases and decisions

| Topic | Decision / proposal | Risk |
|---|---|---|
| Login-only signal | Use successful login events as the MVP signal. | Long-lived sessions may undercount users who logged in before the billing period. |
| Long-lived sessions | Spike must validate whether this materially affects reporting. Consider shorter session duration or carry-forward logic. | May require policy changes outside this tool. |
| Group membership | Dropped. Do not use groups from logs for allocation. | Historical logs do not include groups, and group membership is not the right cost ownership model. |
| Denied requests | Exclude. | None. They do not represent successful app usage. |
| Logout events | Exclude from MVP allocation. | Logout quality may vary and is not needed for seat presence. |
| Multiple apps same owner | Count owner once per user per period. | Matches seat cost sharing better than app count. |
| Missing owner | Allocate to `unassigned` and report. | Creates follow-up work for app owners. |
| Seat users outside observed Access app logs | Report as `unallocated` or unexplained only if Finance provides a separate billable-seat source. | The tool should not invent billable users or monetary allocation without an external source. |
| R2 notifications and Queues | Not MVP. | Adds complexity without monthly chargeback benefit. |
| Single cron Worker | Replaced by scheduled Workflow. | One Worker invocation may not process large R2 deltas safely. |
| Log Explorer | Optional simplification if customer has entitlement. | Customer may not have it or retention may be insufficient. |

## 14. MVP scope

### Included

- Repository with Worker and Workflow project skeleton.
- D1 schema and migrations.
- Scheduled Workflow with R2 listing, cursor persistence, retryable file processing, and idempotent D1 writes.
- R2 log parser for `access_requests` JSON/NDJSON gzip files.
- App ownership snapshot from Resource Tagging or D1 override table.
- Monthly allocation query.
- Access-protected viewer with admin summary and CSV export.
- Basic Workflow health dashboard.
- Solution architecture diagram.

### Excluded from MVP

- Queue-based ingestion.
- R2 object-create notification ingestion.
- Real-time dashboards.
- Group membership based allocation.
- Per-request traffic usage analysis.
- Automated Logpush job creation.
- Automated R2 bucket creation.
- Automated Access policy creation.
- Customer-specific HR/privacy workflow automation.

## 15. Spike plan

Run a 1 to 2 week spike before production build.

Deliverables:

1. Confirm Logpush to R2 for `access_requests` is available in the customer's plan.
2. Confirm expected R2 file count and file size per day.
3. Confirm scheduled Workflow can process the expected daily delta plus lookback using bounded batches.
4. Compare distinct successful Access login users against Zero Trust used seats.
5. Confirm whether long-lived sessions cause material undercounting.
6. Validate Resource Tagging API access for Access applications.
7. Produce sample report for one week of data.
8. Document privacy constraints and approved roles for per-user visibility.

Exit criteria:

- At least 95% of known app usage use cases appear in `access_requests`, or gaps are explicitly accepted.
- The Workflow can finish or safely resume the daily lookback processing.
- The unassigned app list is actionable.
- The unallocated seat bucket is explained and accepted.
- Customer approves allocation rule and privacy model.

## 16. Implementation milestones

### Milestone 0: Repository setup

- Create GitLab project.
- Add PRD, README, schema draft, and solution diagram.

### Milestone 1: Local parser and schema

- Implement parser with fixture logs.
- Implement D1 migrations.
- Unit test idempotent inserts.

### Milestone 2: Scheduled Workflow ingestion

- Add R2 and D1 bindings.
- Add Workflow with direct schedule.
- Implement daily lookback scan.
- Implement cursor persistence and Workflow continuation.
- Add `processed_files` and `workflow_runs` state.

### Milestone 3: Ownership snapshot

- Implement Resource Tagging read path or mapping override path.
- Add unassigned app report.

### Milestone 4: Allocation and viewer

- Add allocation SQL.
- Build Access-protected viewer routes.
- Add CSV export.

### Milestone 5: Production hardening

- Add health checks.
- Add retention job.
- Add admin runbook.
- Add privacy review checklist.

## 17. Acceptance criteria

- Given a month with successful Access login events, the system produces user-to-app and app-to-user reports.
- Given app ownership tags, the system produces allocated seats by team.
- Given the same R2 file processed twice, allocated results do not change.
- Given an untagged app, the app appears in the unassigned report.
- Given a user using apps from two teams, each team receives 0.5 allocated seat-equivalent for that user.
- Given a user using two apps from the same team, that team receives 1.0 allocated seat-equivalent for that user.
- Given a large R2 prefix with `truncated=true`, the Workflow persists the cursor and continues without losing progress.
- Given a failed file step, the Workflow retries according to configured retry policy and records failure state if retries are exhausted.
- Given a team owner, the viewer does not expose other teams' rows.
- Given privacy configuration disables per-user export, the viewer only exports aggregate data.

## 18. Open questions

1. Is the customer on a plan that includes Logpush for `access_requests` to R2?
2. Does the customer have Log Explorer? If yes, is retention sufficient for spike or fallback?
3. What is the contractual billing period and seat reconciliation source?
4. Are joiners/leavers prorated commercially, or is the report only a proportional allocation of the customer's bill?
5. What Access application types are in scope: self-hosted, SaaS, private network, SSH/RDP?
6. What is the customer's required retention period?
7. Can app ownership be represented using Resource Tagging, or does the customer need a manual mapping table?
8. Which user populations should be excluded, such as break-glass accounts or service identities?
9. Who is allowed to see per-user detail?
10. How should unallocated seats be charged internally?
11. What Workflow batch size and timeout are appropriate for the customer's observed R2 file volume?

## 19. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Long sessions hide monthly app usage | Under-allocation to app teams | Validate in spike; consider carry-forward by session duration or shorter sessions. |
| Missing ownership tags | Large unassigned bucket | Add owner tag readiness report and block production close until below threshold. |
| Logpush starts mid-month | Partial-month data | Mark report partial and do not use for chargeback until full period captured. |
| Privacy objections | Viewer cannot show per-user data | Default to aggregate reporting and require explicit approval for per-user views. |
| R2 volume exceeds one Worker invocation | Ingestion incomplete | Use scheduled Workflow with bounded batches, cursor persistence, and restart or continuation. |
| Workflow restart loses in-memory state | Duplicate or skipped files | Persist cursor and processed file state in D1 before restart. |
| Seat reconciliation mismatch | Finance disputes allocation | Include unallocated bucket and document source limitations. |

## 20. Repository structure

```
README.md
docs/prd.md
docs/runbook.md
docs/privacy-review.md
docs/deployment-guide.md
docs/solution-architecture.svg
migrations/0001_initial.sql
src/workflows/ingest.ts
src/viewer.ts
src/allocation.ts
test/fixtures/access_requests.ndjson
wrangler.jsonc
```
