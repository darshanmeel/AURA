import { NextResponse } from 'next/server'
import {
  getDashboardKPIs, getDailySpend, getTopApps, getTopAgents,
  getToolMix, getProviderSplit, getModelBreakdown,
  getRecentErrors, getTopFiles, getTopPeople,
  getSpendPace, getHourlyActivity
} from '../../../lib/queries/dashboard'
import { safe as _safe } from '../../../lib/api-safe'

// Force dynamic: at build time /data is not mounted, so the DB cannot be
// opened. Without this, Next.js statically prerenders the empty-fallback
// response and serves it forever. Every request must re-query the DB.
export const dynamic = 'force-dynamic'

// Per-query isolation: a single missing mart (e.g. before first successful dbt run)
// must not 500 the whole endpoint. Each query falls back to a safe empty value.
// Label prefix is kept here so log lines are unambiguous.
function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  return _safe(`[api/dashboard] ${label}`, fn, fallback)
}

export async function GET() {
  const [kpis, dailySpend, topApps, topAgents, toolMix, providers, models, recentErrors, topFiles, topPeople, spendPace, hourlyActivity] =
    await Promise.all([
      safe('kpis',            () => getDashboardKPIs(),    null),
      safe('dailySpend',      () => getDailySpend(),       [] as any[]),
      safe('topApps',         () => getTopApps(),          [] as any[]),
      safe('topAgents',       () => getTopAgents(),        [] as any[]),
      safe('toolMix',         () => getToolMix(),          [] as any[]),
      safe('providers',       () => getProviderSplit(),    [] as any[]),
      safe('models',          () => getModelBreakdown(),   [] as any[]),
      safe('recentErrors',    () => getRecentErrors(),     [] as any[]),
      safe('topFiles',        () => getTopFiles(),         [] as any[]),
      safe('topPeople',       () => getTopPeople(),        [] as any[]),
      safe('spendPace',       () => getSpendPace(),        null),
      safe('hourlyActivity',  () => getHourlyActivity(),   [] as any[]),
    ])
  return NextResponse.json({ kpis, dailySpend, topApps, topAgents, toolMix, providers, models, recentErrors, topFiles, topPeople, spendPace, hourlyActivity })
}
