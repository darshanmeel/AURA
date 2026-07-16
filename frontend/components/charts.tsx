'use client'
import React from 'react'

interface DaySpend { date: string | Date; cost: number; turns: number }

export function DailyChart({ data }: { data: DaySpend[] }) {
  if (!data.length) return <div className="chart-empty muted">No data</div>
  const W = 600, H = 140, PAD = { t: 10, r: 10, b: 30, l: 40 }
  const sorted = [...data].sort((a, b) => {
    const da = a.date instanceof Date ? a.date : new Date(a.date)
    const db = b.date instanceof Date ? b.date : new Date(b.date)
    return da.getTime() - db.getTime()
  })
  const maxCost = Math.max(...sorted.map(d => d.cost), 0.001)
  const maxTurns = Math.max(...sorted.map(d => d.turns), 1)
  const cw = (W - PAD.l - PAD.r) / sorted.length
  const cx = (i: number) => PAD.l + i * cw + cw / 2
  const costY = (v: number) => PAD.t + (1 - v / maxCost) * (H - PAD.t - PAD.b)
  const turnsY = (v: number) => PAD.t + (1 - v / maxTurns) * (H - PAD.t - PAD.b)

  const turnLine = sorted.map((d, i) => `${i === 0 ? 'M' : 'L'} ${cx(i)} ${turnsY(d.turns)}`).join(' ')

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="daily-chart" aria-label="Daily spend chart">
      {sorted.map((d, i) => {
        const bh = (d.cost / maxCost) * (H - PAD.t - PAD.b)
        const dateStr = d.date instanceof Date ? d.date.toISOString().split('T')[0] : String(d.date)
        const key = d.date instanceof Date ? d.date.toISOString() : String(d.date)
        return (
          <rect
            key={key}
            x={PAD.l + i * cw + 2}
            y={costY(d.cost)}
            width={cw - 4}
            height={bh}
            fill="var(--accent)"
            opacity={0.7}
          >
            {/* Next.js 14 app-page runtime strips multi-child <title> in SVG context
                (eU() only renders a single non-array child). Use a single template-literal
                string so the title content survives SSR and matches client hydration. */}
            <title>{`${dateStr}: $${d.cost.toFixed(4)}, ${d.turns} turns`}</title>
          </rect>
        )
      })}
      <path d={turnLine} fill="none" stroke="var(--accent-2)" strokeWidth={1.5} opacity={0.6} />
      {sorted.filter((_, i) => i % Math.ceil(sorted.length / 7) === 0).map((d, i, arr) => {
        const key = d.date instanceof Date ? d.date.toISOString() : String(d.date)
        return (
          <text
            key={key}
            x={cx(sorted.indexOf(d))}
            y={H - 6}
            textAnchor="middle"
            fontSize={9}
            fill="var(--muted)"
          >
            {new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
          </text>
        )
      })}
    </svg>
  )
}

interface TurnData { turn_number: number; input_tokens: number; output_tokens: number; context_pct: number }

export function TurnChart({ data }: { data: TurnData[] }) {
  if (!data.length) return <div className="chart-empty muted">No turns</div>
  const W = 600, H = 120, PAD = { t: 8, r: 8, b: 20, l: 36 }
  const maxTokens = Math.max(...data.map(d => d.input_tokens + d.output_tokens), 1)
  const cw = (W - PAD.l - PAD.r) / data.length
  const tokY = (v: number) => PAD.t + (1 - v / maxTokens) * (H - PAD.t - PAD.b)
  const ctxLine = data.map((d, i) =>
    `${i === 0 ? 'M' : 'L'} ${PAD.l + i * cw + cw / 2} ${tokY((d.context_pct ?? 0) * maxTokens)}`
  ).join(' ')

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="turn-chart" aria-label="Per-turn token chart">
      {data.map((d, i) => {
        const total = d.input_tokens + d.output_tokens
        const th = (total / maxTokens) * (H - PAD.t - PAD.b)
        const oh = (d.output_tokens / maxTokens) * (H - PAD.t - PAD.b)
        return (
          <g key={d.turn_number}>
            <rect x={PAD.l + i * cw + 1} y={tokY(total)} width={cw - 2} height={th - oh} fill="var(--muted)" opacity={0.4} />
            <rect x={PAD.l + i * cw + 1} y={tokY(d.output_tokens)} width={cw - 2} height={oh} fill="var(--accent)" opacity={0.6} />
          </g>
        )
      })}
      <path d={ctxLine} fill="none" stroke="var(--warn)" strokeWidth={1} opacity={0.7} />
    </svg>
  )
}

export function Sparkline({ values }: { values: number[] }) {
  if (!values.length) return null
  const W = 64, H = 20
  const max = Math.max(...values, 0.001)
  const x = (i: number) => (i / (values.length - 1)) * W
  const y = (v: number) => H - (v / max) * H
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(v)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="sparkline" aria-hidden>
      <path d={d} fill="none" stroke="var(--accent)" strokeWidth={1.5} />
    </svg>
  )
}

export function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="legend-swatch">
      <span style={{ background: color, width: 10, height: 10, display: 'inline-block', borderRadius: 2 }} />
      {label}
    </span>
  )
}
