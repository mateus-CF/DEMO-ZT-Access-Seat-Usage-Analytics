export type AccessLogRecord = {
  Action?: string;
  Allowed?: boolean | string;
  AppDomain?: string;
  AppUUID?: string;
  CreatedAt?: string | number;
  Email?: string;
  RayID?: string;
  UserUID?: string;
  [key: string]: unknown;
};

export type NormalizedAccessEvent = {
  rayId: string;
  period: string;
  userUid: string;
  email: string | null;
  appUuid: string;
  appDomain: string | null;
  createdAt: string;
};

export function parseCsv(value: string | undefined): string[] {
  return (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

export function getLookbackDates(now = new Date(), lookbackDays = 3): string[] {
  const result: string[] = [];
  for (let offset = lookbackDays; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset));
    result.push(date.toISOString().slice(0, 10).replaceAll('-', '')); // Logpush {DATE} folders use YYYYMMDD
  }
  return result;
}

export function datePrefixes(prefix: string, dates: string[]): string[] {
  const normalizedPrefix = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
  return dates.map((date) => `${normalizedPrefix}${date}/`);
}

export function parseCreatedAt(value: string | number | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizeAccessRecord(record: AccessLogRecord): NormalizedAccessEvent | null {
  const allowed = record.Allowed === true || record.Allowed === "true";
  if (!allowed) return null;
  if ((record.Action ?? "").toLowerCase() !== "login") return null;
  if (!record.UserUID || !record.AppUUID) return null;
  const createdAt = parseCreatedAt(record.CreatedAt);
  if (!createdAt) return null;
  const fallbackRay = `${record.UserUID}:${record.AppUUID}:${createdAt}`;
  return {
    rayId: String(record.RayID || fallbackRay),
    period: createdAt.slice(0, 7),
    userUid: String(record.UserUID),
    email: record.Email ? String(record.Email).toLowerCase() : null,
    appUuid: String(record.AppUUID),
    appDomain: record.AppDomain ? String(record.AppDomain) : null,
    createdAt,
  };
}

export function parseNdjson(text: string): AccessLogRecord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  }
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

export function normalizeLogText(text: string): NormalizedAccessEvent[] {
  return parseNdjson(text)
    .map((record) => normalizeAccessRecord(record))
    .filter((event): event is NormalizedAccessEvent => event !== null);
}

export function buildAllocationQuery(period: string): { sql: string; params: string[] } {
  return {
    sql: `WITH user_team AS (
  SELECT DISTINCT u.period, u.user_uid, COALESCE(a.owner_team, 'unassigned') AS owner_team
  FROM usage u
  LEFT JOIN app_owner_snapshot a ON a.period = u.period AND a.app_uuid = u.app_uuid
  WHERE u.period = ?
), team_counts AS (
  SELECT period, user_uid, COUNT(*) AS team_count FROM user_team GROUP BY period, user_uid
)
SELECT ut.period, ut.owner_team,
  SUM(1.0 / tc.team_count) AS allocated_seat_equivalents,
  COUNT(DISTINCT ut.user_uid) AS distinct_users
FROM user_team ut
JOIN team_counts tc ON tc.period = ut.period AND tc.user_uid = ut.user_uid
GROUP BY ut.period, ut.owner_team
ORDER BY allocated_seat_equivalents DESC`,
    params: [period],
  };
}

export function monthFromDate(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}
