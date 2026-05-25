export type RangeKey = 'today' | '7d' | '30d' | 'all'

export function parseRange(raw: string | string[] | undefined): RangeKey {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (v === '7d' || v === '30d' || v === 'all') return v
  return 'today' // default
}

/** ISO string for the start of the range, or null for 'all' (no filter) */
export function rangeSince(key: RangeKey): string | null {
  const now = new Date()
  if (key === 'all') return null
  const d = new Date(now)
  if (key === 'today') {
    d.setHours(0, 0, 0, 0)
  } else if (key === '7d') {
    d.setDate(d.getDate() - 7)
  } else if (key === '30d') {
    d.setDate(d.getDate() - 30)
  }
  return d.toISOString()
}

export function rangeLabel(key: RangeKey): string {
  return key === 'today' ? 'today' : key === '7d' ? '7 days' : key === '30d' ? '30 days' : 'all time'
}
