import { DuckDBInstance, DuckDBConnection, DuckDBValue } from '@duckdb/node-api'

const DB_PATH = process.env.AURA_READ_DB_PATH ?? '/data/aura_read.duckdb'

let instance: DuckDBInstance | null = null
let conn: DuckDBConnection | null = null

async function getConn(): Promise<DuckDBConnection> {
  if (!instance) {
    instance = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' })
  }
  if (!conn) {
    conn = await instance.connect()
  }
  return conn
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const conn = await getConn()
  const result = await conn.runAndReadAll(sql, params as DuckDBValue[])
  const rows = result.getRowObjectsJS()
  return rows.map(row =>
    Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])
    )
  ) as unknown as T[]
}

export async function queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}
