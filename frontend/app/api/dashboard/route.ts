import { NextResponse } from 'next/server'
import {
  getDashboardKPIs, getDailySpend, getTopApps, getTopAgents,
  getToolMix, getProviderSplit, getModelBreakdown,
  getRecentErrors, getTopFiles, getTopPeople
} from '../../../lib/queries/dashboard'

// Per-query isolation: a single missing mart (e.g. before first successful dbt run)
// must not 500 the whole endpoint. Each query falls back to a safe empty value.
async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn() } catch (e) {
    console.error(`[api/dashboard] ${label} failed:`, e instanceof Error ? e.message : e)
    return fallback
  }
}

export async function GET() {
  const [kpis, dailySpend, topApps, topAgents, toolMix, providers, models, recentErrors, topFiles, topPeople] =
    await Promise.all([
      safe('kpis',         () => getDashboardKPIs(),   null),
      safe('dailySpend',   () => getDailySpend(),      [] as any[]),
      safe('topApps',      () => getTopApps(),         [] as any[]),
      safe('topAgents',    () => getTopAgents(),       [] as any[]),
      safe('toolMix',      () => getToolMix(),         [] as any[]),
      safe('providers',    () => getProviderSplit(),   [] as any[]),
      safe('models',       () => getModelBreakdown(),  [] as any[]),
      safe('recentErrors', () => getRecentErrors(),    [] as any[]),
      safe('topFiles',     () => getTopFiles(),        [] as any[]),
      safe('topPeople',    () => getTopPeople(),       [] as any[]),
    ])
  return NextResponse.json({ kpis, dailySpend, topApps, topAgents, toolMix, providers, models, recentErrors, topFiles, topPeople })
}
