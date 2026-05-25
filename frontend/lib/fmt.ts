// Coerce BigInt → Number at the formatter boundary. DuckDB HUGEINT/BIGINT
// columns sometimes arrive as BigInt despite lib/db.ts converting top-level
// values — nested structs or array element fields slip through, and any
// arithmetic mixing BigInt with Number (Math.round, /1000, .toFixed) throws
// "Cannot mix BigInt and other types". Doing the coercion here means every
// callsite is safe without per-site Number() wrapping.
function num(v: number | bigint | null | undefined): number | null {
  if (v == null) return null
  return typeof v === 'bigint' ? Number(v) : v
}

export const fmt = {
  usd: (v: number | bigint | null | undefined) => {
    const n = num(v)
    if (n == null) return '$—'
    if (n < 0.01) return `$${n.toFixed(4)}`
    if (n < 1) return `$${n.toFixed(3)}`
    return `$${n.toFixed(2)}`
  },

  n: (v: number | bigint | null | undefined) => {
    const x = num(v)
    if (x == null) return '—'
    return new Intl.NumberFormat().format(Math.round(x))
  },

  k: (v: number | bigint | null | undefined) => {
    const x = num(v)
    if (x == null) return '—'
    if (x >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}M`
    if (x >= 1_000) return `${(x / 1_000).toFixed(1)}k`
    return String(Math.round(x))
  },

  pct: (v: number | bigint | null | undefined) => {
    const x = num(v)
    if (x == null) return '—'
    return `${(x * 100).toFixed(1)}%`
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
