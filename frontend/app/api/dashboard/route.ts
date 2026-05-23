import { NextResponse } from 'next/server'
import {
  getDashboardKPIs, getDailySpend, getTopApps, getTopAgents,
  getToolMix, getProviderSplit, getModelBreakdown,
  getRecentErrors, getTopFiles, getTopPeople
} from '../../../lib/queries/dashboard'

export async function GET() {
  try {
    const [kpis, dailySpend, topApps, topAgents, toolMix, providers, models, recentErrors, topFiles, topPeople] =
      await Promise.all([
        getDashboardKPIs(), getDailySpend(), getTopApps(), getTopAgents(),
        getToolMix(), getProviderSplit(), getModelBreakdown(),
        getRecentErrors(), getTopFiles(), getTopPeople()
      ])
    return NextResponse.json({ kpis, dailySpend, topApps, topAgents, toolMix, providers, models, recentErrors, topFiles, topPeople })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
