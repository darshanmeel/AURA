import { DuckDBInstance, DuckDBValue } from '@duckdb/node-api'

const DB_PATH = process.env.AURA_READ_DB_PATH ?? '/data/aura_read.duckdb'

let instance: DuckDBInstance | null = null

async function getInstance(): Promise<DuckDBInstance> {
  if (!instance) {
    instance = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' })
  }
  return instance
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await getInstance()
  const conn = await db.connect()
  try {
    const result = await conn.runAndReadAll(sql, ...(params as DuckDBValue[]))
    const columnNames = result.columnNames()
    const rows = result.getRows()
    return rows.map(row => {
      const obj: Record<string, unknown> = {}
      columnNames.forEach((col, i) => { obj[col] = row[i] })
      return obj as T
    })
  } finally {
    await conn.close()
  }
}

export async function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}
