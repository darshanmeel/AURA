// Read-DB contract (spec §6.7): every query binds against the published read
// DB, and names only tables that watcher/src/aura_watcher/read_tables.sql
// creates. EXPLAIN binds every table and column without scanning.
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DuckDBInstance, type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api'
import { allCalls, exportedFunctionNames, type Ids } from './testCalls'
import { dbPathFor, readCurrentVersion } from '../db'

const state = vi.hoisted(() => ({
  conn: null as DuckDBConnection | null,
  sqls: [] as string[],
  errors: [] as string[],
}))

vi.mock('../db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../db')>()
  async function explain(sql: string, params: unknown[] = []) {
    state.sqls.push(sql)
    try {
      await state.conn!.run(`EXPLAIN ${sql}`, params as DuckDBValue[])
    } catch (e) {
      // Many query functions swallow their own errors, so record them here.
      state.errors.push(`${e instanceof Error ? e.message : e}\n--- ${sql.trim().slice(0, 400)}`)
      throw e
    }
    return []
  }
  return {
    ...orig,
    query: explain,
    queryOne: async (sql: string, params: unknown[] = []) => { await explain(sql, params); return null },
  }
})

const READ_DIR = process.env.AURA_TEST_READ_DIR
const READ_TABLES_SQL = process.env.AURA_TEST_READ_TABLES_SQL
  ?? fileURLToPath(new URL('../../../watcher/src/aura_watcher/read_tables.sql', import.meta.url))

function readTableNames(sqlText: string): Set<string> {
  return new Set(Array.from(sqlText.matchAll(/CREATE\s+TABLE\s+([A-Za-z_]\w*)/gi), m => m[1].toLowerCase()))
}

// Relations after FROM/JOIN, minus CTE names, subqueries and table functions.
function relationsIn(sql: string): Set<string> {
  const ctes = new Set(Array.from(sql.matchAll(/\b([A-Za-z_]\w*)\s+AS\s*\(/gi), m => m[1].toLowerCase()))
  const out = new Set<string>()
  for (const m of Array.from(sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_][\w.]*)(\s*\()?/gi))) {
    if (m[2]) continue
    const name = m[1].toLowerCase()
    if (!ctes.has(name)) out.add(name)
  }
  return out
}

describe('query call list', () => {
  it('covers every exported query function', () => {
    const listed = new Set(Object.keys(allCalls({ session: 's', app: 'a', agent: 'g', person: 'p', project: 'j' })))
    expect(exportedFunctionNames().filter(n => !listed.has(n))).toEqual([])
  })

  it('finds relations but not CTEs or table functions', () => {
    const sql = `WITH c AS (SELECT 1 FROM fact_model_calls) SELECT * FROM c JOIN dim_sessions ds ON true
                 LEFT JOIN generate_series(1, 2) g ON true WHERE x IN (SELECT 1 FROM (SELECT 1))`
    expect(Array.from(relationsIn(sql)).sort()).toEqual(['dim_sessions', 'fact_model_calls'])
  })
})

describe.skipIf(!READ_DIR)('read DB contract', () => {
  it('every query binds and reads only read_tables.sql tables', async () => {
    const allowed = readTableNames(readFileSync(READ_TABLES_SQL, 'utf8'))
    expect(allowed.size).toBeGreaterThan(0)

    const path = dbPathFor(READ_DIR!, readCurrentVersion(READ_DIR!))
    const db = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY', TimeZone: 'UTC' })
    const conn = await db.connect()
    state.conn = conn

    const first = async (sql: string, fallback: string) => {
      const rows = (await conn.runAndReadAll(sql)).getRows()
      return rows.length && rows[0][0] != null ? String(rows[0][0]) : fallback
    }
    const ids: Ids = {
      session: await first('SELECT session_id FROM dim_sessions ORDER BY turn_count DESC NULLS LAST LIMIT 1', 'none'),
      app: await first('SELECT app_id FROM dim_apps ORDER BY total_cost DESC NULLS LAST LIMIT 1', 'none'),
      agent: await first('SELECT agent FROM dim_agents ORDER BY total_cost DESC NULLS LAST LIMIT 1', 'main'),
      person: await first('SELECT person_id FROM dim_people LIMIT 1', 'none'),
      project: await first('SELECT project_id FROM dim_projects LIMIT 1', 'none'),
    }

    for (const [name, calls] of Object.entries(allCalls(ids))) {
      for (const call of calls) {
        try { await call() } catch (e) {
          // recorded by the mock when it is a SQL error; anything else is a bug too
          if (!state.errors.some(x => x.includes(String((e as Error).message)))) state.errors.push(`${name}: ${e}`)
        }
      }
    }

    const unknown = new Set<string>()
    for (const sql of state.sqls) relationsIn(sql).forEach(r => { if (!allowed.has(r)) unknown.add(r) })

    conn.closeSync()
    db.closeSync()
    expect(Array.from(new Set(state.errors))).toEqual([])
    expect(Array.from(unknown).sort()).toEqual([])
  })
})
