// Smoke (spec §3.3 S43): with AURA_TEST_READ_DIR set, run every exported
// query function once for real against that read DB and expect no throw.
import { describe, expect, it } from 'vitest'

const READ_DIR = process.env.AURA_TEST_READ_DIR

describe.skipIf(!READ_DIR)('query smoke', () => {
  it('runs every query function without throwing', async () => {
    // db.ts reads AURA_READ_DIR when it is first imported
    process.env.AURA_READ_DIR = READ_DIR
    const { query } = await import('../db')
    const { allCalls } = await import('./testCalls')

    const first = async (sql: string, col: string, fallback: string) => {
      const rows = await query<Record<string, unknown>>(sql)
      return rows.length && rows[0][col] != null ? String(rows[0][col]) : fallback
    }
    const ids = {
      session: await first('SELECT session_id FROM dim_sessions ORDER BY turn_count DESC NULLS LAST LIMIT 1', 'session_id', 'none'),
      app: await first('SELECT app_id FROM dim_apps ORDER BY total_cost DESC NULLS LAST LIMIT 1', 'app_id', 'none'),
      agent: await first('SELECT agent FROM dim_agents ORDER BY total_cost DESC NULLS LAST LIMIT 1', 'agent', 'main'),
      person: await first('SELECT person_id FROM dim_people LIMIT 1', 'person_id', 'none'),
      project: await first('SELECT project_id FROM dim_projects LIMIT 1', 'project_id', 'none'),
    }

    const failures: string[] = []
    for (const [name, calls] of Object.entries(allCalls(ids))) {
      for (const call of calls) {
        try { await call() } catch (e) { failures.push(`${name}: ${e instanceof Error ? e.message : e}`) }
      }
    }
    expect(Array.from(new Set(failures))).toEqual([])
  })
})
