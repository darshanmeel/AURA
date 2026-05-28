'use client'

import React from 'react'
import { fmt } from '../lib/fmt'

// Token-type stacked-bar chart. Generic across "by type" (5 series) and
// "by model"/"by provider" (variable series count, max ~10 before clutter).
// SVG renders responsively via viewBox; no chart library to keep bundle small
// and the visual matches TurnChart in SessionTabs.

export interface StackSegment {
  key: string
  label: string
  color: string
}

export interface ChartRow {
  // Bucket key, formatted by the caller (e.g. ISO ts or 'YYYY-MM-DD HH').
  bucket_ts: string | Date
  // Each row carries one numeric value per StackSegment.key.
  [k: string]: any
}

export function TokenSeriesChart({
  rows, segments, height = 240, hourly,
}: {
  rows: ChartRow[]
  segments: StackSegment[]
  height?: number
  hourly: boolean
}) {
  if (!rows.length) {
    return <div className="empty-block">No token data in this range.</div>
  }
  // BigInt → Number for arithmetic; rows come straight from DuckDB.
  const tot = (r: ChartRow) =>
    segments.reduce((a, s) => a + Number(r[s.key] ?? 0), 0)

  const w = 1200, pad = { l: 56, r: 16, t: 12, b: 32 }
  const innerW = w - pad.l - pad.r
  const innerH = height - pad.t - pad.b
  const n = rows.length
  const colW = innerW / n
  const barW = Math.max(2, colW * 0.68)

  const maxY = Math.max(...rows.map(tot), 1)

  const fmtBucket = (ts: string | Date): string => {
    const d = new Date(ts as any)
    return hourly
      ? `${String(d.getHours()).padStart(2, '0')}:00`
      : d.toLocaleDateString(undefined, { month: 'short', day: '2-digit' })
  }

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${w} ${height}`} className="chart" preserveAspectRatio="none">
        {/* Y-axis grid + labels */}
        {[0.25, 0.5, 0.75, 1].map(g => (
          <line key={g}
            x1={pad.l} x2={w - pad.r}
            y1={pad.t + innerH * (1 - g)} y2={pad.t + innerH * (1 - g)}
            stroke="var(--rule)" strokeWidth="0.5" strokeDasharray="2,3"
          />
        ))}
        {[0, 0.5, 1].map(g => (
          <text key={g}
            x={pad.l - 8} y={pad.t + innerH * (1 - g) + 3}
            textAnchor="end" fontSize={10} fill="var(--muted)"
          >
            {fmt.k(maxY * g)}
          </text>
        ))}

        {/* Stacked bars */}
        {rows.map((r, i) => {
          const x = pad.l + colW * i + (colW - barW) / 2
          let yCursor = pad.t + innerH
          return (
            <g key={i}>
              {segments.map(seg => {
                const v = Number(r[seg.key] ?? 0)
                if (v <= 0) return null
                const segH = (v / maxY) * innerH
                yCursor -= segH
                return (
                  <rect key={seg.key}
                    x={x} y={yCursor}
                    width={barW} height={Math.max(segH, 0)}
                    fill={seg.color}
                  >
                    <title>{`${seg.label}: ${fmt.n(v)}`}</title>
                  </rect>
                )
              })}
            </g>
          )
        })}

        {/* X-axis bucket labels — render every Nth so they don't overlap */}
        {rows.map((r, i) => {
          const stride = Math.max(1, Math.ceil(n / 14))
          if (i % stride !== 0 && i !== n - 1) return null
          return (
            <text key={i}
              x={pad.l + colW * (i + 0.5)} y={height - 12}
              textAnchor="middle" fontSize={10} fill="var(--muted)"
              fontFamily="var(--mono)"
            >
              {fmtBucket(r.bucket_ts)}
            </text>
          )
        })}
      </svg>

      {/* Legend */}
      <div className="chart-legend" style={{
        display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 8, fontSize: 12,
      }}>
        {segments.map(seg => (
          <div key={seg.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: seg.color }} />
            <span style={{ color: 'var(--muted)' }}>{seg.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Convenience preset for the dashboard's main 5-type chart.
export const TOKEN_TYPE_SEGMENTS: StackSegment[] = [
  { key: 'cache_read',   label: 'Cache read',  color: 'var(--muted-bar, #6b6b6b)' },
  { key: 'cache_5m',     label: 'Cache 5m',    color: 'var(--ink-2, #d0c8b8)' },
  { key: 'cache_1h',     label: 'Cache 1h',    color: 'var(--accent, #ef8232)' },
  { key: 'output_tokens',label: 'Output',      color: 'var(--ink, #faf4e7)' },
  { key: 'input_tokens', label: 'Input',       color: 'var(--accent-2, #efe6d6)' },
]

// Pivot a long-form list of (bucket_ts, dim, value) rows into wide rows
// keyed by dim values. dimKey = column name carrying the dim (e.g. 'model').
export function pivotByDim(
  rows: any[], dimKey: string, valueKey: string,
): { rows: ChartRow[]; segments: StackSegment[] } {
  const buckets = new Map<string, ChartRow>()
  const dims = new Set<string>()
  for (const r of rows) {
    const key = String(r.bucket_ts)
    const dim = String(r[dimKey] ?? 'unknown')
    dims.add(dim)
    const existing = buckets.get(key)
    if (existing) {
      existing[dim] = Number(existing[dim] ?? 0) + Number(r[valueKey] ?? 0)
    } else {
      buckets.set(key, { bucket_ts: r.bucket_ts, [dim]: Number(r[valueKey] ?? 0) })
    }
  }
  // Rank dims by total (so the legend reads dominant → trace).
  // Array.from() — tsconfig target doesn't allow `for…of` on Set / Map.values()
  // iterators directly (would need --downlevelIteration or target >= es2015).
  const dimList = Array.from(dims)
  const totals = new Map<string, number>()
  dimList.forEach(d => totals.set(d, 0))
  Array.from(buckets.values()).forEach(r => {
    dimList.forEach(d => totals.set(d, (totals.get(d) ?? 0) + Number(r[d] ?? 0)))
  })
  const sortedDims = dimList.sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))

  // Stable-ish palette for up to 10 series.
  const PALETTE = [
    'var(--accent, #ef8232)',
    'var(--accent-2, #efe6d6)',
    'var(--ink, #faf4e7)',
    'var(--ink-2, #d0c8b8)',
    '#4caf82',
    '#5e94d9',
    '#c46acc',
    '#e8c547',
    '#6b6b6b',
    '#a06650',
  ]
  const segments: StackSegment[] = sortedDims.map((d, i) => ({
    key: d, label: d, color: PALETTE[i % PALETTE.length],
  }))
  // Sort buckets chronologically.
  const wide = Array.from(buckets.values()).sort((a, b) =>
    new Date(a.bucket_ts as any).getTime() - new Date(b.bucket_ts as any).getTime()
  )
  return { rows: wide, segments }
}
