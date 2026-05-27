import { NextRequest, NextResponse } from 'next/server'
import {
  getOverallHealth,
  getIngestionStats,
  getWatcherHealth,
  getRecentWatcherErrors,
  getDbtHealth,
  getDbtArtifacts,
} from '../../../lib/queries/observability'

// Force dynamic: at build time /data is not mounted, so the DB cannot be
// opened. Without this, Next.js statically prerenders the empty-fallback
// response and serves it forever. Every request must re-query the DB.
export const dynamic = 'force-dynamic'
export const revalidate = 0

// Per-query isolation: a single missing mart or transient error must not
// 500 the whole view. Each query falls back to a safe empty value.
async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn() } catch (e) {
    console.error(`[api/observability] ${label} failed:`, e instanceof Error ? e.message : e)
    return fallback
  }
}

export async function GET(request: NextRequest) {
  try {
    const view = request.nextUrl.searchParams.get('view') ?? 'overview'

    if (view === 'overview' || view === '') {
      const [overall, s1h, s1d, s7d] = await Promise.all([
        safe('overall',    () => getOverallHealth(),      null),
        safe('stats-1h',   () => getIngestionStats('1h'), null),
        safe('stats-1d',   () => getIngestionStats('1d'), null),
        safe('stats-7d',   () => getIngestionStats('7d'), null),
      ])
      return NextResponse.json(
        { overall, stats: { '1h': s1h, '1d': s1d, '7d': s7d } },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      )
    }

    if (view === 'watcher') {
      const [watcher, errors] = await Promise.all([
        safe('watcher',        () => getWatcherHealth(),           null),
        safe('watcher-errors', () => getRecentWatcherErrors(50),   [] as any[]),
      ])
      return NextResponse.json(
        { watcher, errors },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      )
    }

    if (view === 'dbt') {
      const [dbt, artifacts] = await Promise.all([
        safe('dbt',           () => getDbtHealth(),    null),
        safe('dbt-artifacts', () => getDbtArtifacts(), null),
      ])
      return NextResponse.json(
        { dbt, artifacts },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      )
    }

    if (view === 'all') {
      const [overall, s1h, s1d, s7d, watcher, errors, dbt, artifacts] = await Promise.all([
        safe('overall',        () => getOverallHealth(),           null),
        safe('stats-1h',       () => getIngestionStats('1h'),      null),
        safe('stats-1d',       () => getIngestionStats('1d'),      null),
        safe('stats-7d',       () => getIngestionStats('7d'),      null),
        safe('watcher',        () => getWatcherHealth(),           null),
        safe('watcher-errors', () => getRecentWatcherErrors(50),   [] as any[]),
        safe('dbt',            () => getDbtHealth(),               null),
        safe('dbt-artifacts',  () => getDbtArtifacts(),            null),
      ])
      return NextResponse.json(
        {
          overall,
          stats: { '1h': s1h, '1d': s1d, '7d': s7d },
          watcher,
          errors,
          dbt,
          artifacts,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      )
    }

    return NextResponse.json(
      { error: `unknown view: ${view}` },
      { status: 400 }
    )
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
