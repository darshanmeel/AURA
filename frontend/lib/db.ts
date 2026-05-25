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
    return rows.map(row =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => {
          if (typeof v === 'bigint') {
            // Safe integer range → number; otherwise string to preserve precision
            return [k, v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
              ? Number(v)
              : v.toString()]
          }
          return [k, v]
        })
      )
    ) as unknown as T[]
  } finally {
    conn.closeSync()
  }
}

export async function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}
