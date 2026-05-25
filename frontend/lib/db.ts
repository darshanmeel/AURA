import { DuckDBInstance, DuckDBValue } from '@duckdb/node-api'

const DB_PATH = process.env.AURA_READ_DB_PATH ?? '/data/aura_read.duckdb'
const QUERY_TIMEOUT_MS = Number(process.env.AURA_QUERY_TIMEOUT_MS ?? 15000)

let instance: DuckDBInstance | null = null

async function getInstance(): Promise<DuckDBInstance> {
  if (!instance) {
    instance = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' })
  }
  return instance
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
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = normalizeBigInts(val)
    }
    return out
  }
  return v
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Query timeout after ${ms}ms: ${label}`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await getInstance()
  const conn = await db.connect()
  try {
    const result = await withTimeout(
      conn.runAndReadAll(sql, params as DuckDBValue[]),
      QUERY_TIMEOUT_MS,
      sql.slice(0, 80).replace(/\s+/g, ' ').trim()
    )
    const rows = result.getRowObjectsJS()
    // Walk recursively — top-level only conversion left BigInt inside
    // ARRAY_AGG(STRUCT_PACK(...)) and array columns, which then triggered
    // "Cannot mix BigInt and other types" downstream in any arithmetic.
    return rows.map(row => normalizeBigInts(row)) as unknown as T[]
  } finally {
    conn.closeSync()
  }
}

export async function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}
