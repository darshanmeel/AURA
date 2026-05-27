'use client'

import React, { useEffect, useState, useCallback } from 'react'
import { Eyebrow, Rule, StatBlock } from '../../../components/atoms'

// ---------------------------------------------------------------------------
// Types (mirroring lib/queries/observability.ts shapes from the API)
// ---------------------------------------------------------------------------

interface DbtModelResult {
  model: string
  unique_id: string
  status: string
  execution_time: number | null
  message: string | null
  materialization: string | null
}

interface DbtSourceFreshness {
  source: string
  table: string
  status: string
  max_loaded_at: string | null
  snapshotted_at: string | null
  age_seconds: number | null
}

interface DbtHealth {
  last_run_ts: string | null
  last_run_status: 'success' | 'failure' | 'unknown'
  last_run_duration_s: number | null
  models_total: number
  models_pass: number
  models_fail: number
  per_model: DbtModelResult[]
  source_freshness: DbtSourceFreshness[]
}

interface DbtArtifacts {
  run_results: unknown | null
  sources: unknown | null
  last_modified: string | null
}

interface ApiResponse {
  dbt: (DbtHealth & { error?: string }) | null
  artifacts: (DbtArtifacts & { error?: string }) | null
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function formatAge(seconds: number | null): string {
  if (seconds == null) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${h}h ${m}m`
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—'
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return `${Math.round(diff)}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return (
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' +
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
  )
}

type StatusColorScheme = {
  bg: string
  text: string
  border: string
}

function statusColor(status: string): StatusColorScheme {
  const s = (status ?? '').toLowerCase()
  if (s === 'success' || s === 'pass') {
    return { bg: 'var(--green-bg, #052e16)', text: 'var(--green-text, #4ade80)', border: 'var(--green-border, #166534)' }
  }
  if (s === 'warn' || s === 'warning') {
    return { bg: 'var(--amber-bg, #1c1100)', text: 'var(--amber-text, #fbbf24)', border: 'var(--amber-border, #92400e)' }
  }
  if (s === 'error' || s === 'fail') {
    return { bg: 'var(--red-bg, #1c0000)', text: 'var(--red-text, #f87171)', border: 'var(--red-border, #7f1d1d)' }
  }
  if (s === 'runtime error') {
    return { bg: '#1a0000', text: '#ef4444', border: '#450a0a' }
  }
  if (s === 'skipped') {
    return { bg: 'var(--rule)', text: 'var(--muted)', border: 'var(--rule-strong)' }
  }
  return { bg: 'var(--rule)', text: 'var(--muted)', border: 'var(--rule-strong)' }
}

function StatusPill({ status }: { status: string }) {
  const c = statusColor(status)
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 8px',
      borderRadius: 3,
      fontSize: 11,
      fontFamily: 'var(--mono)',
      fontWeight: 600,
      letterSpacing: '0.04em',
      background: c.bg,
      color: c.text,
      border: `1px solid ${c.border}`,
    }}>
      {status}
    </span>
  )
}

function shortModelName(uniqueId: string): string {
  if (!uniqueId) return '—'
  const parts = uniqueId.split('.')
  return parts[parts.length - 1] ?? uniqueId
}

// Status sort priority: errors first, then warn, then others, then success/skipped
function modelStatusPriority(status: string): number {
  const s = (status ?? '').toLowerCase()
  if (s === 'error' || s === 'fail') return 0
  if (s === 'runtime error') return 1
  if (s === 'warn' || s === 'warning') return 2
  if (s === 'success' || s === 'pass') return 4
  if (s === 'skipped') return 5
  return 3
}

function freshnessPriority(status: string): number {
  const s = (status ?? '').toLowerCase()
  if (s === 'runtime error') return 0
  if (s === 'error') return 1
  if (s === 'warn') return 2
  if (s === 'pass') return 3
  return 4
}

type FilterChip = 'All' | 'Failed' | 'Success' | 'Skipped'

// ---------------------------------------------------------------------------
// Collapsible raw artifact panel
// ---------------------------------------------------------------------------

function ArtifactPanel({ title, data }: { title: string; data: unknown | null }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ borderTop: '1px solid var(--rule)', marginTop: 8 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: '10px 0',
          fontFamily: 'var(--mono)',
          fontSize: 12,
          color: 'var(--muted)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 10 }}>{open ? '▼' : '▶'}</span>
        {title}
        {data == null && <span style={{ color: 'var(--muted)', opacity: 0.5 }}>(not available)</span>}
      </button>
      {open && (
        <pre style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          background: 'var(--rule)',
          border: '1px solid var(--rule-strong)',
          borderRadius: 4,
          padding: '12px 16px',
          maxHeight: 400,
          overflowY: 'auto',
          overflowX: 'auto',
          color: 'var(--ink-2)',
          margin: '0 0 8px 0',
          whiteSpace: 'pre',
        }}>
          {data != null ? JSON.stringify(data, null, 2) : 'null'}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Expandable model row (shows error message on click)
// ---------------------------------------------------------------------------

function ModelRow({ m }: { m: DbtModelResult }) {
  const [expanded, setExpanded] = useState(false)
  const hasError = !!m.message && m.status !== 'success' && m.status !== 'skipped'
  const displayName = m.model || shortModelName(m.unique_id)

  return (
    <>
      <tr
        onClick={() => hasError && setExpanded(e => !e)}
        style={{ cursor: hasError ? 'pointer' : 'default' }}
        title={hasError ? 'Click to expand error' : undefined}
      >
        <td className="mono" style={{ fontSize: 12 }}>
          {hasError && (
            <span style={{ marginRight: 6, fontSize: 10, color: 'var(--muted)' }}>
              {expanded ? '▼' : '▶'}
            </span>
          )}
          {displayName}
        </td>
        <td style={{ fontSize: 11 }}>
          {m.materialization
            ? <span style={{ fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{m.materialization}</span>
            : <span className="muted">—</span>}
        </td>
        <td><StatusPill status={m.status} /></td>
        <td className="num mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
          {formatDuration(m.execution_time)}
        </td>
        <td className="mono" style={{ fontSize: 11, color: 'var(--muted-2, var(--muted))', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {m.message
            ? m.message.slice(0, 80) + (m.message.length > 80 ? '…' : '')
            : <span style={{ opacity: 0.4 }}>—</span>}
        </td>
      </tr>
      {expanded && m.message && (
        <tr>
          <td colSpan={5} style={{ padding: '0 0 8px 24px' }}>
            <pre style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              background: '#1a0000',
              border: '1px solid #7f1d1d',
              borderRadius: 4,
              padding: '10px 14px',
              color: '#f87171',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              margin: 0,
              maxHeight: 240,
              overflowY: 'auto',
            }}>
              {m.message}
            </pre>
          </td>
        </tr>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Main page client component
// ---------------------------------------------------------------------------

export function DbtPageClient() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastFetch, setLastFetch] = useState<Date | null>(null)
  const [filter, setFilter] = useState<FilterChip>('All')

  const fetchData = useCallback(() => {
    fetch('/api/observability?view=dbt')
      .then(r => r.json())
      .then((d: ApiResponse) => {
        setData(d)
        setLastFetch(new Date())
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    fetchData()
    const id = setInterval(fetchData, 30_000)
    return () => clearInterval(id)
  }, [fetchData])

  const dbt = data?.dbt
  const artifacts = data?.artifacts

  // ── Derived: per-model sorted and filtered ─────────────────────────────────
  const allModels: DbtModelResult[] = dbt?.per_model ?? []
  const sortedModels = [...allModels].sort(
    (a, b) => modelStatusPriority(a.status) - modelStatusPriority(b.status)
  )
  const filteredModels = sortedModels.filter(m => {
    if (filter === 'All') return true
    if (filter === 'Failed') return m.status === 'error' || m.status === 'fail' || m.status === 'runtime error'
    if (filter === 'Success') return m.status === 'success'
    if (filter === 'Skipped') return m.status === 'skipped'
    return true
  })

  const filterCounts: Record<FilterChip, number> = {
    All: allModels.length,
    Failed: allModels.filter(m => m.status === 'error' || m.status === 'fail' || m.status === 'runtime error').length,
    Success: allModels.filter(m => m.status === 'success').length,
    Skipped: allModels.filter(m => m.status === 'skipped').length,
  }

  // ── Derived: source freshness sorted ──────────────────────────────────────
  const sortedFreshness = [...(dbt?.source_freshness ?? [])].sort((a, b) => {
    const pd = freshnessPriority(a.status) - freshnessPriority(b.status)
    if (pd !== 0) return pd
    return (b.age_seconds ?? 0) - (a.age_seconds ?? 0)
  })

  // ── Run status display ─────────────────────────────────────────────────────
  const runStatus = dbt?.last_run_status ?? 'unknown'
  const anyFail = (dbt?.models_fail ?? 0) > 0
  const modelsColor = anyFail ? '#f87171' : '#4ade80'

  return (
    <div className="page-layout">
      {/* ── BREADCRUMB / NAV STRAP ─────────────────────────────────────── */}
      <section className="masthead-strap">
        <Eyebrow>
          <a href="/observability" className="inline-link" style={{ textDecoration: 'none', color: 'inherit', opacity: 0.7 }}>
            Observability
          </a>
          {' '}›{' '}
          <span>dbt</span>
        </Eyebrow>
        <div className="strap-right">
          <span className="strap-pill is-muted" suppressHydrationWarning>
            {lastFetch ? `Refreshed ${formatRelativeTime(lastFetch.toISOString())}` : 'Polling every 30s'}
          </span>
          <a href="/observability" className="strap-pill" style={{ textDecoration: 'none', color: 'var(--muted)' }}>Overview →</a>
          <a href="/observability/watcher" className="strap-pill" style={{ textDecoration: 'none', color: 'var(--muted)' }}>Watcher →</a>
        </div>
      </section>

      {/* ── PAGE HERO ─────────────────────────────────────────────────── */}
      <section className="page-head">
        <Eyebrow>dbt transformation layer</Eyebrow>
        <h1 className="display display-sm">
          Model <em>health.</em>
        </h1>
        <p className="hero-lede">
          {loading
            ? 'Loading dbt run results…'
            : dbt == null
              ? 'dbt artifacts not found — run_results.json has not been written yet.'
              : `${dbt.models_total} model${dbt.models_total !== 1 ? 's' : ''} · ${dbt.models_pass} passed · ${dbt.models_fail} failed · last run ${formatRelativeTime(dbt.last_run_ts)}.`
          }
        </p>
      </section>

      <Rule weight="thick" />

      {/* ── 4-CARD STATUS STRIP ───────────────────────────────────────── */}
      <section className="strip strip-tight">
        {/* Last run */}
        <div className="stat">
          <div className="stat-label">Last run</div>
          <div className="stat-value" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <StatusPill status={runStatus} />
          </div>
          <div className="stat-foot" suppressHydrationWarning>
            {dbt?.last_run_ts ? formatRelativeTime(dbt.last_run_ts) : 'never'}
          </div>
        </div>

        {/* Duration */}
        <StatBlock
          label="Duration"
          value={formatDuration(dbt?.last_run_duration_s ?? null)}
          footnote={dbt?.last_run_ts
            ? formatTimestamp(dbt.last_run_ts)
            : 'no run yet'}
        />

        {/* Models */}
        <div className="stat">
          <div className="stat-label">Models</div>
          <div className="stat-value">
            <span style={{ color: modelsColor, fontVariantNumeric: 'tabular-nums' }}>
              {dbt?.models_pass ?? '—'}
            </span>
            <span className="muted" style={{ fontSize: '0.6em', margin: '0 4px' }}>/</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              {dbt?.models_total ?? '—'}
            </span>
          </div>
          <div className="stat-foot" style={{ color: anyFail ? '#f87171' : 'var(--muted)' }}>
            {anyFail ? `${dbt?.models_fail} failed` : 'all passed'}
          </div>
        </div>

        {/* Artifacts updated */}
        <div className="stat">
          <div className="stat-label">Artifacts updated</div>
          <div className="stat-value" suppressHydrationWarning>
            {formatRelativeTime(artifacts?.last_modified ?? null)}
          </div>
          <div className="stat-foot" suppressHydrationWarning>
            {artifacts?.last_modified ? formatTimestamp(artifacts.last_modified) : 'no artifact file'}
          </div>
        </div>
      </section>

      <Rule />

      {/* ── SOURCE FRESHNESS TABLE ────────────────────────────────────── */}
      <section>
        <div className="section-head">
          <h2 className="h-section">Source freshness</h2>
          <span className="section-meta">
            {sortedFreshness.length} source{sortedFreshness.length !== 1 ? 's' : ''}
          </span>
        </div>
        <table className="ledger" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Source</th>
              <th>Table</th>
              <th>Status</th>
              <th>Max loaded at</th>
              <th>Age</th>
              <th>Snapshotted at</th>
            </tr>
          </thead>
          <tbody>
            {sortedFreshness.map((sf, i) => (
              <tr key={i}>
                <td className="mono" style={{ fontSize: 12 }}>{sf.source}</td>
                <td className="mono" style={{ fontSize: 12 }}>{sf.table}</td>
                <td><StatusPill status={sf.status} /></td>
                <td className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                  <div suppressHydrationWarning>{formatRelativeTime(sf.max_loaded_at)}</div>
                  <div style={{ opacity: 0.5, fontSize: 10 }} suppressHydrationWarning>
                    {formatTimestamp(sf.max_loaded_at)}
                  </div>
                </td>
                <td className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {formatAge(sf.age_seconds)}
                </td>
                <td className="mono" style={{ fontSize: 11, color: 'var(--muted)' }} suppressHydrationWarning>
                  {formatTimestamp(sf.snapshotted_at)}
                </td>
              </tr>
            ))}
            {sortedFreshness.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  {loading
                    ? 'Loading…'
                    : 'No source freshness data — run dbt source freshness to populate sources.json.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <Rule />

      {/* ── PER-MODEL STATUS TABLE ────────────────────────────────────── */}
      <section>
        <div className="section-head">
          <h2 className="h-section">Per-model status</h2>
          <span className="section-meta">
            <span style={{
              display: 'inline-block',
              padding: '1px 7px',
              borderRadius: 10,
              background: 'var(--rule)',
              fontSize: 11,
              fontFamily: 'var(--mono)',
              marginLeft: 4,
            }}>
              {filteredModels.length}
            </span>
          </span>
        </div>

        {/* Filter chips */}
        <div className="chip-row" style={{ marginBottom: 12 }}>
          {(['All', 'Failed', 'Success', 'Skipped'] as FilterChip[]).map(chip => (
            <button
              key={chip}
              className={`chip${filter === chip ? ' is-active' : ''}`}
              onClick={() => setFilter(chip)}
            >
              {chip}
              <span className="chip-count">{filterCounts[chip]}</span>
            </button>
          ))}
        </div>

        <table className="ledger" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>Model</th>
              <th>Materialization</th>
              <th>Status</th>
              <th className="num">Duration</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {filteredModels.map((m, i) => (
              <ModelRow key={m.unique_id || i} m={m} />
            ))}
            {filteredModels.length === 0 && (
              <tr>
                <td colSpan={5} className="empty">
                  {loading
                    ? 'Loading…'
                    : filter === 'All'
                      ? 'No model results — dbt has not run yet.'
                      : `No models matching "${filter}".`}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <Rule />

      {/* ── RAW ARTIFACTS (collapsed) ─────────────────────────────────── */}
      <section>
        <div className="section-head">
          <h2 className="h-section">Raw artifacts</h2>
          <span className="section-meta">collapsed by default · for deep debugging</span>
        </div>
        <ArtifactPanel title="View raw run_results.json" data={artifacts?.run_results ?? null} />
        <ArtifactPanel title="View raw sources.json" data={artifacts?.sources ?? null} />
      </section>
    </div>
  )
}
