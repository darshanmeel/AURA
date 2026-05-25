import React from 'react'
import { fmt } from '../lib/fmt'

interface SpendPace {
  today_cost: number | null
  today_pace_hourly: number | null
  avg_30d_cost: number | null
  avg_30d_turns: number | null
  avg_30d_tools: number | null
  today_turn_count: number | null
  hours_elapsed_today: number | null
}

interface BurnRateProps {
  pace: SpendPace | null
}

export function BurnRate({ pace }: BurnRateProps) {
  if (!pace) {
    return (
      <div className="burn-rate">
        <span className="burn-label">Today</span>
        <span className="burn-value">—</span>
      </div>
    )
  }

  const todayCost = pace.today_cost ?? 0
  const paceDayProjected = (pace.today_pace_hourly ?? 0) * 24
  const avg30d = pace.avg_30d_cost ?? 0

  // Alert if today's projected pace > 30d avg by more than 50%
  const isHot = avg30d > 0 && paceDayProjected > avg30d * 1.5
  const isCool = avg30d > 0 && paceDayProjected <= avg30d

  const paceColorStyle: React.CSSProperties = isHot
    ? { color: 'var(--warn)' }
    : isCool
    ? { color: 'var(--accent)' }
    : { color: 'var(--ink-2)' }

  return (
    <div className="burn-rate">
      <span className="burn-label">Today</span>
      <span className="burn-sep">·</span>
      <span className="burn-value">{fmt.usd(todayCost)}</span>
      <span className="burn-sep">·</span>
      <span className="burn-item">
        pace{' '}
        <span className="burn-pace" style={paceColorStyle}>
          {fmt.usd(paceDayProjected)}/day
        </span>
        {isHot && <span className="burn-badge burn-badge-hot">hot</span>}
        {isCool && <span className="burn-badge burn-badge-calm">on pace</span>}
      </span>
      <span className="burn-sep">·</span>
      <span className="burn-item">
        vs. 30d avg <span className="burn-avg">{fmt.usd(avg30d)}/day</span>
      </span>
    </div>
  )
}
