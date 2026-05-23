export const fmt = {
  usd: (v: number | null | undefined) => {
    if (v == null) return '$—'
    if (v < 0.01) return `$${v.toFixed(4)}`
    if (v < 1) return `$${v.toFixed(3)}`
    return `$${v.toFixed(2)}`
  },

  n: (v: number | null | undefined) => {
    if (v == null) return '—'
    return new Intl.NumberFormat().format(Math.round(v))
  },

  k: (v: number | null | undefined) => {
    if (v == null) return '—'
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
    return String(Math.round(v))
  },

  pct: (v: number | null | undefined) => {
    if (v == null) return '—'
    return `${(v * 100).toFixed(1)}%`
  },

  date: (v: string | Date | null | undefined) => {
    if (!v) return '—'
    return new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  },

  time: (v: string | Date | null | undefined) => {
    if (!v) return '—'
    return new Date(v).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  },

  duration: (startTs: string | Date | null, endTs: string | Date | null) => {
    if (!startTs || !endTs) return '—'
    const ms = new Date(endTs).getTime() - new Date(startTs).getTime()
    if (ms < 0) return '—'
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ${s % 60}s`
    const h = Math.floor(m / 60)
    return `${h}h ${m % 60}m`
  },
}
