import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { buildAllocationQuery, datePrefixes, getLookbackDates, monthFromDate, normalizeAccessRecord, parseCsv, parseNdjson, type NormalizedAccessEvent } from "./lib";

export interface Env {
  DB: D1Database;
  LOG_BUCKET: R2Bucket;
  INGEST_WORKFLOW: Workflow<IngestParams>;
  CLOUDFLARE_API_TOKEN?: string;
  ACCOUNT_ID?: string;
  LOOKBACK_DAYS?: string;
  BATCH_SIZE?: string;
  MAX_PAGES_PER_RUN?: string;
  LOG_PREFIX?: string;
  OWNER_TAG_KEY?: string;
  EXCLUDED_APP_UUIDS?: string;
  ADMIN_EMAILS?: string;
  MAIN_ADMIN_EMAILS?: string;
  SESSION_ASSUMPTION?: string;
  METHOD_VERSION?: string;
}

type IngestParams = { lookbackDays?: number; prefixes?: string[]; batchSize?: number; reason?: string };
type AccessIdentity = { email?: string; name?: string };
type FileProcessResult = { key: string; recordsSeen: number; recordsInserted: number; skipped: boolean };

const VIEWER_DISCLAIMER = "Reports are based on observed successful Cloudflare Access login events for the selected period. Existing-session activity and reporting-period boundary activity may be absent from login-based attribution. Validate the 24-hour session assumption against the actual Access app policies.";

const nowIso = () => new Date().toISOString();
function envNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.floor(parsed))) : fallback;
}
function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers); headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}
function html(body: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers); headers.set("content-type", "text/html; charset=utf-8");
  return new Response(body, { ...init, headers });
}
function csv(body: string, filename: string): Response {
  return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${filename}"` } });
}
async function getIdentity(request: Request, ctx: ExecutionContext): Promise<AccessIdentity | null> {
  const access = (ctx as any).access;
  if (access) { const identity = await access.getIdentity(); return { email: identity?.email, name: identity?.name }; }
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" ? { email: "admin@example.com", name: "Local Admin" } : null;
}
function isAdmin(identity: AccessIdentity | null, env: Env): boolean {
  const admins = parseCsv(env.ADMIN_EMAILS).map((entry) => entry.toLowerCase());
  return admins.length === 0 || (!!identity?.email && admins.includes(identity.email.toLowerCase()));
}
function isMainAdmin(identity: AccessIdentity | null, env: Env): boolean {
  const mainAdmins = parseCsv(env.MAIN_ADMIN_EMAILS).map((entry) => entry.toLowerCase());
  return mainAdmins.length > 0 && !!identity?.email && mainAdmins.includes(identity.email.toLowerCase());
}
async function requireAdmin(request: Request, env: Env, ctx: ExecutionContext): Promise<AccessIdentity | Response> {
  const identity = await getIdentity(request, ctx);
  if (!identity) return json({ error: "Cloudflare Access authentication required" }, { status: 403 });
  if (!isAdmin(identity, env)) return json({ error: "Admin permission required" }, { status: 403 });
  return identity;
}
async function objectText(object: R2ObjectBody): Promise<string> {
  const encoding = object.httpMetadata?.contentEncoding?.toLowerCase();
  if (object.key.endsWith(".gz") || encoding === "gzip") {
    const stream = object.body.pipeThrough(new DecompressionStream("gzip"));
    return await new Response(stream).text();
  }
  return await object.text();
}
async function alreadyProcessed(db: D1Database, key: string, etag?: string): Promise<boolean> {
  const row = await db.prepare("SELECT etag, status FROM processed_files WHERE key = ?").bind(key).first<{ etag: string | null; status: string }>();
  return !!row && row.status === "processed" && (!etag || row.etag === etag);
}
async function upsertEvent(db: D1Database, event: NormalizedAccessEvent): Promise<void> {
  await db.batch([
    db.prepare("INSERT INTO access_events (ray_id, created_at, period, user_uid, email, app_uuid, app_domain) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ray_id) DO NOTHING").bind(event.rayId, event.createdAt, event.period, event.userUid, event.email, event.appUuid, event.appDomain),
    db.prepare("INSERT INTO users (user_uid, email, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_uid) DO UPDATE SET email = COALESCE(excluded.email, users.email), last_seen_at = MAX(users.last_seen_at, excluded.last_seen_at)").bind(event.userUid, event.email, event.createdAt, event.createdAt),
    db.prepare("INSERT INTO usage (period, user_uid, app_uuid, app_domain, first_seen_at, last_seen_at, login_count) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(period, user_uid, app_uuid) DO UPDATE SET app_domain = COALESCE(excluded.app_domain, usage.app_domain), first_seen_at = MIN(usage.first_seen_at, excluded.first_seen_at), last_seen_at = MAX(usage.last_seen_at, excluded.last_seen_at), login_count = usage.login_count + 1").bind(event.period, event.userUid, event.appUuid, event.appDomain, event.createdAt, event.createdAt),
  ]);
}
async function processFile(env: Env, key: string): Promise<FileProcessResult> {
  const object = await env.LOG_BUCKET.get(key);
  if (!object) return { key, recordsSeen: 0, recordsInserted: 0, skipped: true };
  if (await alreadyProcessed(env.DB, key, object.etag)) return { key, recordsSeen: 0, recordsInserted: 0, skipped: true };
  const excludedApps = new Set(parseCsv(env.EXCLUDED_APP_UUIDS));
  let parsed = 0, inserted = 0;
  try {
    const records = parseNdjson(await objectText(object)); parsed = records.length;
    for (const record of records) { const event = normalizeAccessRecord(record); if (!event || excludedApps.has(event.appUuid)) continue; await upsertEvent(env.DB, event); inserted += 1; }
    await env.DB.prepare("INSERT INTO processed_files (key, etag, size, processed_at, records_seen, records_inserted, status, error) VALUES (?, ?, ?, ?, ?, ?, 'processed', NULL) ON CONFLICT(key) DO UPDATE SET etag = excluded.etag, size = excluded.size, processed_at = excluded.processed_at, records_seen = excluded.records_seen, records_inserted = excluded.records_inserted, status = 'processed', error = NULL").bind(key, object.etag ?? null, object.size, nowIso(), parsed, inserted).run();
    return { key, recordsSeen: parsed, recordsInserted: inserted, skipped: false };
  } catch (error) {
    await env.DB.prepare("INSERT INTO processed_files (key, etag, size, processed_at, records_seen, records_inserted, status, error) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?) ON CONFLICT(key) DO UPDATE SET processed_at = excluded.processed_at, records_seen = excluded.records_seen, records_inserted = excluded.records_inserted, status = 'failed', error = excluded.error").bind(key, object.etag ?? null, object.size, nowIso(), parsed, inserted, String(error)).run();
    throw error;
  }
}
async function getRunState(db: D1Database, name: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM run_state WHERE name = ?").bind(name).first<{ value: string }>(); return row?.value ?? null;
}
async function setRunState(db: D1Database, name: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO run_state (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(name, value, nowIso()).run();
}
async function deleteRunState(db: D1Database, name: string): Promise<void> { await db.prepare("DELETE FROM run_state WHERE name = ?").bind(name).run(); }
async function ensureOwnerSnapshots(env: Env): Promise<void> {
  await env.DB.prepare("INSERT OR IGNORE INTO app_owner_snapshot (period, app_uuid, app_domain, owner_team, cost_center, source, captured_at) SELECT DISTINCT u.period, u.app_uuid, u.app_domain, o.owner_team, o.cost_center, CASE WHEN o.owner_team IS NULL THEN 'usage_unassigned' ELSE 'override' END, ? FROM usage u LEFT JOIN app_owner_override o ON o.app_uuid = u.app_uuid").bind(nowIso()).run();
}
async function syncResourceTags(env: Env): Promise<unknown> {
  if (!env.CLOUDFLARE_API_TOKEN || !env.ACCOUNT_ID) { await ensureOwnerSnapshots(env); return { skipped: true, reason: "CLOUDFLARE_API_TOKEN or ACCOUNT_ID not configured" }; }
  const headers = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, "content-type": "application/json" };
  const appsResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/access/apps?per_page=1000`, { headers });
  if (!appsResponse.ok) throw new Error(`Access apps API failed: ${appsResponse.status}`);
  const appsPayload: any = await appsResponse.json(); const apps = Array.isArray(appsPayload.result) ? appsPayload.result : [];
  const periods = await env.DB.prepare("SELECT DISTINCT period FROM usage").all<{ period: string }>();
  const activePeriods = (periods.results ?? [{ period: monthFromDate() }]).map((row) => row.period);
  let snapshots = 0;
  for (const app of apps) {
    const tagsResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/tags?resource_type=access_application&resource_id=${app.uid || app.id}`, { headers });
    const tagsPayload: any = tagsResponse.ok ? await tagsResponse.json() : {};
    const tags = tagsPayload.result?.tags || tagsPayload.result || {};
    const owner = tags[env.OWNER_TAG_KEY || "owner_team"] || null;
    const costCenter = tags.cost_center || null;
    for (const period of activePeriods) {
      await env.DB.prepare(`INSERT INTO app_owner_snapshot (period, app_uuid, app_domain, owner_team, cost_center, source, captured_at, tag_owner_team, tag_cost_center, tag_captured_at)
VALUES (?, ?, ?, ?, ?, 'resource_tagging', ?, ?, ?, ?)
ON CONFLICT(period, app_uuid) DO UPDATE SET
  app_domain = COALESCE(excluded.app_domain, app_owner_snapshot.app_domain),
  tag_owner_team = excluded.tag_owner_team,
  tag_cost_center = excluded.tag_cost_center,
  tag_captured_at = excluded.tag_captured_at,
  owner_team = CASE WHEN app_owner_snapshot.source = 'manual_override' THEN app_owner_snapshot.owner_team ELSE excluded.owner_team END,
  cost_center = CASE WHEN app_owner_snapshot.source = 'manual_override' THEN app_owner_snapshot.cost_center ELSE excluded.cost_center END,
  source = CASE WHEN app_owner_snapshot.source = 'manual_override' THEN app_owner_snapshot.source ELSE 'resource_tagging' END,
  captured_at = CASE WHEN app_owner_snapshot.source = 'manual_override' THEN app_owner_snapshot.captured_at ELSE excluded.captured_at END`).bind(period, app.uid || app.id, app.domain || null, owner, costCenter, nowIso(), owner, costCenter, nowIso()).run();
      snapshots += 1;
    }
  }
  await ensureOwnerSnapshots(env); return { skipped: false, apps: apps.length, snapshots };
}
async function allocationRows(env: Env, period: string): Promise<unknown[]> { const query = buildAllocationQuery(period); return (await env.DB.prepare(query.sql).bind(...query.params).all()).results ?? []; }
async function availablePeriods(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT DISTINCT period FROM usage ORDER BY period DESC").all<{ period: string }>();
  return (rows.results ?? []).map((row) => row.period);
}
async function resolvePeriod(env: Env, requested: string | null): Promise<string> {
  if (requested && /^\d{4}-\d{2}$/.test(requested)) return requested;
  const periods = await availablePeriods(env);
  return periods[0] ?? monthFromDate();
}
async function triggerWorkflow(env: Env, params: IngestParams): Promise<string> { const instance = await env.INGEST_WORKFLOW.create({ params }); return instance.id; }

export class IngestWorkflow extends WorkflowEntrypoint<Env, IngestParams> {
  async run(event: WorkflowEvent<IngestParams>, step: WorkflowStep) {
    const params = event.payload || {};
    const lookbackDays = params.lookbackDays ?? envNumber(this.env.LOOKBACK_DAYS, 3, 0, 31);
    const batchSize = params.batchSize ?? envNumber(this.env.BATCH_SIZE, 100, 1, 1000);
    const maxPages = envNumber(this.env.MAX_PAGES_PER_RUN, 10, 1, 100);
    const prefixes = params.prefixes ?? datePrefixes(this.env.LOG_PREFIX || "", getLookbackDates(new Date(), lookbackDays));
    const runId = event.instanceId;
    let filesSeen = 0, filesProcessed = 0, recordsInserted = 0;
    await step.do("mark run started", async () => {
      await this.env.DB.prepare("INSERT OR REPLACE INTO workflow_runs (run_id, period, window_start, window_end, status, started_at, current_prefix) VALUES (?, ?, ?, ?, 'running', ?, ?)").bind(runId, monthFromDate(), prefixes[0] || "", prefixes[prefixes.length - 1] || "", nowIso(), prefixes[0] || "").run();
    });
    for (const prefix of prefixes) {
      let page = 0;
      while (page < maxPages) {
        const stateName = `cursor:${runId}:${prefix}`;
        const listResult = await step.do(`list ${prefix || "root"} page ${page + 1}`, async () => {
          const cursor = (await getRunState(this.env.DB, stateName)) || undefined;
          const listed = await this.env.LOG_BUCKET.list({ prefix, limit: batchSize, cursor });
          if (listed.truncated && listed.cursor) await setRunState(this.env.DB, stateName, listed.cursor);
          else await deleteRunState(this.env.DB, stateName);
          return { keys: listed.objects.map((obj) => obj.key), truncated: listed.truncated };
        });
        filesSeen += listResult.keys.length;
        for (const key of listResult.keys) {
          const result = await step.do(`process ${key}`.slice(0, 128), { retries: { limit: 3, delay: "30 seconds", backoff: "exponential" }, timeout: "10 minutes" }, () => processFile(this.env, key));
          if (!result.skipped) filesProcessed += 1;
          recordsInserted += result.recordsInserted;
        }
        await step.do("save run progress", async () => {
          await this.env.DB.prepare("UPDATE workflow_runs SET current_prefix = ?, files_seen = ?, files_processed = ?, records_inserted = ?, current_cursor = ? WHERE run_id = ?").bind(prefix, filesSeen, filesProcessed, recordsInserted, await getRunState(this.env.DB, stateName), runId).run();
        });
        if (!listResult.truncated) break;
        page += 1;
      }
    }
    const tags = await step.do("snapshot owners", () => syncResourceTags(this.env));
    await step.do("mark run complete", async () => {
      await this.env.DB.prepare("UPDATE workflow_runs SET status = 'complete', finished_at = ?, files_seen = ?, files_processed = ?, records_inserted = ? WHERE run_id = ?").bind(nowIso(), filesSeen, filesProcessed, recordsInserted, runId).run();
    });
    return { filesSeen, filesProcessed, recordsInserted, tags };
  }
}

async function renderHome(env: Env, period: string, identity: AccessIdentity): Promise<Response> {
  const canWriteOwners = isMainAdmin(identity, env);
  const [allocations, runs, unassigned, owners, periods] = await Promise.all([
    allocationRows(env, period),
    env.DB.prepare("SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT 10").all(),
    env.DB.prepare("SELECT u.app_uuid, u.app_domain, COUNT(DISTINCT u.user_uid) AS users FROM usage u LEFT JOIN app_owner_snapshot a ON a.period = u.period AND a.app_uuid = u.app_uuid WHERE u.period = ? AND a.owner_team IS NULL GROUP BY u.app_uuid, u.app_domain ORDER BY users DESC LIMIT 25").bind(period).all(),
    env.DB.prepare("SELECT o.app_uuid, COALESCE(MAX(u.app_domain), '') AS app_domain, o.owner_team, o.cost_center, o.reason, o.updated_by, o.updated_at, MAX(s.tag_owner_team) AS tag_owner_team, MAX(s.tag_cost_center) AS tag_cost_center FROM app_owner_override o LEFT JOIN usage u ON u.app_uuid = o.app_uuid LEFT JOIN app_owner_snapshot s ON s.period = ? AND s.app_uuid = o.app_uuid GROUP BY o.app_uuid, o.owner_team, o.cost_center, o.reason, o.updated_by, o.updated_at ORDER BY o.updated_at DESC LIMIT 50").bind(period).all(),
    availablePeriods(env),
  ]);
  const rows = allocations.map((row: any) => `<tr><td>${row.owner_team}</td><td>${Number(row.allocated_seat_equivalents).toFixed(2)}</td><td>${row.distinct_users}</td></tr>`).join("");
  const unassignedRows = (unassigned.results ?? []).map((row: any) => `<tr><td>${row.app_uuid}</td><td>${row.app_domain || ""}</td><td>${row.users}</td><td>${canWriteOwners ? ownerForm(row.app_uuid, row.app_domain || "", period) : "Read only"}</td></tr>`).join("");
  const ownerRows = (owners.results ?? []).map((row: any) => {
    const tagConflict = !!row.tag_owner_team && row.tag_owner_team !== row.owner_team;
    const tagCell = row.tag_owner_team
      ? `<span class="${tagConflict ? "conflict" : "muted"}">${tagConflict ? `&#9888; Resource tag: ${row.tag_owner_team} (differs from override)` : row.tag_owner_team}</span>`
      : '<span class="muted">none</span>';
    return `<tr><td>${row.app_uuid}</td><td>${row.app_domain || ""}</td><td>${row.owner_team}</td><td>${row.cost_center || ""}</td><td>${tagCell}</td><td>${canWriteOwners ? ownerForm(row.app_uuid, row.app_domain || "", period, row.owner_team, row.cost_center || "") : "Read only"}</td><td>${row.updated_by || ""}</td><td>${row.updated_at || ""}</td></tr>`;
  }).join("");
  const writeNotice = canWriteOwners ? "Owner override writes enabled for this main admin. Admin-set team and cost center override resource tags; a resource tag with different information is highlighted in the overrides table." : "Owner override writes are disabled for your user. Only MAIN_ADMIN_EMAILS can write owner mappings.";
  const periodOptions = (periods.includes(period) ? periods : [period, ...periods])
    .map((option) => `<option value="${option}"${option === period ? " selected" : ""}>${option}</option>`)
    .join("");
  return html(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Access seat-equivalent allocation</title>
<style>
:root{--orange:#f6821f;--orange-dark:#c05621;--ink:#111827;--muted:#6b7280;--line:#e5e7eb;--soft:#f8fafc}*{box-sizing:border-box}body{margin:0;background:var(--soft);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5}a{color:var(--orange-dark);font-weight:650;text-decoration:none}a:hover{text-decoration:underline}.top{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);z-index:5}.top-in{max-width:1180px;margin:0 auto;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px}.brand{display:flex;align-items:center;gap:12px;font-weight:800}.logo{width:34px;height:24px;border-radius:999px;background:linear-gradient(135deg,#faae40,var(--orange));box-shadow:0 8px 22px rgba(246,130,31,.28)}.nav{display:flex;gap:14px;flex-wrap:wrap;font-size:14px}.hero{background:linear-gradient(135deg,#fff 0%,#fff7ed 45%,#fff 100%);border-bottom:1px solid var(--line)}.hero-in{max-width:1180px;margin:0 auto;padding:44px 24px 34px}.eyebrow{color:var(--orange-dark);font-size:13px;text-transform:uppercase;letter-spacing:.09em;font-weight:850}h1{margin:8px 0 10px;font-size:42px;line-height:1.05;letter-spacing:-.04em}.lead{max-width:820px;color:#374151;font-size:17px;margin:0}.wrap{max-width:1180px;margin:0 auto;padding:28px 24px 56px}.toolbar{display:flex;align-items:end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}.period{display:flex;gap:10px;align-items:end;background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px;box-shadow:0 8px 24px rgba(15,23,42,.04)}label{display:grid;gap:5px;color:var(--muted);font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.05em}input,select{border:1px solid #d1d5db;border-radius:10px;padding:9px 10px;font:inherit;min-height:38px;background:#fff}button,.button{border:0;border-radius:999px;padding:10px 14px;min-height:38px;background:var(--ink);color:#fff;font-weight:800;cursor:pointer;display:inline-flex}.button.secondary{background:#fff;color:var(--ink);border:1px solid var(--line)}.actions{display:flex;gap:10px;flex-wrap:wrap}.notice{padding:14px 16px;background:#fff7ed;border:1px solid #fed7aa;border-left:5px solid var(--orange);border-radius:14px;color:#7c2d12;margin:18px 0}.section{background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:0 10px 30px rgba(15,23,42,.05);margin:18px 0;overflow:hidden}.section-head{padding:18px 20px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:16px;align-items:center}h2{margin:0;font-size:20px}.muted{color:var(--muted)}.table{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th{text-align:left;color:#4b5563;background:#f9fafb;font-size:12px;text-transform:uppercase;letter-spacing:.06em}th,td{border-bottom:1px solid var(--line);padding:12px 14px;vertical-align:top}code{background:#f3f4f6;padding:2px 5px;border-radius:6px;font-size:12px}.inline{display:flex;gap:8px;flex-wrap:wrap}.inline input{max-width:170px;min-width:120px}.inline button{padding:8px 12px;min-height:34px;background:var(--orange)}pre{margin:0;padding:18px;background:#0f172a;color:#e5e7eb;overflow:auto}.empty{color:var(--muted);text-align:center;padding:22px}@media(max-width:640px){.top-in,.hero-in,.wrap{padding-left:16px;padding-right:16px}.period{width:100%}h1{font-size:34px}}
</style>
<style>.conflict{display:inline-block;background:#fef3c7;color:#92400e;border:1px solid #fcd34d;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:700}.foot{border-top:1px solid var(--line);background:#fff;margin-top:24px}.foot-in{max-width:1180px;margin:0 auto;padding:18px 24px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;color:var(--muted);font-size:13px}.foot nav{display:flex;gap:14px;flex-wrap:wrap}</style>
</head>
<body>
<header class="top"><div class="top-in"><div class="brand"><span class="logo"></span><span>Cloudflare Access allocation demo</span></div><nav class="nav"><a href="/api/health">Health</a><a href="/api/runs">Runs</a><a href="/api/app-owners">App owners</a></nav></div></header>
<section class="hero"><div class="hero-in"><div class="eyebrow">Zero Trust reporting</div><h1>Access seat-equivalent allocation evidence</h1><p class="lead">Map observed Access logins to applications, assign application owners, and export evidence for Finance review.</p></div></section>
<main class="wrap"><div class="toolbar"><form class="period" method="get" action="/"><label>Reporting period<select name="period" onchange="this.form.submit()">${periodOptions}</select></label><button>View period</button></form><div class="actions"><a class="button secondary" href="/api/allocation.csv?period=${period}">Download team CSV</a><a class="button secondary" href="/api/relationships.csv?period=${period}">Download relationship CSV</a></div></div>
<div class="notice"><strong>Attribution note.</strong> ${VIEWER_DISCLAIMER}<br>${writeNotice}</div>
<section class="section"><div class="section-head"><h2>Team totals</h2><span class="muted">Evidence, not invoice truth</span></div><div class="table"><table><thead><tr><th>Owner team</th><th>Seat-equivalents</th><th>Distinct users</th></tr></thead><tbody>${rows}</tbody></table></div></section>
<section class="section"><div class="section-head"><h2>Unassigned apps</h2><span class="muted">Manual mapping available to main admins</span></div><div class="table"><table><thead><tr><th>App UUID</th><th>Domain</th><th>Users</th><th>Manual owner</th></tr></thead><tbody>${unassignedRows}</tbody></table></div></section>
<section class="section"><div class="section-head"><h2>Manual owner overrides</h2><span class="muted">Override wins over resource tags; conflicting tags are highlighted</span></div><div class="table"><table><thead><tr><th>App UUID</th><th>Domain</th><th>Owner team</th><th>Cost center</th><th>Resource tag</th><th>Modify</th><th>Updated by</th><th>Updated at</th></tr></thead><tbody>${ownerRows}</tbody></table></div></section>
<section class="section"><div class="section-head"><h2>Recent Workflow runs</h2><span class="muted">R2 ingestion health</span></div><pre>${JSON.stringify(runs.results ?? [], null, 2)}</pre></main><footer class="foot"><div class="foot-in"><span>Demo for demonstration purposes only - not for production workloads.</span><nav><a href="https://www.cloudflare.com/website-terms/" target="_blank" rel="noopener">Website and Online Services Terms of Use</a><a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener">Privacy Policy</a></nav></div></footer></body></html>`);
}

function escapeAttr(value: string): string { return value.replace(/&/g, "\u0026amp;").replace(/"/g, "\u0026#34;").replace(/</g, "\u0026lt;"); }
function ownerForm(appUuid: string, appDomain: string, period: string, ownerTeam = "", costCenter = ""): string {
  return `<form class="inline" method="post" action="/api/app-owner"><input type="hidden" name="period" value="${period}"><input type="hidden" name="app_uuid" value="${appUuid}"><input type="hidden" name="app_domain" value="${appDomain}"><input name="owner_team" value="${escapeAttr(ownerTeam)}" placeholder="owner_team" required pattern="[A-Za-z0-9 ._:-]{1,120}"> <input name="cost_center" value="${escapeAttr(costCenter)}" placeholder="cost_center"> <button>${ownerTeam ? "Update" : "Assign"}</button></form>`;
}
function validateOwnerTeam(value: string): boolean {
  return /^[A-Za-z0-9 ._:-]{1,120}$/.test(value);
}
async function upsertOwnerOverride(request: Request, env: Env, identity: AccessIdentity): Promise<Response> {
  if (!isMainAdmin(identity, env)) return json({ error: "Main admin permission required" }, { status: 403 });
  const contentType = request.headers.get("content-type") || "";
  let data: Record<string, string>;
  if (contentType.includes("application/json")) {
    data = await request.json() as Record<string, string>;
  } else {
    data = {};
    (await request.formData()).forEach((value, key) => { data[key] = String(value); });
  }
  const appUuid = String(data.app_uuid || "").trim();
  const appDomain = String(data.app_domain || "").trim() || null;
  const ownerTeam = String(data.owner_team || "").trim();
  const costCenter = String(data.cost_center || "").trim() || null;
  const reason = String(data.reason || "manual viewer override").trim();
  const period = String(data.period || monthFromDate()).trim();
  if (!appUuid || !ownerTeam || !validateOwnerTeam(ownerTeam)) return json({ error: "app_uuid and a valid owner_team are required" }, { status: 400 });
  const updatedAt = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO app_owner_override (app_uuid, owner_team, cost_center, reason, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(app_uuid) DO UPDATE SET owner_team = excluded.owner_team, cost_center = excluded.cost_center, reason = excluded.reason, updated_by = excluded.updated_by, updated_at = excluded.updated_at").bind(appUuid, ownerTeam, costCenter, reason, identity.email || "unknown", updatedAt),
    env.DB.prepare("INSERT INTO app_owner_snapshot (period, app_uuid, app_domain, owner_team, cost_center, source, captured_at) VALUES (?, ?, ?, ?, ?, 'manual_override', ?) ON CONFLICT(period, app_uuid) DO UPDATE SET app_domain = COALESCE(excluded.app_domain, app_owner_snapshot.app_domain), owner_team = excluded.owner_team, cost_center = excluded.cost_center, source = 'manual_override', captured_at = excluded.captured_at").bind(period, appUuid, appDomain, ownerTeam, costCenter, updatedAt),
  ]);
  const wantsJson = request.headers.get("accept")?.includes("application/json") || contentType.includes("application/json");
  if (wantsJson) return json({ ok: true, app_uuid: appUuid, owner_team: ownerTeam, period });
  return Response.redirect(new URL(`/?period=${encodeURIComponent(period)}`, request.url), 303);
}
function toCsv(rows: Record<string, unknown>[]): string { if (!rows.length) return ""; const columns = Object.keys(rows[0]); const quote = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`; return [columns.join(","), ...rows.map((row) => columns.map((column) => quote(row[column])).join(","))].join("\n"); }

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const admin = await requireAdmin(request, env, ctx);
    if (admin instanceof Response) return admin;
    const period = await resolvePeriod(env, url.searchParams.get("period"));
    if (url.pathname === "/api/health") return json({ ok: true, now: nowIso(), viewer: admin.email });
    if (url.pathname === "/api/runs") return json((await env.DB.prepare("SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT 50").all()).results ?? []);
    if (url.pathname === "/api/app-owners") return json((await env.DB.prepare("SELECT * FROM app_owner_override ORDER BY updated_at DESC").all()).results ?? []);
    if (url.pathname === "/api/app-owner" && request.method === "POST") return upsertOwnerOverride(request, env, admin);
    if (url.pathname === "/api/ingest" && request.method === "POST") return json({ workflowId: await triggerWorkflow(env, (await request.json().catch(() => ({}))) as IngestParams) });
    if (url.pathname === "/api/allocation") return json(await allocationRows(env, period));
    if (url.pathname === "/api/allocation.csv") return csv(toCsv((await allocationRows(env, period)) as Record<string, unknown>[]), `allocation-${period}.csv`);
    if (url.pathname === "/api/relationships.csv") {
      const rows = (await env.DB.prepare("SELECT u.period, u.user_uid, users.email, u.app_uuid, u.app_domain, COALESCE(a.owner_team, 'unassigned') AS owner_team, u.first_seen_at, u.last_seen_at, u.login_count FROM usage u LEFT JOIN users ON users.user_uid = u.user_uid LEFT JOIN app_owner_snapshot a ON a.period = u.period AND a.app_uuid = u.app_uuid WHERE u.period = ? ORDER BY owner_team, u.app_domain, users.email").bind(period).all()).results ?? [];
      return csv(toCsv(rows as Record<string, unknown>[]), `relationships-${period}.csv`);
    }
    return renderHome(env, period, admin);
  },
};
