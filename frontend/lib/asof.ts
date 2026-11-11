import { queryOne } from './db'

// Every range ("today", 7d, 30d) is anchored to the newest priced call in the
// read DB, not the wall clock, so a stale read DB never shows an empty "today"
// next to yesterday's numbers. Falls back to now when the table is empty/missing.
export async function getDataAsOf(): Promise<Date> {
  try {
    const r = await queryOne<{ ts: string | null }>(
      `SELECT strftime(MAX(ts), '%Y-%m-%dT%H:%M:%SZ') AS ts FROM fact_model_calls`)
    if (r?.ts) return new Date(r.ts)
  } catch { /* no read DB yet */ }
  return new Date()
}

export function asOfLabel(d: Date): string {
  const day = d.toLocaleDateString('en-GB', { timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric' })
  return `${day}, ${d.toISOString().slice(11, 16)} UTC`
}
