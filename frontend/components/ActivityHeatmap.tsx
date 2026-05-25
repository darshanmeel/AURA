'use client'
import React, { useState } from 'react'
import { fmt } from '../lib/fmt'

interface HourlyRow {
  day_of_week: number
  hour_of_day: number
  turn_count: number
  total_cost: number
  session_starts: number
}

type Metric = 'cost' | 'turns' | 'sessions'

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const HOURS = Array.from({ length: 24 }, (_, i) => i)

interface ActivityHeatmapProps {
  data: HourlyRow[]
}

function cellValue(row: HourlyRow | undefined, metric: Metric): number {
  if (!row) return 0
  if (metric === 'cost') return row.total_cost ?? 0
  if (metric === 'turns') return row.turn_count ?? 0
  return row.session_starts ?? 0
}

function formatCell(v: number, metric: Metric): string {
  if (v === 0) return '—'
  if (metric === 'cost') return fmt.usd(v)
  return fmt.n(v)
}

export function ActivityHeatmap({ data }: ActivityHeatmapProps) {
  const [metric, setMetric] = useState<Metric>('cost')

  // Index rows by [day][hour] for O(1) lookup
  const grid: (HourlyRow | undefined)[][] = Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) =>
      data.find(r => r.day_of_week === d && r.hour_of_day === h)
    )
  )

  // Max value across all cells for normalizing intensity
  const maxVal = data.reduce((m, r) => Math.max(m, cellValue(r, metric)), 0)

  const metricChips: { key: Metric; label: string }[] = [
    { key: 'cost', label: 'Cost' },
    { key: 'turns', label: 'Turns' },
    { key: 'sessions', label: 'Sessions' },
  ]

  return (
    <div className="heatmap-wrap">
      <div className="section-head">
        <h2 className="h-section">Activity — <em>by hour</em></h2>
        <div className="heatmap-chips">
          {metricChips.map(c => (
            <button
              key={c.key}
              className={`range-pill${metric === c.key ? ' is-active' : ''}`}
              onClick={() => setMetric(c.key)}
              type="button"
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div className="heatmap-grid-wrap">
        {/* Hour axis labels */}
        <div className="heatmap-axis-row">
          <div className="heatmap-day-label" />
          {HOURS.map(h => (
            <div key={h} className="heatmap-hour-label">
              {h % 3 === 0 ? `${String(h).padStart(2, '0')}` : ''}
            </div>
          ))}
        </div>
        {/* Grid rows */}
        {DAY_LABELS.map((day, d) => (
          <div key={d} className="heatmap-row">
            <div className="heatmap-day-label">{day}</div>
            {HOURS.map(h => {
              const row = grid[d][h]
              const v = cellValue(row, metric)
              const intensity = maxVal > 0 ? v / maxVal : 0
              return (
                <div
                  key={h}
                  className="heatmap-cell"
                  title={`${day} ${String(h).padStart(2, '0')}:00 UTC — ${formatCell(v, metric)}`}
                  style={{
                    opacity: intensity === 0 ? 0.12 : 0.18 + intensity * 0.82,
                    background: intensity === 0
                      ? 'var(--rule)'
                      : `rgba(217, 183, 135, ${0.15 + intensity * 0.85})`,
                  }}
                />
              )
            })}
          </div>
        ))}
        {/* UTC note */}
        <div className="heatmap-foot">
          Hours in UTC · {data.length === 0 ? 'No data — fact_hourly_activity pending' : `${data.filter(r => cellValue(r, metric) > 0).length} of 168 cells active`}
        </div>
      </div>
    </div>
  )
}
