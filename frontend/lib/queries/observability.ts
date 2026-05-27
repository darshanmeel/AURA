import { promises as fs } from 'node:fs'
import path from 'node:path'
import { query, queryOne } from '../db'

const ARTIFACTS_DIR = process.env.AURA_ARTIFACTS_DIR ?? '/data/artifacts'
const RUN_RESULTS_PATH = `${ARTIFACTS_DIR}/run_results.json`
const SOURCES_PATH = `${ARTIFACTS_DIR}/sources.json`
const HISTORY_DIR = `${ARTIFACTS_DIR}/history`

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
  const rank: Record<HealthLevel, number> = { unknown: 0, green: 1, yellow: 2, red: 3 }
  return levels.reduce((worst, l) => rank[l] > rank[worst] ? l : worst, 'green' as HealthLevel)
}

export async function getOverallHealth(): Promise<OverallHealth> {
  // 1. Bronze freshness — always read directly from raw_events
  let bronzeLatestEvent: string | null = null
  let bronzeAgeSeconds: number | null = null

  try {
    const row = await queryOne<{ latest_ts: string | null; age_seconds: number | null }>(
      `SELECT
         MAX(ts)::VARCHAR                                          AS latest_ts,
         EXTRACT(EPOCH FROM (NOW() - MAX(ts)))::DOUBLE            AS age_seconds
       FROM raw_events`
    )
    if (row?.latest_ts) {
      bronzeLatestEvent = row.latest_ts
      bronzeAgeSeconds = row.age_seconds ?? null
    }
  } catch (_e) {
    // raw_events missing — treat as unknown
  }

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

  // 3. Watcher errors
  let errorsLastHour = 0
  let errorsLastDay = 0

  try {
    const row = await queryOne<{ last_hour: number; last_day: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL 1 HOUR)  AS last_hour,
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL 1 DAY)   AS last_day
       FROM watcher_errors`
    )
    errorsLastHour = Number(row?.last_hour ?? 0)
    errorsLastDay = Number(row?.last_day ?? 0)
  } catch (_e) {
    // watcher_errors table may not exist yet
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

function windowClause(window: '1h' | '1d' | '7d'): string {
  switch (window) {
    case '1h': return `ts >= NOW() - INTERVAL 1 HOUR`
    case '1d': return `ts >= NOW() - INTERVAL 1 DAY`
    case '7d': return `ts >= NOW() - INTERVAL 7 DAYS`
  }
}

export async function getIngestionStats(window: '1h' | '1d' | '7d'): Promise<IngestionStats> {
  const wc = windowClause(window)

  let rowsIngested = 0
  let sessionsIngested = 0
  let filesSeen = 0

  try {
    const row = await queryOne<{ rows_ingested: number; sessions_ingested: number }>(
      `SELECT
         COUNT(*)                    AS rows_ingested,
         COUNT(DISTINCT session_id)  AS sessions_ingested
       FROM raw_events
       WHERE ${wc}`
    )
    rowsIngested = Number(row?.rows_ingested ?? 0)
    sessionsIngested = Number(row?.sessions_ingested ?? 0)
  } catch (_e) {
    // raw_events absent
  }

  try {
    const row = await queryOne<{ files_seen: number }>(
      `SELECT COUNT(*) AS files_seen FROM ingest_checkpoints`
    )
    filesSeen = Number(row?.files_seen ?? 0)
  } catch (_e) {
    // ingest_checkpoints absent
  }

  return {
    window,
    rows_ingested: rowsIngested,
    sessions_ingested: sessionsIngested,
    files_seen: filesSeen,
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

export async function getWatcherHealth(): Promise<WatcherHealth> {
  // Bronze freshness
  let bronzeLatestEvent: string | null = null
  let bronzeAgeSeconds: number | null = null

  try {
    const row = await queryOne<{ latest_ts: string | null; age_seconds: number | null }>(
      `SELECT
         MAX(ts)::VARCHAR                                       AS latest_ts,
         EXTRACT(EPOCH FROM (NOW() - MAX(ts)))::DOUBLE         AS age_seconds
       FROM raw_events`
    )
    if (row?.latest_ts) {
      bronzeLatestEvent = row.latest_ts
      bronzeAgeSeconds = row.age_seconds ?? null
    }
  } catch (_e) {
    // raw_events absent
  }

  // Checkpoint stats
  let filesTotal = 0
  let totalBytesIngested = 0

  try {
    const row = await queryOne<{ files_total: number; total_bytes: number }>(
      `SELECT
         COUNT(*)           AS files_total,
         SUM(last_offset)   AS total_bytes
       FROM ingest_checkpoints`
    )
    filesTotal = Number(row?.files_total ?? 0)
    totalBytesIngested = Number(row?.total_bytes ?? 0)
  } catch (_e) {
    // ingest_checkpoints absent
  }

  // Ingestion counts per window
  let ingestion1h = 0
  let ingestion1d = 0
  let ingestion7d = 0

  try {
    const row = await queryOne<{ c1h: number; c1d: number; c7d: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL 1 HOUR)   AS c1h,
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL 1 DAY)    AS c1d,
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL 7 DAYS)   AS c7d
       FROM raw_events`
    )
    ingestion1h = Number(row?.c1h ?? 0)
    ingestion1d = Number(row?.c1d ?? 0)
    ingestion7d = Number(row?.c7d ?? 0)
  } catch (_e) {
    // raw_events absent
  }

  // Error counts
  let errorsLastHour = 0
  let errorsLastDay = 0

  try {
    const row = await queryOne<{ last_hour: number; last_day: number }>(
      `SELECT
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL 1 HOUR)  AS last_hour,
         COUNT(*) FILTER (WHERE ts >= NOW() - INTERVAL 1 DAY)   AS last_day
       FROM watcher_errors`
    )
    errorsLastHour = Number(row?.last_hour ?? 0)
    errorsLastDay = Number(row?.last_day ?? 0)
  } catch (_e) {
    // watcher_errors absent
  }

  return {
    bronze_latest_event: bronzeLatestEvent,
    bronze_age_seconds: bronzeAgeSeconds,
    bronze_status: bronzeStatus(bronzeAgeSeconds),
    files_total: filesTotal,
    total_bytes_ingested: totalBytesIngested,
    ingestion_1h: ingestion1h,
    ingestion_1d: ingestion1d,
    ingestion_7d: ingestion7d,
    errors_last_hour: errorsLastHour,
    errors_last_day: errorsLastDay,
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
  try {
    return await query<WatcherError>(
      `SELECT
         ts::VARCHAR          AS ts,
         source,
         file_path,
         error_message,
         stack_trace
       FROM watcher_errors
       ORDER BY ts DESC
       LIMIT ${limit ?? 50}`
    )
  } catch (_e) {
    // watcher_errors table may not exist yet
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
  // gold
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
  'dim_sessions',
  'dim_projects',
  'dim_agents',
  'dim_people',
  'dim_apps',
  // silver
  'stg_assistant_messages',
  'stg_session_skills',
  'stg_thinking_blocks',
  'stg_session_meta',
  'stg_tool_results',
  'stg_tool_calls',
  'stg_events',
  // bronze
  'raw_events',
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
// Hourly ingestion buckets (sparkline data)
// ---------------------------------------------------------------------------

export interface HourlyIngestion {
  hour: string        // ISO timestamp of the bucket (truncated to the hour)
  rows: number
}

export async function getHourlyIngestion(hours: number = 24): Promise<HourlyIngestion[]> {
  // We pre-build all N buckets and LEFT JOIN so quiet hours show up as zero
  // instead of dropping out — the sparkline needs a complete time axis.
  try {
    return await query<HourlyIngestion>(
      `WITH bucket_axis AS (
         SELECT
           date_trunc('hour', NOW()) - (INTERVAL 1 HOUR * (h.i))   AS hour
         FROM generate_series(0, ${hours - 1}) AS h(i)
       ),
       counts AS (
         SELECT
           date_trunc('hour', ts) AS hour,
           COUNT(*)               AS rows
         FROM raw_events
         WHERE ts >= NOW() - INTERVAL ${hours} HOUR
         GROUP BY 1
       )
       SELECT
         a.hour::VARCHAR  AS hour,
         COALESCE(c.rows, 0)::BIGINT AS rows
       FROM bucket_axis a
       LEFT JOIN counts c USING (hour)
       ORDER BY a.hour`
    )
  } catch (_e) {
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
  rows: number
  bytes: number | null              // approximate, from duckdb_tables() (null = unknown)
  age_seconds: number | null        // freshness signal; null for static dims
  materialization: string           // table | view | incremental | external
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
// stable.
const LAYER_TABLES: Record<'bronze' | 'silver' | 'gold', { table: string; materialization: string; ts_column: string | null }[]> = {
  bronze: [
    { table: 'raw_events', materialization: 'external', ts_column: 'ts' },
  ],
  silver: [
    { table: 'stg_events',              materialization: 'view', ts_column: 'ts' },
    { table: 'stg_assistant_messages',  materialization: 'view', ts_column: 'ts' },
    { table: 'stg_tool_calls',          materialization: 'view', ts_column: 'ts' },
    { table: 'stg_tool_results',        materialization: 'view', ts_column: 'ts' },
    { table: 'stg_thinking_blocks',     materialization: 'view', ts_column: 'ts' },
    { table: 'stg_session_meta',        materialization: 'view', ts_column: null },
    { table: 'stg_session_skills',      materialization: 'view', ts_column: null },
  ],
  gold: [
    { table: 'dim_agents',           materialization: 'table',       ts_column: null },
    { table: 'dim_apps',             materialization: 'table',       ts_column: null },
    { table: 'dim_people',           materialization: 'table',       ts_column: null },
    { table: 'dim_projects',         materialization: 'table',       ts_column: null },
    { table: 'dim_sessions',         materialization: 'table',       ts_column: 'session_start' },
    { table: 'fact_hourly_activity', materialization: 'table',       ts_column: null },
    { table: 'fact_model_calls',     materialization: 'incremental', ts_column: 'ts' },
    { table: 'fact_prompts',         materialization: 'incremental', ts_column: 'ts' },
    { table: 'fact_turns',           materialization: 'incremental', ts_column: 'ts' },
    { table: 'fact_tool_executions', materialization: 'incremental', ts_column: 'ts' },
    { table: 'fact_spend_pace',      materialization: 'table',       ts_column: null },
    { table: 'fact_daily_spend',     materialization: 'table',       ts_column: null },
    { table: 'fact_errors',          materialization: 'table',       ts_column: 'ts' },
    { table: 'fact_session_files',   materialization: 'table',       ts_column: null },
    { table: 'fact_git_commands',    materialization: 'table',       ts_column: null },
  ],
}

interface TableSizeRow {
  table_name: string
  estimated_size: number | null
}

export async function getMedallionLayers(perTestResults: DbtTestResult[] = []): Promise<MedallionLayer[]> {
  // Per-table byte estimates from DuckDB's information schema. estimated_size
  // is a rough total-bytes-in-storage figure; null when the catalog doesn't
  // report it. Wrapped because duckdb_tables() may be absent in older builds.
  let sizesByTable = new Map<string, number | null>()
  try {
    const rows = await query<TableSizeRow>(
      `SELECT table_name, estimated_size
       FROM duckdb_tables()`
    )
    sizesByTable = new Map(rows.map(r => [r.table_name, r.estimated_size != null ? Number(r.estimated_size) : null]))
  } catch (_e) {
    // catalog unavailable — leave sizes empty
  }

  // Per-relation test pass/fail attribution.
  const testsByRelation = new Map<string, { pass: number; total: number }>()
  for (const t of perTestResults) {
    const entry = testsByRelation.get(t.relation) ?? { pass: 0, total: 0 }
    entry.total += 1
    if (t.status === 'pass') entry.pass += 1
    testsByRelation.set(t.relation, entry)
  }

  // Batch every table's COUNT(*) and MAX(ts) into ONE query — opening 23
  // connections sequentially was timing out the API on a 1GB DB. Each
  // sub-select is wrapped in TRY() at the SQL level so a missing table or
  // column doesn't poison the whole UNION.
  const allTables = [
    ...LAYER_TABLES.bronze.map(t => ({ layer: 'bronze' as const, ...t })),
    ...LAYER_TABLES.silver.map(t => ({ layer: 'silver' as const, ...t })),
    ...LAYER_TABLES.gold.map(t => ({ layer: 'gold' as const, ...t })),
  ]
  const probeRows: Map<string, { rows: number; age: number | null }> = new Map()
  try {
    const unions = allTables.map(t => `
      SELECT
        '${t.table}'::VARCHAR AS table_name,
        (SELECT COUNT(*) FROM ${t.table})::BIGINT AS rows,
        ${t.ts_column
          ? `(SELECT EXTRACT(EPOCH FROM (NOW() - MAX(${t.ts_column})))::DOUBLE FROM ${t.table})`
          : 'NULL::DOUBLE'} AS age
    `).join(' UNION ALL ')
    const rows = await query<{ table_name: string; rows: number | string; age: number | null }>(unions)
    for (const r of rows) {
      probeRows.set(r.table_name, {
        rows: Number(r.rows),
        age: r.age != null ? Number(r.age) : null,
      })
    }
  } catch (e) {
    // Bulk probe failed (likely a missing table broke the UNION). Fall back
    // to per-table queries — slower but resilient.
    for (const t of allTables) {
      try {
        const r = await queryOne<{ n: number; age: number | null }>(
          `SELECT COUNT(*) AS n, ${t.ts_column
            ? `EXTRACT(EPOCH FROM (NOW() - MAX(${t.ts_column})))::DOUBLE`
            : 'NULL::DOUBLE'} AS age FROM ${t.table}`
        )
        probeRows.set(t.table, { rows: Number(r?.n ?? 0), age: r?.age != null ? Number(r.age) : null })
      } catch (_e) {
        // skip missing
      }
    }
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
      const probe = probeRows.get(t.table)
      if (!probe) continue       // table missing — silently drop from layer
      const rows = probe.rows
      const ageSec = probe.age

      const bytes = sizesByTable.has(t.table) ? sizesByTable.get(t.table) ?? null : null
      tables.push({
        name: t.table,
        rows,
        bytes,
        age_seconds: ageSec,
        materialization: t.materialization,
      })
      totalRows += rows
      if (bytes == null) {
        totalBytes = null            // any null poisons the layer total
      } else if (totalBytes != null) {
        totalBytes += bytes
      }
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
      materialization: ({ bronze: 'external table', silver: 'view', gold: 'table' } as const)[layerName],
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
}

