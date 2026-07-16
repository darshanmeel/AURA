export const dynamic = 'force-dynamic'

import React from 'react'
import { Rule, AgentLink, ModelPill } from '../../components/atoms'
import { RangeFilter } from '../../components/RangeFilter'
import { TokenSeriesChart, TOKEN_TYPE_SEGMENTS, pivotByDim } from '../../components/TokenSeriesChart'
import { fmt } from '../../lib/fmt'
import { parseRange, rangeSince, rangeLabel } from '../../lib/range'
import {
  getTokenSeries, getTokenSeriesByModel,
  getTokenSeriesByProvider, getTokenByAgent,
} from '../../lib/queries/dashboard'

export default async function TokensPage({
  searchParams,
}: { searchParams?: { range?: string } }) {
  const range = parseRange(searchParams?.range)
  const since = rangeSince(range)
  const hourly = range === 'today'

  const safe = async <T,>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn() } catch (e) {
      console.error('[tokens]', e instanceof Error ? e.message : e)
      return fallback
    }
  }

  const [byType, byModel, byProvider, byAgent] = await Promise.all([
    safe(() => getTokenSeries(since, hourly), [] as any[]),
    safe(() => getTokenSeriesByModel(since, hourly), [] as any[]),
    safe(() => getTokenSeriesByProvider(since, hourly), [] as any[]),
    safe(() => getTokenByAgent(since), [] as any[]),
  ])

  const modelPivot    = pivotByDim(byModel,    'model',    'total_tokens')
  const providerPivot = pivotByDim(byProvider, 'provider', 'total_tokens')

  const totalAcrossAgents = byAgent.reduce(
    (a: number, r: any) => a + Number(r.total_tokens ?? 0), 0
  )

  return (
    <div className="page-layout">
      {/* Header */}
      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <h1 className="display display-sm" style={{ margin: 0 }}>Tokens · {rangeLabel(range)}</h1>
          <RangeFilter current={range} />
        </div>
        <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          Token volume bucketed by {hourly ? 'hour' : 'day'} across the selected range,
          broken down by token type, model, provider, and agent. Dashboard shows the
          headline; this page is the drill-down.
        </p>
      </section>

      <Rule weight="thick" />

      {/* By token type */}
      <section style={{ marginBottom: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h2 className="h-section">By token type</h2>
          <span className="section-meta">input · output · cache (read · 5m · 1h)</span>
        </div>
        <TokenSeriesChart rows={byType} segments={TOKEN_TYPE_SEGMENTS} hourly={hourly} />
      </section>

      <Rule />

      {/* By provider — small N, useful overlay */}
      <section style={{ marginBottom: 32, marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h2 className="h-section">By provider</h2>
          <span className="section-meta">{providerPivot.segments.length} provider{providerPivot.segments.length !== 1 ? 's' : ''}</span>
        </div>
        <TokenSeriesChart rows={providerPivot.rows} segments={providerPivot.segments} hourly={hourly} />
      </section>

      <Rule />

      {/* By model */}
      <section style={{ marginBottom: 32, marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h2 className="h-section">By model</h2>
          <span className="section-meta">{modelPivot.segments.length} model{modelPivot.segments.length !== 1 ? 's' : ''} · top-10 colored, tail lumped grey</span>
        </div>
        <TokenSeriesChart rows={modelPivot.rows} segments={modelPivot.segments} hourly={hourly} />
      </section>

      <Rule />

      {/* By agent — table, since N is too large for a stacked chart */}
      <section style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h2 className="h-section">By agent</h2>
          <span className="section-meta">top {byAgent.length} · total {fmt.k(totalAcrossAgents)} tokens</span>
        </div>
        {byAgent.length === 0 ? (
          <div className="empty-block">No agent activity in this range.</div>
        ) : (
          <table className="ledger-table" style={{ tableLayout: 'fixed', width: '100%' }}>
            <thead>
              <tr>
                <th>Agent</th>
                <th className="num" style={{ width: 90 }}>Input</th>
                <th className="num" style={{ width: 90 }}>Output</th>
                <th className="num" style={{ width: 110 }}>Cache write</th>
                <th className="num" style={{ width: 100 }}>Cache read</th>
                <th className="num" style={{ width: 100 }}>Total</th>
                <th className="num" style={{ width: 90 }}>Cost</th>
                <th style={{ width: 120 }}>Share</th>
              </tr>
            </thead>
            <tbody>
              {byAgent.map((row: any) => {
                const totalN = Number(row.total_tokens ?? 0)
                const sharePct = totalAcrossAgents > 0 ? (totalN / totalAcrossAgents) * 100 : 0
                return (
                  <tr key={row.agent}>
                    <td><AgentLink name={row.agent} /></td>
                    <td className="num mono">{fmt.k(row.input_tokens)}</td>
                    <td className="num mono">{fmt.k(row.output_tokens)}</td>
                    <td className="num mono">{fmt.k(row.cache_write)}</td>
                    <td className="num mono">{fmt.k(row.cache_read)}</td>
                    <td className="num mono strong">{fmt.k(row.total_tokens)}</td>
                    <td className="num mono">{fmt.usd(row.cost)}</td>
                    <td>
                      <div className="tbar" style={{ width: '100%', height: 6, background: 'var(--rule)', borderRadius: 1, overflow: 'hidden' }}>
                        <div className="tbar-fill" style={{ width: `${sharePct}%`, height: '100%', background: 'var(--accent)' }} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  )
}
