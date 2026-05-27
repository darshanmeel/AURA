import { promises as fs } from 'node:fs'
import { query, queryOne } from '../db'

const ARTIFACTS_DIR = process.env.AURA_ARTIFACTS_DIR ?? '/data/artifacts'
const RUN_RESULTS_PATH = `${ARTIFACTS_DIR}/run_results.json`
const SOURCES_PATH = `${ARTIFACTS_DIR}/sources.json`

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

export interface DbtHealth {
  last_run_ts: string | null
  last_run_status: 'success' | 'failure' | 'unknown'
  last_run_duration_s: number | null
  models_total: number
  models_pass: number
  models_fail: number
  per_model: DbtModelResult[]
  source_freshness: DbtSourceFreshness[]
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

export async function getDbtHealth(): Promise<DbtHealth> {
  let lastRunTs: string | null = null
  let lastRunDurationS: number | null = null
  let perModel: DbtModelResult[] = []
  let modelsTotal = 0
  let modelsPass = 0
  let sourcesFreshness: DbtSourceFreshness[] = []

  // Read run_results.json
  try {
    const raw = await fs.readFile(RUN_RESULTS_PATH, 'utf8')
    const json = JSON.parse(raw) as RunResultsJson
    lastRunTs = json.metadata?.generated_at ?? null
    lastRunDurationS = json.elapsed_time ?? null

    const modelResults = (json.results ?? []).filter(r => r.unique_id.startsWith('model.'))
    modelsTotal = modelResults.length

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

    modelsPass = perModel.filter(m => m.status === 'success').length
  } catch (_e) {
    // file absent or unparseable — return defaults below
  }

  const modelsFail = modelsTotal - modelsPass
  const lastRunStatus: 'success' | 'failure' | 'unknown' =
    modelsTotal === 0 ? 'unknown' : modelsFail === 0 ? 'success' : 'failure'

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
