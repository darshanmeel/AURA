// Pure helper functions shared between the Watcher server page and its
// client-side polling component. No server-only imports (no 'fs', no 'db').

export function formatBytes(n: number | null | undefined): string {
  if (n == null || n === 0) return '0 B'
  const abs = Math.abs(n)
  if (abs >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`
  if (abs >= 1_048_576)     return `${(n / 1_048_576).toFixed(1)} MB`
  if (abs >= 1_024)         return `${(n / 1_024).toFixed(1)} KB`
  return `${Math.round(n)} B`
}

export function formatAge(seconds: number | null | undefined): string {
  if (seconds == null) return '—'
  const s = Math.round(seconds)
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return `${h}h ${m}m ago`
  }
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return `${d}d ${h}h ago`
}

export function truncateMiddle(str: string | null | undefined, max: number): string {
  if (!str) return '—'
  if (str.length <= max) return str
  const half = Math.floor((max - 3) / 2)
  return str.slice(0, half) + '…' + str.slice(str.length - half)
}

export type SourceKind = 'process_file' | 'on_created' | 'snapshot' | 'session_meta' | 'dbt' | string

export function sourceTag(source: SourceKind): { bg: string; color: string; label: string } {
  switch (source) {
    case 'process_file':
      return { bg: 'rgba(217,183,135,0.12)', color: '#d9b787', label: 'process_file' }
    case 'on_created':
      return { bg: 'rgba(217,183,135,0.08)', color: '#c8a970', label: 'on_created' }
    case 'snapshot':
      return { bg: 'rgba(100,160,220,0.12)', color: '#7ab4e0', label: 'snapshot' }
    case 'session_meta':
      return { bg: 'rgba(160,200,130,0.12)', color: '#9dcc7a', label: 'session_meta' }
    case 'dbt':
      return { bg: 'rgba(217,124,94,0.15)', color: '#d97c5e', label: 'dbt' }
    default:
      return { bg: 'rgba(239,230,214,0.06)', color: '#8a7d6a', label: source || 'unknown' }
  }
}

export function bronzeStatusColor(status: string | null | undefined): string {
  switch (status) {
    case 'green':   return '#7fcf8e'
    case 'yellow':  return '#d9b787'
    case 'red':     return '#d97c5e'
    default:        return '#8a7d6a'
  }
}
