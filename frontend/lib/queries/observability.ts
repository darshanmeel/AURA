import { promises as fs } from 'node:fs'
import path from 'node:path'
import { query, queryOne } from '../db'

const ARTIFACTS_DIR = process.env.AURA_ARTIFACTS_DIR ?? `${process.env.AURA_DATA_DIR ?? '/data'}/artifacts`
const RUN_RESULTS_PATH = `${ARTIFACTS_DIR}/run_results.json`
const SOURCES_PATH = `${ARTIFACTS_DIR}/sources.json`
const HISTORY_DIR = `${ARTIFACTS_DIR}/history`
const NUMBER_VERIFY_PATH = `${ARTIFACTS_DIR}/number_verify.json`
const WATCHER_STATUS_PATH = `${ARTIFACTS_DIR}/watcher_status.json`

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type HealthLevel = 'green' | 'yellow' | 'red' | 'unknown'

// ---------------------------------------------------------------------------
// Overall health
// ---------------------------------------------------------------------------

export interface OverallHealth {
  bronze_latest_event: string | null   // ISO timestamp
  bronze_age_seconds: number | null
  bronze_status: HealthLevel
  last_dbt_run_ts: string | null       // from run_results.json metadata.generated_at
  last_dbt_run_status: 'success' | 'failure' | 'unknown'
  dbt_status: HealthLevel
  errors_last_hour: number
  errors_last_day: number
  overall_status: HealthLevel
}

function bronzeStatus(ageSeconds: number | null): HealthLevel {
  if (ageSeconds === null) return 'unknown'
  if (ageSeconds < 300) return 'green'      // < 5 min
  if (ageSeconds < 1800) return 'yellow'    // 5–30 min
  return 'red'                              // > 30 min
}

function dbtStatusFromAge(lastRunTs: string | null, runStatus: 'success' | 'failure' | 'unknown', fileFound: boolean): HealthLevel {
  if (!fileFound) return 'red'
  if (lastRunTs === null) return 'unknown'
  const ageSeconds = (Date.now() - new Date(lastRunTs).getTime()) / 1000
  if (ageSeconds > 3600) return 'red'                                   // > 60 min
  if (runStatus === 'failure') return 'yellow'
  if (ageSeconds > 600) return 'yellow'                                 // 10–60 min
  return 'green'                                                        // < 10 min + success
}

function errorBasedHealth(errorsLastHour: number): HealthLevel {
  if (errorsLastHour > 10) return 'red'
  if (errorsLastHour > 0) return 'yellow'
  return 'green'
}

function worstOf(...levels: HealthLevel[]): HealthLevel {
  // unknown outranks green: a missing signal must not read as healthy (S37).
  const rank: Record<HealthLevel, number> = { green: 0, unknown: 1, yellow: 2, red: 3 }
  return levels.reduce((worst, l) => rank[l] > rank[worst] ? l : worst, 'green' as HealthLevel)
}

// watcher_status.json (spec §2.5): written by the watcher after every flush.
// The lake is not in the read DB, so bronze freshness and file/byte totals
// come from this file, never from a query.
export interface WatcherStatus {
  written_at?: string
  mode?: string
  last_flush_at?: string | null
  max_event_ts?: string | null
  files_tracked?: number
  bytes_tracked?: number
  errors_since_start?: number
  dbt?: { status?: string; published?: string | null; error?: string | null } | null
}

export async function readWatcherStatus(): Promise<WatcherStatus | null> {
  try {
    return JSON.parse(await fs.readFile(WATCHER_STATUS_PATH, 'utf8')) as WatcherStatus
  } catch (_e) {
    return null
  }
}

// The watcher writes naive UTC timestamps; without a zone suffix JS would
// parse them as local time.
function utcMs(ts: string | null | undefined): number | null {
  if (!ts) return null
  const iso = ts.replace(' ', 'T')
  const ms = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`)
  return Number.isNaN(ms) ? null : ms
}

export async function getOverallHealth(status: WatcherStatus | null = null): Promise<OverallHealth> {
  // 1. Bronze freshness from watcher_status.json
  const bronzeLatestEvent = status?.max_event_ts ?? null
  const latestMs = utcMs(bronzeLatestEvent)
  const bronzeAgeSeconds = latestMs === null ? null : (Date.now() - latestMs) / 1000

  // 2. dbt artifact
  let lastDbtRunTs: string | null = null
  let lastDbtRunStatus: 'success' | 'failure' | 'unknown' = 'unknown'
  let dbtFileFound = false

  try {
    const raw = await fs.readFile(RUN_RESULTS_PATH, 'utf8')
    const json = JSON.parse(raw) as {
      metadata?: { generated_at?: string }
      elapsed_time?: number
      results?: Array<{ unique_id: string; status: string }>
    }
    dbtFileFound = true
    lastDbtRunTs = json.metadata?.generated_at ?? null
    const modelResults = (json.results ?? []).filter(r => r.unique_id.startsWith('model.'))
    const anyFail = modelResults.some(r => r.status !== 'success' && r.status !== 'skipped')
    lastDbtRunStatus = anyFail ? 'failure' : 'success'
  } catch (_e) {
    // file absent or unparseable — leave dbtFileFound = false
  }

  // 3. Watcher errors (as of the last publish)
  let errorsLastHour = 0
  let errorsLastDay = 0

  try {
    const row = await queryOne<{ last_hour: number; last_day: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL 1 HOUR)  AS last_hour,
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL 1 DAY)   AS last_day
       FROM stg_watcher_errors`
    )
    errorsLastHour = Number(row?.last_hour ?? 0)
    errorsLastDay = Number(row?.last_day ?? 0)
  } catch (e) {
    console.error('[observability] watcher error counts failed:', e instanceof Error ? e.message : e)
  }

  const bs = bronzeStatus(bronzeAgeSeconds)
  const ds = dbtStatusFromAge(lastDbtRunTs, lastDbtRunStatus, dbtFileFound)
  const es = errorBasedHealth(errorsLastHour)
  const overall = worstOf(bs, ds, es)

  return {
    bronze_latest_event: bronzeLatestEvent,
    bronze_age_seconds: bronzeAgeSeconds,
    bronze_status: bs,
    last_dbt_run_ts: lastDbtRunTs,
    last_dbt_run_status: lastDbtRunStatus,
    dbt_status: ds,
    errors_last_hour: errorsLastHour,
    errors_last_day: errorsLastDay,
    overall_status: overall,
  }
}

// ---------------------------------------------------------------------------
// Ingestion stats
// ---------------------------------------------------------------------------

export interface IngestionStats {
  window: '1h' | '1d' | '7d'
  rows_ingested: number
  sessions_ingested: number
  files_seen: number
}

// recent_events holds the last 8 UTC days; the "date" predicate prunes by
// zone map before the ts bound is applied.
export async function getIngestionStatsAll(status: WatcherStatus | null = null): Promise<{
  s1h: IngestionStats
  s1d: IngestionStats
  s7d: IngestionStats
}> {
  let c1h = 0, s1h = 0, c1d = 0, s1d = 0, c7d = 0, s7d = 0
  const filesSeen = Number(status?.files_tracked ?? 0)

  try {
    const row = await queryOne<{
      c1h: number; s1h: number
      c1d: number; s1d: number
      c7d: number; s7d: number
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL 1 HOUR)                  AS c1h,
         COUNT(DISTINCT session_id) FILTER (WHERE ts >= NOW() - INTERVAL 1 HOUR) AS s1h,
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL 1 DAY)                   AS c1d,
         COUNT(DISTINCT session_id) FILTER (WHERE ts >= NOW() - INTERVAL 1 DAY)  AS s1d,
         COUNT(*)                                                               AS c7d,
         COUNT(DISTINCT session_id)                                             AS s7d
       FROM recent_events
       WHERE "date" >= current_date - 7 AND ts >= NOW() - INTERVAL 7 DAY`
    )
    c1h = Number(row?.c1h ?? 0); s1h = Number(row?.s1h ?? 0)
    c1d = Number(row?.c1d ?? 0); s1d = Number(row?.s1d ?? 0)
    c7d = Number(row?.c7d ?? 0); s7d = Number(row?.s7d ?? 0)
  } catch (e) {
    console.error('[observability] ingestion counts failed:', e instanceof Error ? e.message : e)
  }

  return {
    s1h: { window: '1h', rows_ingested: c1h, sessions_ingested: s1h, files_seen: filesSeen },
    s1d: { window: '1d', rows_ingested: c1d, sessions_ingested: s1d, files_seen: filesSeen },
    s7d: { window: '7d', rows_ingested: c7d, sessions_ingested: s7d, files_seen: filesSeen },
  }
}

// ---------------------------------------------------------------------------
// Watcher health
// ---------------------------------------------------------------------------

export interface WatcherHealth {
  bronze_latest_event: string | null
  bronze_age_seconds: number | null
  bronze_status: HealthLevel
  files_total: number
  total_bytes_ingested: number
  ingestion_1h: number
  ingestion_1d: number
  ingestion_7d: number
  errors_last_hour: number
  errors_last_day: number
}

// No queries: built from the status file and the counts the snapshot already has.
export function getWatcherHealth(
  status: WatcherStatus | null,
  overall: OverallHealth | null,
  ingestion: { s1h: IngestionStats; s1d: IngestionStats; s7d: IngestionStats } | null,
): WatcherHealth {
  return {
    bronze_latest_event: overall?.bronze_latest_event ?? null,
    bronze_age_seconds: overall?.bronze_age_seconds ?? null,
    bronze_status: overall?.bronze_status ?? 'unknown',
    files_total: Number(status?.files_tracked ?? 0),
    total_bytes_ingested: Number(status?.bytes_tracked ?? 0),
    ingestion_1h: ingestion?.s1h.rows_ingested ?? 0,
    ingestion_1d: ingestion?.s1d.rows_ingested ?? 0,
    ingestion_7d: ingestion?.s7d.rows_ingested ?? 0,
    errors_last_hour: overall?.errors_last_hour ?? 0,
    errors_last_day: overall?.errors_last_day ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Watcher errors
// ---------------------------------------------------------------------------

export interface WatcherError {
  ts: string
  source: string
  file_path: string | null
  error_message: string
  stack_trace: string
}

export async function getRecentWatcherErrors(limit?: number): Promise<WatcherError[]> {
  // F-M3: bound and sanitise the caller-supplied limit before inlining into SQL.
  const safeLimit = Math.min(500, Math.max(1, Math.floor(Number(limit ?? 50))))
  try {
    return await query<WatcherError>(
      `SELECT
         ts::VARCHAR          AS ts,
         source,
         file_path,
         error_message,
         stack_trace
       FROM stg_watcher_errors
       ORDER BY ts DESC
       LIMIT ${safeLimit}`
    )
  } catch (e) {
    console.error('[observability] watcher errors failed:', e instanceof Error ? e.message : e)
    return []
  }
}

// ---------------------------------------------------------------------------
// dbt health
// ---------------------------------------------------------------------------

export interface DbtModelResult {
  model: string
  unique_id: string
  status: string
  execution_time: number | null
  message: string | null
  materialization: string | null
}

export interface DbtSourceFreshness {
  source: string
  table: string
  status: string
  max_loaded_at: string | null
  snapshotted_at: string | null
  age_seconds: number | null
}

export interface DbtTestResult {
  // Display-friendly test identifier built from the generic name + arguments,
  // e.g. "not_null · fact_model_calls · event_uuid".
  name: string
  unique_id: string
  status: string                         // pass / fail / warn / error / skipped
  execution_time_ms: number | null
  kind: string                           // not_null | unique | accepted_values | range | custom
  relation: string                       // e.g. "fact_model_calls"
}

export interface DbtHealth {
  last_run_ts: string | null
  last_run_status: 'success' | 'failure' | 'unknown'
  last_run_duration_s: number | null
  models_total: number
  models_pass: number
  models_fail: number
  per_model: DbtModelResult[]
  source_freshness: DbtSourceFreshness[]
  tests_total: number
  tests_pass: number
  tests_fail: number
  per_test: DbtTestResult[]
}

interface RunResultsJson {
  metadata?: { generated_at?: string; dbt_version?: string }
  elapsed_time?: number
  results?: Array<{
    unique_id: string
    status: string
    execution_time?: number
    message?: string
  }>
}

interface SourcesJson {
  results?: Array<{
    unique_id: string
    status: string
    max_loaded_at?: string | null
    snapshotted_at?: string | null
    max_loaded_at_time_ago_in_s?: number | null
  }>
}

// Known relation names. We use longest-match-wins to split a dbt test
// unique_id correctly even when the table name itself has underscores
// (e.g. fact_hourly_activity). Kept in sync with LAYER_TABLES below.
const KNOWN_RELATIONS: readonly string[] = [
  // gold (longer names first where one is a prefix of another)
  'fact_hourly_activity',
  'fact_model_calls',
  'fact_tool_executions',
  'fact_session_files',
  'fact_git_commands',
  'fact_daily_spend',
  'fact_spend_pace',
  'fact_prompts',
  'fact_turns',
  'fact_errors',
  'dim_turn_messages',
  'dim_sessions',
  'dim_projects',
  'dim_agents',
  'dim_people',
  'dim_apps',
  'int_app_cwd_lookup',
  'int_entity_spend',
  'int_event_agent',
  // silver
  'stg_assistant_messages',
  'stg_lake_event_dups',
  'stg_session_verdicts',
  'stg_session_skills',
  'stg_session_mcps',
  'stg_session_meta',
  'stg_thinking_blocks',
  'stg_tool_results',
  'stg_tool_calls',
  'stg_watcher_errors',
  'stg_events',
  // bronze (lake)
  'raw_session_skills',
  'raw_session_mcps',
  'raw_events',
  'session_meta',
  'watcher_errors',
]

// Parses a dbt test unique_id like
//   `test.aura.not_null_fact_model_calls_event_uuid.7c2c1ef38a`
//   `test.aura.unique_dim_sessions_session_id.6b8e2d3105`
//   `test.aura.accepted_values_fact_hourly_activity_day_of_week__0__1__2__3__4__5__6.b38095fa39`
//   `test.aura.fact_prompts_cache_hit_rate_in_range.123abc`  (custom singular test)
// into a friendly { name, kind, relation }. Generic tests follow the
// `<kind>_<relation>_<column>` convention; values appended after the column
// (accepted_values) are separated by `__`.
function parseDbtTestName(uniqueId: string): { name: string; kind: string; relation: string } {
  // Generic tests carry an 8–12 char hex hash as their final segment;
  // singular tests don't. Strip the hash when present, then peel off the
  // `__<args>` suffix that accepted_values / range tests add.
  const parts = uniqueId.split('.')
  const tail = parts[parts.length - 1] ?? ''
  const hasHash = /^[0-9a-f]{8,12}$/i.test(tail)
  const body = hasHash ? (parts[parts.length - 2] ?? uniqueId) : tail
  const raw = body.split('__')[0]
  const KNOWN_KINDS = ['not_null', 'unique', 'accepted_values', 'relationships', 'range', 'expression_is_true']

  for (const k of KNOWN_KINDS) {
    if (raw.startsWith(k + '_')) {
      const rest = raw.slice(k.length + 1)
      // Longest-match against the known-relation table avoids splitting
      // multi-word tables (fact_model_calls) at the wrong underscore.
      const relation = KNOWN_RELATIONS.find(rel => rest === rel || rest.startsWith(rel + '_'))
      if (relation) {
        const column = rest.length > relation.length ? rest.slice(relation.length + 1) : ''
        return {
          name: column ? `${k} · ${relation} · ${column}` : `${k} · ${relation}`,
          kind: k,
          relation,
        }
      }
      // Unknown relation — fall back to first underscore.
      const ix = rest.indexOf('_')
      const fbRelation = ix >= 0 ? rest.slice(0, ix) : rest
      const fbColumn = ix >= 0 ? rest.slice(ix + 1) : ''
      return {
        name: fbColumn ? `${k} · ${fbRelation} · ${fbColumn}` : `${k} · ${fbRelation}`,
        kind: k,
        relation: fbRelation,
      }
    }
  }
  // Singular / custom tests — best-effort: look for a known relation anywhere
  // in the prefix; otherwise leave the whole thing as the relation.
  const matched = KNOWN_RELATIONS.find(rel => raw.startsWith(rel + '_'))
  if (matched) {
    return { name: raw, kind: 'custom', relation: matched }
  }
  return { name: raw, kind: 'custom', relation: raw }
}

export async function getDbtHealth(): Promise<DbtHealth> {
  let lastRunTs: string | null = null
  let lastRunDurationS: number | null = null
  let perModel: DbtModelResult[] = []
  let perTest: DbtTestResult[] = []
  let modelsTotal = 0
  let modelsPass = 0
  let testsTotal = 0
  let testsPass = 0
  let sourcesFreshness: DbtSourceFreshness[] = []

  // Read run_results.json
  try {
    const raw = await fs.readFile(RUN_RESULTS_PATH, 'utf8')
    const json = JSON.parse(raw) as RunResultsJson
    lastRunTs = json.metadata?.generated_at ?? null
    lastRunDurationS = json.elapsed_time ?? null

    const results = json.results ?? []
    const modelResults = results.filter(r => r.unique_id.startsWith('model.'))
    const testResults = results.filter(r => r.unique_id.startsWith('test.'))
    modelsTotal = modelResults.length
    testsTotal = testResults.length

    perModel = modelResults.map(r => {
      const parts = r.unique_id.split('.')
      const model = parts[parts.length - 1]
      return {
        model,
        unique_id: r.unique_id,
        status: r.status,
        execution_time: r.execution_time ?? null,
        message: r.message ?? null,
        materialization: null,
      }
    })

    perTest = testResults.map(r => {
      const { name, kind, relation } = parseDbtTestName(r.unique_id)
      return {
        name,
        unique_id: r.unique_id,
        status: r.status,
        execution_time_ms: r.execution_time != null ? Math.round(r.execution_time * 1000) : null,
        kind,
        relation,
      }
    })

    modelsPass = perModel.filter(m => m.status === 'success').length
    testsPass = perTest.filter(t => t.status === 'pass').length
  } catch (_e) {
    // file absent or unparseable — return defaults below
  }

  const modelsFail = modelsTotal - modelsPass
  const testsFail = testsTotal - testsPass
  // Last-run status reflects both: a failing test counts as failure too.
  const lastRunStatus: 'success' | 'failure' | 'unknown' =
    modelsTotal === 0 && testsTotal === 0 ? 'unknown'
      : modelsFail === 0 && testsFail === 0 ? 'success'
      : 'failure'

  // Read sources.json
  try {
    const raw = await fs.readFile(SOURCES_PATH, 'utf8')
    const json = JSON.parse(raw) as SourcesJson

    sourcesFreshness = (json.results ?? []).map(r => {
      const parts = r.unique_id.split('.')
      // unique_id like 'source.aura.aura.raw_events' — take last two parts
      const table = parts[parts.length - 1]
      const source = parts[parts.length - 2]
      return {
        source,
        table,
        status: r.status,
        max_loaded_at: r.max_loaded_at ?? null,
        snapshotted_at: r.snapshotted_at ?? null,
        age_seconds: r.max_loaded_at_time_ago_in_s ?? null,
      }
    })
  } catch (_e) {
    // file absent or unparseable
  }

  return {
    last_run_ts: lastRunTs,
    last_run_status: lastRunStatus,
    last_run_duration_s: lastRunDurationS,
    models_total: modelsTotal,
    models_pass: modelsPass,
    models_fail: modelsFail,
    per_model: perModel,
    source_freshness: sourcesFreshness,
    tests_total: testsTotal,
    tests_pass: testsPass,
    tests_fail: testsFail,
    per_test: perTest,
  }
}

// ---------------------------------------------------------------------------
// Raw dbt artifacts (for advanced debugging)
// ---------------------------------------------------------------------------

export interface DbtArtifacts {
  run_results: unknown | null
  sources: unknown | null
  last_modified: string | null   // mtime of run_results.json
}

export async function getDbtArtifacts(): Promise<DbtArtifacts> {
  let runResults: unknown | null = null
  let sources: unknown | null = null
  let lastModified: string | null = null

  try {
    const [raw, stat] = await Promise.all([
      fs.readFile(RUN_RESULTS_PATH, 'utf8'),
      fs.stat(RUN_RESULTS_PATH),
    ])
    runResults = JSON.parse(raw)
    lastModified = stat.mtime.toISOString()
  } catch (_e) {
    // file absent or unparseable
  }

  try {
    const raw = await fs.readFile(SOURCES_PATH, 'utf8')
    sources = JSON.parse(raw)
  } catch (_e) {
    // file absent or unparseable
  }

  return { run_results: runResults, sources, last_modified: lastModified }
}

// ---------------------------------------------------------------------------
// Ingest coverage — the watcher writes ingest_coverage/latest.json with a
// per-file breakdown of what has been fully ingested vs what remains. We only
// read the latest snapshot here; the page refreshes every 10s via polling so
// dated files are not needed.
// ---------------------------------------------------------------------------

export interface IngestCoverageFile {
  path: string
  size: number
  offset: number
  status: 'partial' | 'unprocessed'
  bytes_remaining: number
  last_seen_at: string | null
  lines_total: number | null
  events_kept: number | null
  dropped_known: number | null
  dropped_unknown: number | null
  parse_errors: number | null
  last_error: string | null
}

export interface IngestCoverage {
  generated_at: string
  scan_dirs: string[]
  summary: {
    files_total: number
    files_full: number
    files_partial: number
    files_unprocessed: number
    bytes_total: number
    bytes_ingested: number
    bytes_remaining: number
    events_kept: number
    lines_dropped_known: number
    lines_dropped_unknown: number
    parse_errors: number
  }
  files: IngestCoverageFile[]
}

const INGEST_COVERAGE_PATH = `${ARTIFACTS_DIR}/ingest_coverage/latest.json`

export async function getIngestCoverage(): Promise<IngestCoverage | null> {
  try {
    const raw = await fs.readFile(INGEST_COVERAGE_PATH, 'utf8')
    return JSON.parse(raw) as IngestCoverage
  } catch (_e) {
    // file absent or unparseable
    return null
  }
}

// ---------------------------------------------------------------------------
// Number integrity — the watcher's verify runner writes number_verify.json,
// reconciling the dashboard's displayed numbers against their source-of-truth
// marts (the "number map executable" check). We only surface the summary plus
// the failing checks; the passing ones are not interesting on the page.
// ---------------------------------------------------------------------------

export interface NumberIntegrity {
  generated_at: string
  total: number
  pass: number
  fail: number
  failing: { check: string; page: string; expected_source: string; actual: string }[]
}

interface NumberVerifyCheck {
  check: string
  page: string
  expected_source: string
  actual: string
  pass: boolean
}

interface NumberVerifyFile {
  generated_at: string
  total: number
  pass: number
  fail: number
  checks: NumberVerifyCheck[]
}

export async function getNumberIntegrity(): Promise<NumberIntegrity | null> {
  try {
    const raw = await fs.readFile(NUMBER_VERIFY_PATH, 'utf8')
    const data = JSON.parse(raw) as NumberVerifyFile
    const checks = Array.isArray(data.checks) ? data.checks : []
    return {
      generated_at: data.generated_at,
      total: data.total,
      pass: data.pass,
      fail: data.fail,
      failing: checks
        .filter((c) => !c.pass)
        .map(({ check, page, expected_source, actual }) => ({ check, page, expected_source, actual })),
    }
  } catch (_e) {
    // file absent or unparseable
    return null
  }
}

// ---------------------------------------------------------------------------
// Hourly ingestion buckets (sparkline data)
// ---------------------------------------------------------------------------

export interface HourlyIngestion {
  hour: string        // ISO timestamp of the bucket (truncated to the hour)
  rows: number
}

export async function getHourlyIngestion(hours: number = 24): Promise<HourlyIngestion[]> {
  // F-H4: coerce to a safe integer before inlining into SQL INTERVAL / generate_series.
  // recent_events holds 8 days, so more than 168 hours would read as zeros.
  const safeHours = Math.min(168, Math.max(1, Math.floor(Number(hours)) || 24))

  // We pre-build all N buckets and LEFT JOIN so quiet hours show up as zero
  // instead of dropping out — the sparkline needs a complete time axis.
  //
  // F-L9: generate_series(int, int) is supported in DuckDB ≥ 0.8. On older
  // builds this query will throw; the outer catch returns [] silently. Bump
  // the DuckDB package if sparklines are empty on a fresh install.
  try {
    return await query<HourlyIngestion>(
      `WITH bucket_axis AS (
         SELECT
           date_trunc('hour', NOW()) - (INTERVAL 1 HOUR * (h.i))   AS hour
         FROM generate_series(0, ${safeHours - 1}) AS h(i)
       ),
       counts AS (
         SELECT
           date_trunc('hour', ts) AS hour,
           COUNT(*)               AS rows
         FROM recent_events
         WHERE "date" >= current_date - 7 AND ts >= NOW() - INTERVAL ${safeHours} HOUR
         GROUP BY 1
       )
       SELECT
         a.hour::VARCHAR  AS hour,
         COALESCE(c.rows, 0)::BIGINT AS rows
       FROM bucket_axis a
       LEFT JOIN counts c USING (hour)
       ORDER BY a.hour`
    )
  } catch (e) {
    console.error('[observability] hourly ingestion failed:', e instanceof Error ? e.message : e)
    return []
  }
}

// ---------------------------------------------------------------------------
// dbt run history — reads archived run_results from {ARTIFACTS_DIR}/history/
// ---------------------------------------------------------------------------

export interface DbtHistoryEntry {
  started_at: string           // metadata.invocation_started_at
  generated_at: string         // metadata.generated_at
  command: string              // e.g. "dbt test" / "dbt run"
  outcome: 'pass' | 'fail' | 'unknown'
  duration_ms: number
  models_total: number
  tests_total: number
  invocation_id: string | null
}

interface ArchivedRunResults {
  metadata?: {
    generated_at?: string
    invocation_started_at?: string
    invocation_id?: string
  }
  args?: { which?: string; command?: string }
  elapsed_time?: number
  results?: Array<{ unique_id: string; status: string }>
}

export async function getDbtRunHistory(limit: number = 6): Promise<DbtHistoryEntry[]> {
  let files: string[] = []
  try {
    files = await fs.readdir(HISTORY_DIR)
  } catch (_e) {
    return []
  }
  const jsonFiles = files.filter(f => f.endsWith('.json')).sort().reverse().slice(0, limit)

  const entries: DbtHistoryEntry[] = []
  for (const fname of jsonFiles) {
    const fullPath = path.join(HISTORY_DIR, fname)
    try {
      const raw = await fs.readFile(fullPath, 'utf8')
      const json = JSON.parse(raw) as ArchivedRunResults
      const results = json.results ?? []
      const models = results.filter(r => r.unique_id.startsWith('model.'))
      const tests = results.filter(r => r.unique_id.startsWith('test.'))
      const allOk = results.every(r => r.status === 'success' || r.status === 'pass' || r.status === 'skipped')
      const which = json.args?.which ?? json.args?.command ?? ''
      entries.push({
        started_at: json.metadata?.invocation_started_at ?? json.metadata?.generated_at ?? '',
        generated_at: json.metadata?.generated_at ?? '',
        command: which ? `dbt ${which}` : 'dbt',
        outcome: results.length === 0 ? 'unknown' : allOk ? 'pass' : 'fail',
        duration_ms: Math.round((json.elapsed_time ?? 0) * 1000),
        models_total: models.length,
        tests_total: tests.length,
        invocation_id: json.metadata?.invocation_id ?? null,
      })
    } catch (_e) {
      // skip unparseable history files
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// Medallion layers — per-layer + per-table breakdown
// ---------------------------------------------------------------------------

export interface MedallionTable {
  name: string
  rows: number | null               // null when not in the read DB (bronze, silver)
  bytes: number | null              // approximate, from duckdb_tables() (null = unknown / view)
  age_seconds: number | null        // freshness signal; null for static dims and uncounted views
  materialization: string           // lake | table | view | incremental
}

export interface MedallionLayer {
  layer: 'bronze' | 'silver' | 'gold'
  role: string
  materialization: string
  status: HealthLevel
  tables: MedallionTable[]
  total_rows: number
  total_bytes: number | null
  age_seconds: number | null        // youngest table age (most-recent data)
  tests_pass: number
  tests_total: number
}

// Static layer membership — keeps the page deterministic. We don't auto-derive
// from manifest.json because that requires another file read and the set is
// stable. Only gold is probed: bronze is the Parquet lake (age from
// watcher_status.json) and silver lives only in the dbt work DB; neither is
// in the read DB, so their rows/ages show '—' and only their test results count.
const LAYER_TABLES: Record<'bronze' | 'silver' | 'gold', { table: string; materialization: string; ts_column: string | null }[]> = {
  bronze: [
    { table: 'raw_events',         materialization: 'lake', ts_column: null },
    { table: 'raw_session_skills', materialization: 'lake', ts_column: null },
    { table: 'raw_session_mcps',   materialization: 'lake', ts_column: null },
    { table: 'session_meta',       materialization: 'lake', ts_column: null },
    { table: 'watcher_errors',     materialization: 'lake', ts_column: null },
  ],
  silver: [
    { table: 'stg_events',              materialization: 'view',        ts_column: null },
    { table: 'stg_lake_event_dups',     materialization: 'table',       ts_column: null },
    { table: 'stg_assistant_messages',  materialization: 'view',        ts_column: null },
    { table: 'stg_tool_calls',          materialization: 'table',       ts_column: null },
    { table: 'stg_tool_results',        materialization: 'incremental', ts_column: null },
    { table: 'stg_thinking_blocks',     materialization: 'view',        ts_column: null },
    { table: 'stg_session_meta',        materialization: 'table',       ts_column: null },
    { table: 'stg_session_skills',      materialization: 'table',       ts_column: null },
    { table: 'stg_session_mcps',        materialization: 'table',       ts_column: null },
    { table: 'stg_session_verdicts',    materialization: 'table',       ts_column: null },
    { table: 'stg_watcher_errors',      materialization: 'table',       ts_column: null },
  ],
  gold: [
    { table: 'dim_agents',           materialization: 'table',       ts_column: null },
    { table: 'dim_apps',             materialization: 'table',       ts_column: null },
    { table: 'dim_people',           materialization: 'table',       ts_column: null },
    { table: 'dim_projects',         materialization: 'table',       ts_column: null },
    { table: 'dim_sessions',         materialization: 'table',       ts_column: 'start_ts' },
    { table: 'dim_turn_messages',    materialization: 'incremental', ts_column: null },
    { table: 'int_app_cwd_lookup',   materialization: 'table',       ts_column: null },
    { table: 'int_entity_spend',     materialization: 'table',       ts_column: null },
    { table: 'int_event_agent',      materialization: 'table',       ts_column: null },
    { table: 'fact_hourly_activity', materialization: 'table',       ts_column: null },
    { table: 'fact_model_calls',     materialization: 'table',       ts_column: 'ts' },
    { table: 'fact_prompts',         materialization: 'incremental', ts_column: 'prompt_ts' },
    { table: 'fact_turns',           materialization: 'table',       ts_column: 'assistant_ts' },
    { table: 'fact_tool_executions', materialization: 'incremental', ts_column: 'tool_call_ts' },
    { table: 'fact_spend_pace',      materialization: 'table',       ts_column: null },
    { table: 'fact_daily_spend',     materialization: 'table',       ts_column: null },
    { table: 'fact_errors',          materialization: 'table',       ts_column: 'ts' },
    { table: 'fact_session_files',   materialization: 'table',       ts_column: null },
    { table: 'fact_git_commands',    materialization: 'table',       ts_column: 'ts' },
  ],
}

export async function getMedallionLayers(
  perTestResults: DbtTestResult[] = [],
  // Canonical bronze age in seconds (watcher_status.json max_event_ts, via
  // getOverallHealth). Passed in so the medallion Bronze card, the "At a
  // glance" BRONZE card and the Flow strip's "02 BRONZE" stage agree.
  canonicalBronzeAgeSeconds: number | null = null
): Promise<MedallionLayer[]> {
  // Per-relation test pass/fail attribution.
  const testsByRelation = new Map<string, { pass: number; total: number }>()
  for (const t of perTestResults) {
    const entry = testsByRelation.get(t.relation) ?? { pass: 0, total: 0 }
    entry.total += 1
    if (t.status === 'pass') entry.pass += 1
    testsByRelation.set(t.relation, entry)
  }

  const allTables = [
    ...LAYER_TABLES.bronze.map(t => ({ layer: 'bronze' as const, ...t })),
    ...LAYER_TABLES.silver.map(t => ({ layer: 'silver' as const, ...t })),
    ...LAYER_TABLES.gold.map(t => ({ layer: 'gold' as const, ...t })),
  ]

  // Gold only (see LAYER_TABLES). duckdb_tables().estimated_size is the row
  // count of a base table (despite the name). MAX(ts) per table is cheap via
  // zone maps.
  const goldTables = LAYER_TABLES.gold.map(t => t.table)
  const tablesWithTs = LAYER_TABLES.gold.filter(t => t.ts_column !== null)

  let countsByTable = new Map<string, number>()
  const agesByTable = new Map<string, number | null>()
  try {
    const tablesMeta = await query<{ table_name: string; estimated_size: number | string | null }>(
      `SELECT table_name, estimated_size FROM duckdb_tables()`
    )
    countsByTable = new Map(
      tablesMeta
        .filter(r => goldTables.includes(r.table_name))
        .map(r => [r.table_name, Number(r.estimated_size ?? 0)])
    )
  } catch (e) {
    console.error('[observability] layer row counts failed:', e instanceof Error ? e.message : e)
  }
  try {
    // F-L3: table and column names come from LAYER_TABLES, a static constant
    // in this file. No user input reaches this SQL — do NOT make it dynamic.
    const ageRows = await query<{ table_name: string; age: number | null }>(
      tablesWithTs.map(t => `
        SELECT '${t.table}'::VARCHAR AS table_name,
               EXTRACT(EPOCH FROM (NOW() - MAX(${t.ts_column})))::DOUBLE AS age
        FROM ${t.table}
      `).join(' UNION ALL ')
    )
    for (const r of ageRows) agesByTable.set(r.table_name, r.age != null ? Number(r.age) : null)
  } catch (e) {
    console.error('[observability] layer ages failed:', e instanceof Error ? e.message : e)
  }
  agesByTable.set('raw_events', canonicalBronzeAgeSeconds)

  const probeRows: Map<string, { rows: number | null; age: number | null }> = new Map()
  for (const t of allTables) {
    probeRows.set(t.table, {
      rows: countsByTable.has(t.table) ? countsByTable.get(t.table) ?? null : null,
      age: agesByTable.get(t.table) ?? null,
    })
  }

  const results: MedallionLayer[] = []
  for (const layerName of ['bronze', 'silver', 'gold'] as const) {
    const def = LAYER_TABLES[layerName]
    const tables: MedallionTable[] = []
    let totalRows = 0
    let totalBytes: number | null = 0
    let youngestAge: number | null = null
    let testsPass = 0
    let testsTotal = 0

    for (const t of def) {
      const probe = probeRows.get(t.table) ?? { rows: null, age: null }
      const rows = probe.rows
      const ageSec = probe.age

      // bytes is no longer derived — duckdb_tables().estimated_size is the row
      // count (not bytes, despite the column name). Showing '—' is honest.
      tables.push({
        name: t.table,
        rows,
        bytes: null,
        age_seconds: ageSec,
        materialization: t.materialization,
      })
      if (rows != null) totalRows += rows
      totalBytes = null
      if (ageSec != null && (youngestAge == null || ageSec < youngestAge)) {
        youngestAge = ageSec
      }
      const testEntry = testsByRelation.get(t.table)
      if (testEntry) {
        testsPass += testEntry.pass
        testsTotal += testEntry.total
      }
    }

    // Layer health: bronze tied to source freshness (handled by overall);
    // here we just derive from age and tests.
    let status: HealthLevel = 'green'
    if (testsTotal > 0 && testsPass < testsTotal) status = 'red'
    else if (youngestAge != null && youngestAge > 1800) status = 'yellow'
    else if (youngestAge == null && layerName !== 'silver') status = 'unknown'

    results.push({
      layer: layerName,
      role: ({ bronze: 'raw · append-only', silver: 'cleaned · conformed', gold: 'business · marts' } as const)[layerName],
      materialization: ({ bronze: 'parquet lake', silver: 'dbt work DB', gold: 'read DB table' } as const)[layerName],
      status,
      tables,
      total_rows: totalRows,
      total_bytes: totalBytes,
      age_seconds: youngestAge,
      tests_pass: testsPass,
      tests_total: testsTotal,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Pipeline snapshot — single composite payload the new Observability page
// consumes. Keeping it in one endpoint avoids a fan-out of HTTP polls.
// ---------------------------------------------------------------------------

export interface PipelineSnapshot {
  overall: OverallHealth | null
  watcher: WatcherHealth | null
  ingestion_1h: IngestionStats | null
  ingestion_1d: IngestionStats | null
  ingestion_7d: IngestionStats | null
  hourly: HourlyIngestion[]
  dbt: DbtHealth | null
  dbt_history: DbtHistoryEntry[]
  artifacts: DbtArtifacts | null
  layers: MedallionLayer[]
  errors: WatcherError[]
  integrity: NumberIntegrity | null
  coverage: IngestCoverage | null
}

// Composite snapshot — used by both the API route and the page's SSR fetch.
// Centralising here avoids the server → self HTTP round-trip on initial paint.
async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn() } catch (e) {
    console.error(`[observability] ${label} failed:`, e instanceof Error ? e.message : e)
    return fallback
  }
}

// 5 s memo: every open /observability tab polls this, and the numbers only
// change when the watcher flushes or publishes.
const SNAPSHOT_TTL_MS = 5000
let snapshotMemo: { at: number; value: Promise<PipelineSnapshot> } | null = null

export function getPipelineSnapshot(): Promise<PipelineSnapshot> {
  const now = Date.now()
  if (snapshotMemo && now - snapshotMemo.at < SNAPSHOT_TTL_MS) return snapshotMemo.value
  const value = buildPipelineSnapshot()
  snapshotMemo = { at: now, value }
  value.catch(() => { snapshotMemo = null })
  return value
}

async function buildPipelineSnapshot(): Promise<PipelineSnapshot> {
  const status = await readWatcherStatus()
  const [overall, ingestion, hourly, dbt, dbtHistory, artifacts, errors, integrity, coverage] = await Promise.all([
    safe('overall',        () => getOverallHealth(status),     null),
    safe('ingestion-all',  () => getIngestionStatsAll(status), null),
    safe('hourly-24',      () => getHourlyIngestion(24),       [] as HourlyIngestion[]),
    safe('dbt',            () => getDbtHealth(),               null),
    safe('dbt-history',    () => getDbtRunHistory(6),          [] as DbtHistoryEntry[]),
    safe('dbt-artifacts',  () => getDbtArtifacts(),            null),
    safe('watcher-errors', () => getRecentWatcherErrors(50),   [] as WatcherError[]),
    safe('integrity',      () => getNumberIntegrity(),         null),
    safe('coverage',       () => getIngestCoverage(),          null),
  ])
  const watcher = getWatcherHealth(status, overall, ingestion)

  // Medallion layers needs dbt.per_test for test attribution — runs after dbt.
  const layers = await safe(
    'medallion',
    () => getMedallionLayers(dbt?.per_test ?? [], overall?.bronze_age_seconds ?? null),
    [] as MedallionLayer[]
  )

  return {
    overall,
    watcher,
    ingestion_1h: ingestion?.s1h ?? null,
    ingestion_1d: ingestion?.s1d ?? null,
    ingestion_7d: ingestion?.s7d ?? null,
    hourly,
    dbt,
    dbt_history: dbtHistory,
    artifacts,
    layers,
    errors,
    integrity,
    coverage,
  }
}
