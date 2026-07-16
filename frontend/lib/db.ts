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
import { statSync } from 'node:fs'

const DB_PATH = process.env.AURA_READ_DB_PATH ?? '/data/read/aura.duckdb'
const QUERY_TIMEOUT_MS = Number(process.env.AURA_QUERY_TIMEOUT_MS ?? 15000)

// The watcher's snapshot worker rewrites the read DB via os.replace, which
// gives the file a new inode. A cached DuckDBInstance pins the OLD inode and
// silently serves stale data forever. We track the inode and recreate when
// it changes.
let instance: DuckDBInstance | null = null
let cachedIno: number | bigint | null = null

// Serializes concurrent getInstance() calls that both see instance==null.
// Without this guard, two concurrent requests during a snapshot rotation
// could each call DuckDBInstance.create(), leaking one of the two handles.
// When a (re)open is already in progress, subsequent callers await the same
// promise instead of starting a second create().
let creating: Promise<DuckDBInstance> | null = null

async function getInstance(): Promise<DuckDBInstance> {
  let currentIno: number | bigint | null = null
  try {
    currentIno = statSync(DB_PATH).ino
  } catch {
    currentIno = null
  }
  if (instance && cachedIno !== null && currentIno === cachedIno) {
    return instance
  }
  // A concurrent caller may already be opening a new instance for this inode.
  // Await that in-flight promise so we don't create a second handle.
  if (creating) {
    return creating
  }
  // File was replaced (or first call). Capture old instance for deferred close,
  // then open a new one before closing the old. The deferred close (via
  // setTimeout) avoids invalidating connections that in-flight queries derived
  // from the old handle and may still be executing at the moment of rotation.
  const oldInstance = instance
  instance = null
  creating = DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' })
  try {
    const newInstance = await creating
    instance = newInstance
    cachedIno = currentIno
    if (oldInstance) {
      // Grace delay: give any in-flight queries on the old handle time to finish
      // before the handle is closed. 3 s is well above p99 query latency.
      setTimeout(() => { try { oldInstance.closeSync?.() } catch {} }, 3000)
    }
    return instance
  } finally {
    creating = null
  }
}

// Recursive BigInt → Number/string normalization. BigInt within JS safe-integer
// range becomes Number; anything outside stays as string so token IDs and
// rare overflow values don't silently lose precision.
function normalizeBigInts(v: unknown): unknown {
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
  })

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
