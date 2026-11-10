import {
  DuckDBInstance,
  DuckDBValue,
  DuckDBTimestampValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampMillisecondsValue,
  DuckDBTimestampSecondsValue,
  DuckDBTimestampNanosecondsValue,
  DuckDBDateValue,
} from '@duckdb/node-api'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA_DIR = process.env.AURA_DATA_DIR ?? '/data'
const READ_DIR = process.env.AURA_READ_DIR ?? `${DATA_DIR}/read`
const QUERY_TIMEOUT_MS = Number(process.env.AURA_QUERY_TIMEOUT_MS ?? 15000)
const SPILL_ROOT = join(tmpdir(), 'aura-duckdb')

// A crashed process can leave spill files whose size accounting underflows
// ("16383.9 PiB" temp-dir error) on the next open, so start clean.
try { rmSync(SPILL_ROOT, { recursive: true, force: true }) } catch { /* best effort */ }

// The watcher publishes each read DB into a fresh dir read/<ver>/aura.duckdb
// and then points read/CURRENT at it (spec §2.2). Files are never replaced
// in place, so a version change is the only signal we need.
export function readCurrentVersion(readDir: string): string {
  let ver = ''
  try { ver = readFileSync(join(readDir, 'CURRENT'), 'utf8').trim() } catch { /* missing */ }
  if (!ver) throw new Error('read DB not published yet')
  return ver
}

export function dbPathFor(readDir: string, ver: string): string {
  return join(readDir, ver, 'aura.duckdb')
}

// One spill dir per version: the old and new instances are open together.
export function spillDirFor(ver: string, root: string = SPILL_ROOT): string {
  return join(root, ver)
}

let pointer: { ver: string; at: number } | null = null

function currentVersion(): string {
  const now = Date.now()
  if (pointer && now - pointer.at < 1000) return pointer.ver
  const ver = readCurrentVersion(READ_DIR)
  pointer = { ver, at: now }
  return ver
}

let live: { ver: string; db: DuckDBInstance } | null = null
// Concurrent callers that see a new version await the same open instead of
// each creating (and leaking) an instance.
let creating: { ver: string; p: Promise<DuckDBInstance> } | null = null

async function getInstance(): Promise<DuckDBInstance> {
  const ver = currentVersion()
  if (live && live.ver === ver) return live.db
  if (creating && creating.ver === ver) return creating.p

  const p = DuckDBInstance.create(dbPathFor(READ_DIR, ver), {
    access_mode: 'READ_ONLY',
    TimeZone: 'UTC',
    threads: process.env.AURA_DUCKDB_THREADS ?? '4',
    memory_limit: process.env.AURA_DUCKDB_MEMORY_LIMIT ?? '1GB',
    temp_directory: spillDirFor(ver),
  })
  creating = { ver, p }
  try {
    const db = await p
    // The old instance stays live until the new one is open; close it only
    // after any query already running on it has hit its timeout.
    const old = live
    live = { ver, db }
    if (old) {
      setTimeout(() => {
        try { old.db.closeSync() } catch { /* ignore */ }
        try { rmSync(spillDirFor(old.ver), { recursive: true, force: true }) } catch { /* ignore */ }
      }, QUERY_TIMEOUT_MS + 1000)
    }
    return db
  } finally {
    if (creating?.p === p) creating = null
  }
}

// Recursive BigInt → Number/string normalization. BigInt within JS safe-integer
// range becomes Number; anything outside stays as string so token IDs and
// rare overflow values don't silently lose precision.
export function normalizeBigInts(v: unknown): unknown {
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(v)
      : v.toString()
  }
  if (Array.isArray(v)) return v.map(normalizeBigInts)
  // Date objects have no enumerable own properties, so Object.entries returns [].
  // Without this guard, normalizeBigInts would convert every Date to {} — that
  // breaks RSC serialization (React flight sends {} to the client, which then
  // passes {} to client components like DailyChart) while the server SSR
  // renders with the real Date, causing hydration mismatches (#418).
  if (v instanceof Date) return v.toISOString()
  // F-M6: DuckDB node-api timestamp/date value objects have no enumerable own
  // properties, so Object.entries returns [] and the generic-object branch below
  // would serialize them to {}.  This happens when a raw DuckDBTimestampValue
  // (or sibling) reaches normalizeBigInts without first being passed through
  // JSDuckDBValueConverter (e.g., a future code path calling getRowObjects()
  // instead of getRowObjectsJS(), or a raw value surfaced inside a STRUCT/MAP).
  // Detect every timestamp/date class variant and convert to ISO string.
  if (
    v instanceof DuckDBTimestampValue ||       // TIMESTAMP (micros)
    v instanceof DuckDBTimestampTZValue ||     // TIMESTAMPTZ
    v instanceof DuckDBTimestampMillisecondsValue || // TIMESTAMP_MS
    v instanceof DuckDBTimestampSecondsValue || // TIMESTAMP_S
    v instanceof DuckDBTimestampNanosecondsValue    // TIMESTAMP_NS
  ) {
    // .toString() on these classes produces a human-readable ISO-like string
    // via getDuckDBTimestampStringFromMicroseconds — use it for consistency.
    return (v as { toString(): string }).toString()
  }
  if (v instanceof DuckDBDateValue) {
    // DuckDBDateValue.toString() returns a YYYY-MM-DD string.
    return (v as { toString(): string }).toString()
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = normalizeBigInts(val)
    }
    return out
  }
  return v
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await getInstance()
  const conn = await db.connect()

  // F-H6: We must not call conn.closeSync() while the underlying DuckDB query
  // is still executing — doing so from the timeout path would race an in-flight
  // native operation and can crash or corrupt the connection handle.
  //
  // Strategy:
  //  1. Keep the raw query promise separate from the timeout race.
  //  2. Attach a .finally() to the raw query promise that closes the connection
  //     once the query settles (success or failure), regardless of which path
  //     (normal vs timeout) the caller took.
  //  3. On timeout, call conn.interrupt() — DuckDB's cancel signal — so the
  //     in-flight query aborts promptly rather than running to completion before
  //     the connection is released.
  //
  // Residual risk: @duckdb/node-api does not guarantee interrupt() is
  // honoured for all query types (e.g., a query already in the finalization
  // phase may complete despite interrupt). The connection will still be closed
  // once it settles, so there is no connection leak; however there is a brief
  // window where a timed-out query continues running in the background.
  const label = sql.slice(0, 80).replace(/\s+/g, ' ').trim()

  const queryPromise = conn.runAndReadAll(sql, params as DuckDBValue[])

  // Ensure the connection is released exactly once, after the query settles.
  // We intentionally do NOT await this — the close happens in the background
  // after the query completes; the caller has already received the timeout
  // rejection and moved on.
  queryPromise.finally(() => {
    try { conn.closeSync() } catch { /* ignore errors on deferred close */ }
  }).catch(() => { /* the rejection is handled by the race below */ })

  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      try { conn.interrupt() } catch { /* interrupt is best-effort */ }
      reject(new Error(`Query timeout after ${QUERY_TIMEOUT_MS}ms: ${label}`))
    }, QUERY_TIMEOUT_MS)
  })

  try {
    const result = await Promise.race([queryPromise, timeoutPromise])
    if (timedOut) {
      // Shouldn't be reachable (timeoutPromise only rejects), but guard anyway.
      throw new Error(`Query timeout after ${QUERY_TIMEOUT_MS}ms: ${label}`)
    }
    const rows = result.getRowObjectsJS()
    // Walk recursively — top-level only conversion left BigInt inside
    // ARRAY_AGG(STRUCT_PACK(...)) and array columns, which then triggered
    // "Cannot mix BigInt and other types" downstream in any arithmetic.
    return rows.map(row => normalizeBigInts(row)) as unknown as T[]
  } finally {
    // Clear the timeout timer. The connection close is handled by the
    // queryPromise.finally() above — do NOT call closeSync() here, as the
    // query may still be in flight on the timeout path.
    if (timer) clearTimeout(timer)
  }
}

export async function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}
