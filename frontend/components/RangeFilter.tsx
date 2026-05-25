'use client'

import { useRouter, useSearchParams, usePathname } from 'next/navigation'

const RANGES = [
  { key: 'today', label: 'Today' },
  { key: '7d',    label: '7 days' },
  { key: '30d',   label: '30 days' },
  { key: 'all',   label: 'All time' },
] as const

export function RangeFilter({ current }: { current: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function go(range: string) {
    const next = new URLSearchParams(params?.toString() ?? '')
    next.set('range', range)
    router.push(`${pathname}?${next.toString()}`)
  }

  return (
    <div className="range-filter">
      {RANGES.map(r => (
        <button
          key={r.key}
          className={`range-pill${current === r.key ? ' is-active' : ''}`}
          onClick={() => go(r.key)}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}
