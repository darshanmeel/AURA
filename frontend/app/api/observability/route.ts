import { NextRequest, NextResponse } from 'next/server'
import {
  getOverallHealth,
  getIngestionStats,
  getWatcherHealth,
  getRecentWatcherErrors,
  getDbtHealth,
  getDbtArtifacts,
  getHourlyIngestion,
  getDbtRunHistory,
  getMedallionLayers,
} from '../../../lib/queries/observability'
import { safe as _safe } from '../../../lib/api-safe'

// Force dynamic: at build time /data is not mounted, so the DB cannot be
// opened. Without this, Next.js statically prerenders the empty-fallback
// response and serves it forever. Every request must re-query the DB.
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Per-query isolation: a single missing mart or transient error must not
// 500 the whole view. Each query falls back to a safe empty value.
function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  return _safe(`[api/observability] ${label}`, fn, fallback)
}

export async function GET(_request: NextRequest) {
  try {
    // dbt comes first so we can pass its per_test array into the medallion
    // layer query for test-by-relation attribution.
    const [overall, watcher, s1h, s1d, s7d, hourly, dbt, dbtHistory, artifacts, errors] = await Promise.all([
      safe('overall',        () => getOverallHealth(),         null),
      safe('watcher',        () => getWatcherHealth(),         null),
      safe('stats-1h',       () => getIngestionStats('1h'),    null),
      safe('stats-1d',       () => getIngestionStats('1d'),    null),
      safe('stats-7d',       () => getIngestionStats('7d'),    null),
      safe('hourly-24',      () => getHourlyIngestion(24),     []),
      safe('dbt',            () => getDbtHealth(),             null),
      safe('dbt-history',    () => getDbtRunHistory(6),        []),
      safe('dbt-artifacts',  () => getDbtArtifacts(),          null),
      safe('watcher-errors', () => getRecentWatcherErrors(50), [] as any[]),
    ])

    const layers = await safe(
      'medallion',
      () => getMedallionLayers(dbt?.per_test ?? []),
      []
    )

    return NextResponse.json(
      {
        overall,
        watcher,
        ingestion_1h: s1h,
        ingestion_1d: s1d,
        ingestion_7d: s7d,
        hourly,
        dbt,
        dbt_history: dbtHistory,
        artifacts,
        layers,
        errors,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    )
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
