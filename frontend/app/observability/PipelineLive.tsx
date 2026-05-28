'use client'

import React, { useEffect, useMemo, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// Wire-format types (mirror lib/queries/observability.ts via the API)
// ---------------------------------------------------------------------------

type HealthLevel = 'green' | 'yellow' | 'red' | 'unknown'
type Tone = 'good' | 'warn' | 'bad' | 'mute'

interface Overall {
  bronze_latest_event: string | null
  bronze_age_seconds: number | null
  bronze_status: HealthLevel
  last_dbt_run_ts: string | null
  last_dbt_run_status: 'success' | 'failure' | 'unknown'
  dbt_status: HealthLevel
  errors_last_hour: number
  errors_last_day: number
  overall_status: HealthLevel
}

interface Watcher {
  bronze_latest_event: string | null
  bronze_age_seconds: number | null
  bronze_status: HealthLevel
  files_total: number
  total_bytes_ingested: number
  ingestion_1h: number
  ingestion_1d: number
  ingestion_7d: number
  errors_last_hour: number
  errors_last_day: number
}

interface IngestionStats {
  window: '1h' | '1d' | '7d'
  rows_ingested: number
  sessions_ingested: number
  files_seen: number
}

interface HourlyBucket { hour: string; rows: number }

interface DbtTest {
  name: string
  unique_id: string
  status: string
  execution_time_ms: number | null
  kind: string
  relation: string
}
interface DbtFreshness {
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
  per_model: Array<{ model: string; unique_id: string; status: string; execution_time: number | null; message: string | null }>
  source_freshness: DbtFreshness[]
  tests_total: number
  tests_pass: number
  tests_fail: number
  per_test: DbtTest[]
}

interface DbtArtifacts {
  run_results: unknown | null
  sources: unknown | null
  last_modified: string | null
}

interface DbtHistoryEntry {
  started_at: string
  generated_at: string
  command: string
  outcome: 'pass' | 'fail' | 'unknown'
  duration_ms: number
  models_total: number
  tests_total: number
  invocation_id: string | null
}

interface MedallionTable {
  name: string
  rows: number
  bytes: number | null
  age_seconds: number | null
  materialization: string
}
interface MedallionLayer {
  layer: 'bronze' | 'silver' | 'gold'
  role: string
  materialization: string
  status: HealthLevel
  tables: MedallionTable[]
  total_rows: number
  total_bytes: number | null
  age_seconds: number | null
  tests_pass: number
  tests_total: number
}

interface WatcherError {
  ts: string
  source: string
  file_path: string | null
  error_message: string
  stack_trace: string
}

interface Snapshot {
  overall: Overall | null
  watcher: Watcher | null
  ingestion_1h: IngestionStats | null
  ingestion_1d: IngestionStats | null
  ingestion_7d: IngestionStats | null
  hourly: HourlyBucket[]
  dbt: DbtHealth | null
  dbt_history: DbtHistoryEntry[]
  artifacts: DbtArtifacts | null
  layers: MedallionLayer[]
  errors: WatcherError[]
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—'
  return new Intl.NumberFormat('en-US').format(n)
}

function fmtBytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`
}

function fmtAgeShort(seconds: number | null | undefined): string {
  if (seconds == null) return '—'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m - h * 60}m`
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s - m * 60)}s`
}

function fmtClock(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
  } catch { return '—' }
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`
  } catch { return '—' }
}

function fmtRelativeMinutes(iso: string | null | undefined): string {
  if (!iso) return '—'
  const diff = (Date.now() - new Date(iso).getTime()) / 1000
  if (diff < 60) return `${Math.round(diff)}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// ---------------------------------------------------------------------------
// Tone mapping — single source of truth for color
// ---------------------------------------------------------------------------

function toneFromLevel(level: HealthLevel): Tone {
  if (level === 'green') return 'good'
  if (level === 'yellow') return 'warn'
  if (level === 'red') return 'bad'
  return 'mute'
}

function toneClass(t: Tone): string { return `obs-tone-${t}` }

const TONE_LABEL: Record<Tone, string> = {
  good: 'HEALTHY',
  warn: 'DEGRADED',
  bad: 'ERROR',
  mute: 'UNKNOWN',
}

// ---------------------------------------------------------------------------
// Verdict derivation
// ---------------------------------------------------------------------------

interface VerdictIssue {
  kind: Tone
  label: string
  body: string
  jump?: string
}

interface Verdict {
  state: Tone
  headline: string
  accent: string
  summary: string
  issues: VerdictIssue[]
}

function deriveVerdict(d: Snapshot): Verdict {
  const issues: VerdictIssue[] = []

  const overall = d.overall
  const bronzeAge = overall?.bronze_age_seconds ?? null
  const bronzeStatus = overall?.bronze_status ?? 'unknown'
  const errorsH = overall?.errors_last_hour ?? 0
  const testsFail = d.dbt?.tests_fail ?? 0
  const modelsFail = d.dbt?.models_fail ?? 0
  const sourceErrors = (d.dbt?.source_freshness ?? []).filter(s => s.status === 'error')
  const sourceWarns  = (d.dbt?.source_freshness ?? []).filter(s => s.status === 'warn')

  sourceErrors.forEach(s => {
    const ageMin = s.age_seconds != null ? Math.floor(s.age_seconds / 60) : null
    issues.push({
      kind: 'bad',
      label: `${s.source}.${s.table}`,
      body: ageMin != null ? `stale ${ageMin}m — exceeds freshness error threshold` : 'freshness check errored',
      jump: 'freshness',
    })
  })

  if ((bronzeStatus === 'red' || bronzeStatus === 'unknown') && (d.ingestion_1h?.rows_ingested ?? 0) === 0) {
    issues.push({
      kind: 'bad',
      label: 'watcher · raw_events',
      body: 'no rows written in the last hour — ingestion halted',
      jump: 'ingestion',
    })
  }

  if (modelsFail > 0) {
    issues.push({
      kind: 'bad',
      label: 'dbt models',
      body: `${modelsFail} model${modelsFail > 1 ? 's' : ''} failing to materialize`,
      jump: 'tests',
    })
  }
  if (testsFail > 0) {
    issues.push({
      kind: 'bad',
      label: 'dbt tests',
      body: `${testsFail} test${testsFail > 1 ? 's' : ''} failing on transforms`,
      jump: 'tests',
    })
  }

  sourceWarns.forEach(s => {
    issues.push({
      kind: 'warn',
      label: `${s.source}.${s.table}`,
      body: 'freshness drifting toward error threshold',
      jump: 'freshness',
    })
  })

  if (errorsH > 0) {
    issues.push({
      kind: 'warn',
      label: 'watcher',
      body: `${errorsH} error${errorsH > 1 ? 's' : ''} in last hour`,
      jump: 'errors',
    })
  }

  if (bronzeStatus === 'yellow' && !issues.some(i => i.kind === 'bad')) {
    issues.push({
      kind: 'warn',
      label: 'bronze · raw_events',
      body: bronzeAge != null ? `last event ${fmtAgeShort(bronzeAge)} ago — approaching warn threshold` : 'no recent activity',
      jump: 'ingestion',
    })
  }

  const hasError = issues.some(i => i.kind === 'bad')
  const hasWarn  = issues.some(i => i.kind === 'warn')

  if (hasError) {
    const first = sourceErrors[0]
    const summary = first
      ? `Source freshness for ${first.source}.${first.table} is ${fmtAgeShort(first.age_seconds ?? 0)} stale. ${(d.ingestion_1h?.rows_ingested ?? 0) === 0 ? 'Watcher has written no rows in the last hour. ' : ''}dbt: ${d.dbt?.tests_pass ?? 0} of ${d.dbt?.tests_total ?? 0} tests passing.`
      : 'One or more pipeline signals have crossed an error threshold. Diagnostics below.'
    return { state: 'bad', headline: 'Action', accent: 'required.', summary, issues }
  }
  if (hasWarn) {
    return {
      state: 'warn',
      headline: 'Drifting from',
      accent: 'nominal.',
      summary: 'One or more signals are degraded but the pipeline is still flowing. See diagnostics below.',
      issues,
    }
  }
  // Healthy
  if (overall == null) {
    return {
      state: 'mute',
      headline: 'Pipeline',
      accent: 'unknown.',
      summary: 'Snapshot unavailable — the read DB or dbt artifacts are not yet present. Waiting for first ingest and first dbt run.',
      issues: [],
    }
  }
  return {
    state: 'good',
    headline: 'All systems',
    accent: 'nominal.',
    summary: `Bronze ingestion is keeping pace, dbt tests are clean${(d.dbt?.tests_total ?? 0) > 0 ? ` (${d.dbt?.tests_pass}/${d.dbt?.tests_total})` : ''}, and no watcher errors recorded in the last hour.`,
    issues: [],
  }
}

// ---------------------------------------------------------------------------
// Atoms
// ---------------------------------------------------------------------------

function Dot({ tone, pulse = false, size = 8 }: { tone: Tone; pulse?: boolean; size?: number }) {
  return (
    <span
      className={`obs-dot ${pulse ? 'obs-dot--pulse' : ''} ${toneClass(tone)}`}
      style={{ width: size, height: size }}
    />
  )
}

function Pill({ tone, children }: { tone: Tone; children?: React.ReactNode }) {
  return (
    <span className={`obs-pill ${toneClass(tone)}`}>
      <Dot tone={tone} size={6} />
      <span>{children ?? TONE_LABEL[tone]}</span>
    </span>
  )
}

function Eyebrow({ tone = 'mute', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <div className={`obs-verdict-eyebrow ${toneClass(tone)}`}>
      <Dot tone={tone} size={5} />
      <span>{children}</span>
    </div>
  )
}

function RuleHeader({ id, label, sub }: { id?: string; label: string; sub?: string }) {
  return (
    <div id={id} className="obs-rule">
      <div className="obs-rule-inner">
        <span className="obs-rule-label">{label}</span>
        {sub && <span className="obs-rule-sub">{sub}</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function Crumb({ tone, refreshedAgo, refreshSec }: { tone: Tone; refreshedAgo: number; refreshSec: number }) {
  return (
    <div className="obs-crumb">
      <div className="obs-crumb-left">
        <Dot tone={tone} size={7} pulse={tone !== 'good'} />
        <span className="obs-crumb-path">OBSERVABILITY</span>
        <span className="obs-crumb-sep">·</span>
        <span className="obs-crumb-path" style={{ color: 'var(--muted)' }}>DATA PIPELINE</span>
      </div>
      <div className="obs-crumb-right" suppressHydrationWarning>
        <span>refreshed {refreshedAgo}s ago</span>
        <span className="obs-crumb-sep">·</span>
        <span className={`obs-live-pill ${toneClass('good')}`}>
          <Dot tone="good" size={5} pulse />
          <span>LIVE · {refreshSec}s</span>
        </span>
      </div>
    </div>
  )
}

function VerdictBlock({ verdict, timeLabel }: { verdict: Verdict; timeLabel: string }) {
  return (
    <section className={`obs-verdict ${toneClass(verdict.state)}`}>
      <Eyebrow tone={verdict.state}>PIPELINE STATUS · {timeLabel}</Eyebrow>
      <h1 className="obs-verdict-headline">
        <span>{verdict.headline}</span>
        <span className={`obs-verdict-accent ${toneClass(verdict.state)}`}>{verdict.accent}</span>
      </h1>
      <p className="obs-verdict-summary">{verdict.summary}</p>
      {verdict.issues.length > 0 && (
        <ul className="obs-verdict-list">
          {verdict.issues.map((i, idx) => (
            <li key={idx} className="obs-verdict-item">
              <span
                className="obs-verdict-mark"
                style={{ background: TONE_HEX[i.kind] }}
              />
              <span className="obs-verdict-label">{i.label}</span>
              <span className="obs-verdict-body">{i.body}</span>
            </li>
          ))}
        </ul>
      )}
      {verdict.issues.length > 0 && (
        <div className="obs-verdict-jumps">
          {verdict.issues.slice(0, 3).map((i, idx) => (
            i.jump ? <a key={idx} href={`#${i.jump}`} className="obs-jump">→ {i.label}  ↓</a> : null
          ))}
        </div>
      )}
    </section>
  )
}

const TONE_HEX: Record<Tone, string> = {
  good: '#7fcf8e',
  warn: '#e8b85c',
  bad:  '#d97c5e',
  mute: '#8a7d6a',
}

function FlowStrip({ snapshot, verdict }: { snapshot: Snapshot; verdict: Verdict }) {
  const w = snapshot.watcher
  const overall = snapshot.overall
  const dbt = snapshot.dbt
  const layers = snapshot.layers
  const silverCount = layers.find(l => l.layer === 'silver')?.tables.length ?? 0
  const goldCount   = layers.find(l => l.layer === 'gold')?.tables.length ?? 0
  const testsFailing = (dbt?.tests_fail ?? 0) > 0
  const modelsFailing = (dbt?.models_fail ?? 0) > 0

  const stages = [
    {
      id: 'watcher',
      num: '01',
      name: 'WATCHER',
      tone: (w?.bronze_age_seconds != null && w.bronze_age_seconds < 600)
        ? 'good' as Tone
        : verdict.state === 'good' ? 'good' as Tone : 'warn' as Tone,
      value: fmtNum(snapshot.ingestion_1h?.rows_ingested ?? 0),
      unit: 'rows/1h',
      note: (snapshot.ingestion_1h?.rows_ingested ?? 0) === 0
        ? 'no rows in last 1h'
        : `tail ~/.claude/projects/`,
    },
    {
      id: 'bronze',
      num: '02',
      name: 'BRONZE',
      tone: toneFromLevel(overall?.bronze_status ?? 'unknown'),
      value: w?.bronze_age_seconds != null ? fmtAgeShort(w.bronze_age_seconds) : '—',
      unit: 'age',
      note: w?.bronze_age_seconds != null
        ? `${fmtNum(w?.ingestion_1d ?? 0)} rows · 1d`
        : 'no events yet',
    },
    {
      id: 'silver',
      num: '03',
      name: 'SILVER',
      tone: testsFailing ? 'warn' as Tone : verdict.state === 'good' ? 'good' as Tone : 'warn' as Tone,
      value: silverCount,
      unit: 'stg_*',
      note: 'view refresh on read',
    },
    {
      id: 'gold',
      num: '04',
      name: 'GOLD',
      tone: testsFailing || modelsFailing ? 'bad' as Tone : verdict.state === 'good' ? 'good' as Tone : 'warn' as Tone,
      value: `${dbt?.tests_pass ?? 0}/${dbt?.tests_total ?? 0}`,
      unit: 'tests',
      note: testsFailing
        ? `${dbt?.tests_fail} failing · ${goldCount} tables`
        : `${goldCount} fact + dim · ${fmtDuration((dbt?.last_run_duration_s ?? 0) * 1000)}`,
    },
    {
      id: 'consumers',
      num: '05',
      name: 'CONSUMERS',
      tone: verdict.state === 'bad' ? 'warn' as Tone : 'good' as Tone,
      value: 6,
      unit: 'dashboards',
      note: 'Dashboard · Apps · Agents · People · Sessions · Errors',
    },
  ]

  return (
    <section className="obs-flow" aria-label="Pipeline flow">
      {stages.map((s, i) => (
        <React.Fragment key={s.id}>
          <div className={`obs-flow-stage ${s.tone === 'bad' ? 'obs-flow-stage--bad' : ''} ${toneClass(s.tone)}`}>
            <div className="obs-flow-head">
              <span className="obs-flow-num">{s.num}</span>
              <span className="obs-flow-name">{s.name}</span>
              <Dot tone={s.tone} size={7} pulse={s.tone === 'bad'} />
            </div>
            <div className="obs-flow-metric">
              <span style={s.tone === 'bad' ? { color: TONE_HEX.bad } : undefined}>{s.value}</span>
              <span className="obs-flow-unit">{s.unit}</span>
            </div>
            <div className="obs-flow-note">{s.note}</div>
          </div>
          {i < stages.length - 1 && (
            <div className="obs-flow-edge" aria-hidden>
              <svg width="100%" height="20" viewBox="0 0 100 20" preserveAspectRatio="none">
                <line
                  x1="0" y1="10" x2="100" y2="10"
                  stroke={TONE_HEX[s.tone]}
                  strokeWidth="1"
                  strokeOpacity={s.tone === 'bad' ? 0.4 : 0.7}
                  strokeDasharray={s.tone === 'bad' ? '3 3' : '0'}
                />
                <polygon points="96,6 100,10 96,14" fill={TONE_HEX[stages[i + 1].tone]} opacity={s.tone === 'bad' ? 0.4 : 0.9} />
              </svg>
            </div>
          )}
        </React.Fragment>
      ))}
    </section>
  )
}

const LAYER_TONE = { bronze: '#b07840', silver: '#bcb39a', gold: '#e6cf9e' } as const
const LAYER_ROMAN = { bronze: 'I', silver: 'II', gold: 'III' } as const

function MedallionLayers({ layers }: { layers: MedallionLayer[] }) {
  if (layers.length === 0) {
    return <div className="obs-errors-empty">No layer information available yet.</div>
  }
  return (
    <section className="obs-medallion">
      {layers.map(layer => {
        const tone = toneFromLevel(layer.status)
        return (
          <div
            key={layer.layer}
            className={`obs-layer ${layer.status === 'red' ? 'obs-layer--bad' : layer.status === 'yellow' ? 'obs-layer--warn' : ''}`}
            style={{ ['--layer-tone' as any]: LAYER_TONE[layer.layer] }}
          >
            <div className="obs-layer-head">
              <span className="obs-layer-swatch" />
              <span className="obs-layer-roman">{LAYER_ROMAN[layer.layer]}</span>
              <span className="obs-layer-name">{layer.layer[0].toUpperCase() + layer.layer.slice(1)}</span>
              <span style={{ flex: 1 }} />
              <Pill tone={tone} />
            </div>
            <div className="obs-layer-role">
              <span style={{ fontStyle: 'italic' }}>{layer.role}</span>
              <span className="obs-layer-role-sep">·</span>
              <span>{layer.materialization}</span>
            </div>

            <div className="obs-layer-stats">
              <div>
                <div className="obs-layer-stat-label">tables</div>
                <div className="obs-layer-stat-value">{layer.tables.length}</div>
              </div>
              <div>
                <div className="obs-layer-stat-label">rows</div>
                <div className="obs-layer-stat-value">{fmtNum(layer.total_rows)}</div>
              </div>
              <div>
                <div className="obs-layer-stat-label">size</div>
                <div className="obs-layer-stat-value">{layer.total_bytes != null ? fmtBytes(layer.total_bytes) : '—'}</div>
              </div>
              <div>
                <div className="obs-layer-stat-label">age</div>
                <div
                  className="obs-layer-stat-value"
                  style={layer.status === 'red' ? { color: TONE_HEX.bad } : layer.status === 'yellow' ? { color: TONE_HEX.warn } : undefined}
                >
                  {layer.age_seconds != null ? fmtAgeShort(layer.age_seconds) : '—'}
                </div>
              </div>
            </div>

            {layer.layer === 'gold' && layer.tests_total > 0 && (
              <div className="obs-layer-bar">
                <div className="obs-layer-bar-label">
                  <span>tests</span>
                  <span>
                    <span style={{ color: layer.tests_pass === layer.tests_total ? TONE_HEX.good : TONE_HEX.bad }}>{layer.tests_pass}</span>
                    <span className="obs-kpi-divider"> / </span>
                    {layer.tests_total}
                  </span>
                </div>
                <div className="obs-layer-bar-track">
                  <div
                    className="obs-layer-bar-fill"
                    style={{
                      width: `${(layer.tests_pass / layer.tests_total) * 100}%`,
                      background: layer.tests_pass === layer.tests_total ? TONE_HEX.good : TONE_HEX.bad,
                    }}
                  />
                </div>
              </div>
            )}

            <div className="obs-layer-tables">
              <div className="obs-layer-tables-head">
                <span>table</span>
                <span style={{ textAlign: 'right' }}>materialization</span>
                <span style={{ textAlign: 'right' }}>rows</span>
              </div>
              {layer.tables.slice(0, 10).map(t => (
                <div key={t.name} className="obs-layer-table-row">
                  <span className="obs-layer-table-name">{t.name}</span>
                  <span className="obs-layer-table-mat">{t.materialization}</span>
                  <span className="obs-layer-table-rows">{fmtNum(t.rows)}</span>
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </section>
  )
}

function KpiGrid({ snapshot, verdict }: { snapshot: Snapshot; verdict: Verdict }) {
  void verdict
  const w = snapshot.watcher
  const dbt = snapshot.dbt
  const overall = snapshot.overall
  const fresh = (dbt?.source_freshness ?? [])[0] ?? null
  const ageStr = fresh?.age_seconds != null ? fmtAgeShort(fresh.age_seconds) : '—'

  const errorsH = w?.errors_last_hour ?? 0
  const errorsD = w?.errors_last_day ?? 0
  const testsFail = dbt?.tests_fail ?? 0
  const bronzeTone = toneFromLevel(overall?.bronze_status ?? 'unknown')
  const dbtTone: Tone = testsFail > 0 ? 'bad' : (dbt?.tests_total ?? 0) === 0 ? 'mute' : 'good'

  return (
    <section className="obs-kpis">
      <div className="obs-kpi-col">
        <div className="obs-kpi-head">
          <span className="obs-kpi-head-label">WATCHER</span>
          <Pill tone={toneFromLevel(overall?.bronze_status ?? 'unknown')} />
        </div>
        <div className="obs-kpi">
          <div className="obs-kpi-label">files watched</div>
          <div className="obs-kpi-value">{fmtNum(w?.files_total ?? 0)}</div>
          <div className="obs-kpi-sub">checkpointed JSONL files</div>
        </div>
        <div className="obs-kpi">
          <div className="obs-kpi-label">bytes ingested</div>
          <div className="obs-kpi-value">{fmtBytes(w?.total_bytes_ingested ?? 0)}</div>
          <div className="obs-kpi-sub">sum of last_offset across checkpoints</div>
        </div>
        <div className="obs-kpi">
          <div className="obs-kpi-label">errors · 1h</div>
          <div className="obs-kpi-value" style={errorsH > 0 ? { color: TONE_HEX.bad } : undefined}>{errorsH}</div>
          <div className="obs-kpi-sub">{errorsD} today</div>
        </div>
      </div>

      <div className="obs-kpi-col">
        <div className="obs-kpi-head">
          <span className="obs-kpi-head-label">BRONZE</span>
          <Pill tone={bronzeTone}>{bronzeTone === 'good' ? 'FRESH' : bronzeTone === 'warn' ? 'WARN' : bronzeTone === 'bad' ? 'STALE' : 'UNKNOWN'}</Pill>
        </div>
        <div className="obs-kpi">
          <div className="obs-kpi-label">raw_events age</div>
          <div className="obs-kpi-value" style={{ color: bronzeTone === 'good' ? undefined : TONE_HEX[bronzeTone] }}>{ageStr}</div>
          <div className="obs-kpi-sub">
            {fresh?.age_seconds != null && fresh?.status === 'error'
              ? `+${fmtAgeShort(fresh.age_seconds - 1800)} past error`
              : 'within thresholds'}
          </div>
        </div>
        <div className="obs-kpi">
          <div className="obs-kpi-label">rows · 1h</div>
          <div className="obs-kpi-value">{fmtNum(snapshot.ingestion_1h?.rows_ingested ?? 0)}</div>
          <div className="obs-kpi-sub">
            {(snapshot.ingestion_1h?.rows_ingested ?? 0) === 0 ? 'no events ingested' : 'rows written to raw_events'}
          </div>
        </div>
        <div className="obs-kpi">
          <div className="obs-kpi-label">rows · 7d</div>
          <div className="obs-kpi-value">{fmtNum(snapshot.ingestion_7d?.rows_ingested ?? 0)}</div>
          <div className="obs-kpi-sub">7-day rolling sum</div>
        </div>
      </div>

      <div className="obs-kpi-col">
        <div className="obs-kpi-head">
          <span className="obs-kpi-head-label">dbt</span>
          <Pill tone={dbtTone}>{testsFail === 0 ? (dbt?.tests_total ? 'PASSING' : 'IDLE') : `${testsFail} FAILING`}</Pill>
        </div>
        <div className="obs-kpi">
          <div className="obs-kpi-label">tests</div>
          <div className="obs-kpi-value">
            <span style={{ color: testsFail === 0 ? TONE_HEX.good : TONE_HEX.good }}>{dbt?.tests_pass ?? 0}</span>
            <span className="obs-kpi-divider">/</span>
            <span style={{ color: testsFail > 0 ? TONE_HEX.bad : 'var(--ink-2)' }}>{dbt?.tests_total ?? 0}</span>
          </div>
          <div className="obs-kpi-sub">{testsFail === 0 ? 'all passed' : `${testsFail} failed`}</div>
        </div>
        <div className="obs-kpi">
          <div className="obs-kpi-label">last run</div>
          <div className="obs-kpi-value">{fmtDuration((dbt?.last_run_duration_s ?? 0) * 1000)}</div>
          <div className="obs-kpi-sub" suppressHydrationWarning>{dbt?.last_run_ts ? `${fmtRelativeMinutes(dbt.last_run_ts)} · ${fmtClock(dbt.last_run_ts)}` : 'never'}</div>
        </div>
        <div className="obs-kpi">
          <div className="obs-kpi-label">artifacts</div>
          <div className="obs-kpi-value" suppressHydrationWarning>{fmtRelativeMinutes(snapshot.artifacts?.last_modified ?? null)}</div>
          <div className="obs-kpi-sub" suppressHydrationWarning>{fmtDateTime(snapshot.artifacts?.last_modified ?? null)}</div>
        </div>
      </div>

      <div className="obs-kpi-col">
        <div className="obs-kpi-head">
          <span className="obs-kpi-head-label">ERRORS</span>
          <Pill tone={errorsH > 0 ? 'bad' : 'good'} />
        </div>
        <div className="obs-kpi">
          <div className="obs-kpi-label">last hour</div>
          <div className="obs-kpi-value" style={errorsH > 0 ? { color: TONE_HEX.bad } : undefined}>{errorsH}</div>
        </div>
        <div className="obs-kpi">
          <div className="obs-kpi-label">today</div>
          <div className="obs-kpi-value" style={errorsD > 0 ? { color: TONE_HEX.warn } : undefined}>{errorsD}</div>
        </div>
        <div className="obs-kpi">
          <div className="obs-kpi-label">stream</div>
          <div className="obs-kpi-value">{snapshot.errors.length}</div>
          <div className="obs-kpi-sub">{errorsH === 0 ? 'pipeline running clean' : 'see errors stream below'}</div>
        </div>
      </div>
    </section>
  )
}

function Sparkline({ values, color, height = 48 }: { values: number[]; color: string; height?: number }) {
  if (values.length === 0 || values.every(v => v === 0)) {
    return (
      <div className="obs-spark obs-spark--empty" style={{ height }}>
        <span>no events ingested · check watcher</span>
      </div>
    )
  }
  const max = Math.max(1, ...values)
  const w = 100
  const step = values.length > 1 ? w / (values.length - 1) : w
  const points = values
    .map((v, i) => `${(i * step).toFixed(2)},${(height - (v / max) * height).toFixed(2)}`)
    .join(' ')
  return (
    <svg className="obs-spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" height={height} width="100%">
      <polyline points={points} fill="none" stroke={color} strokeWidth="1.2" />
    </svg>
  )
}

function VolumeRow({ snapshot }: { snapshot: Snapshot }) {
  // The 24-bucket hourly series is the ground truth for sparklines. We don't
  // synthesize fake series: a sparkline either shows real data or empty state.
  const hourly = snapshot.hourly.map(b => Number(b.rows))
  // Daily series derived from the same buckets but resampled to last 24h is
  // already provided by `hourly`. Weekly would need a 7-day per-day query —
  // until that exists, show the 1d window and an empty 7d series.
  const series1h = hourly.slice(-1)
  const series1d = hourly
  const series7d: number[] = []

  const cells = [
    { label: 'Last 1h', value: snapshot.ingestion_1h?.rows_ingested ?? 0, spark: series1h.length > 1 ? series1h : hourly.slice(-2) },
    { label: 'Last 1d', value: snapshot.ingestion_1d?.rows_ingested ?? 0, spark: series1d },
    { label: 'Last 7d', value: snapshot.ingestion_7d?.rows_ingested ?? 0, spark: series7d },
  ]

  return (
    <section className="obs-volume">
      {cells.map((c, i) => {
        const isZero = c.value === 0
        return (
          <div key={i} className="obs-volume-cell">
            <div className="obs-volume-head">
              <span className="obs-volume-label">{c.label}</span>
              <span className={`obs-volume-value ${isZero ? 'obs-volume-value--zero' : ''}`}>{fmtNum(c.value)}</span>
            </div>
            <Sparkline values={c.spark} color={isZero ? TONE_HEX.bad : 'var(--accent)'} />
            <div className="obs-volume-foot">
              {isZero ? 'no events ingested · check watcher' : 'rows written to raw_events'}
            </div>
          </div>
        )
      })}
    </section>
  )
}

function SourceFreshnessTable({ rows }: { rows: DbtFreshness[] }) {
  if (rows.length === 0) {
    return (
      <div className="obs-errors-empty">
        <span>No source freshness data yet — run <code className="mono">dbt source freshness</code> to populate it.</span>
      </div>
    )
  }
  return (
    <div className="obs-table-wrap">
      <table className="obs-table">
        <thead>
          <tr>
            <th>source</th>
            <th>table</th>
            <th>status</th>
            <th>max loaded at</th>
            <th>age</th>
            <th>snapshotted at</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const tone: Tone = r.status === 'pass' ? 'good' : r.status === 'warn' ? 'warn' : 'bad'
            const cls = r.status === 'error' || r.status === 'runtime error' ? 'is-error' : r.status === 'warn' ? 'is-warn' : ''
            return (
              <tr key={i} className={cls}>
                <td>{r.source}</td>
                <td><span style={{ fontWeight: 500 }}>{r.table}</span></td>
                <td><Pill tone={tone}>{r.status.toUpperCase()}</Pill></td>
                <td>
                  <span className="obs-td-strong" suppressHydrationWarning>{fmtClock(r.max_loaded_at)}</span>
                  <span className="obs-td-sub" suppressHydrationWarning>{fmtDateTime(r.max_loaded_at)}</span>
                </td>
                <td style={{ color: tone === 'bad' ? TONE_HEX.bad : tone === 'warn' ? TONE_HEX.warn : undefined, fontWeight: 500 }}>
                  {fmtAgeShort(r.age_seconds)}
                </td>
                <td style={{ color: 'var(--muted)' }} suppressHydrationWarning>{fmtDateTime(r.snapshotted_at)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TestSection({ tests }: { tests: DbtTest[] }) {
  if (tests.length === 0) {
    return (
      <div className="obs-errors-empty">
        <span>No dbt test results yet — run <code className="mono">dbt test</code> to populate them.</span>
      </div>
    )
  }

  const byRelation = useMemo(() => {
    const map = new Map<string, { total: number; passed: number; failed: number; kinds: Set<string> }>()
    tests.forEach(t => {
      const entry = map.get(t.relation) ?? { total: 0, passed: 0, failed: 0, kinds: new Set() }
      entry.total += 1
      if (t.status === 'pass') entry.passed += 1
      else entry.failed += 1
      entry.kinds.add(t.kind)
      map.set(t.relation, entry)
    })
    return Array.from(map.entries()).map(([rel, v]) => ({ rel, ...v, kinds: Array.from(v.kinds) }))
  }, [tests])

  const totalMs = tests.reduce((acc, t) => acc + (t.execution_time_ms ?? 0), 0)
  const passed = tests.filter(t => t.status === 'pass').length
  const failed = tests.length - passed

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="obs-tests-wrap">
        <div className="obs-testgrid">
          {tests.map((t, i) => {
            const ok = t.status === 'pass'
            return (
              <div
                key={i}
                className={`obs-testcell ${ok ? 'obs-testcell--pass' : 'obs-testcell--fail'}`}
                title={`${t.name} · ${t.status} · ${fmtDuration(t.execution_time_ms)}`}
              >
                <span className="obs-testcell-dot" />
              </div>
            )
          })}
        </div>
        <div className="obs-tests-legend">
          <span><span className="obs-legend-dot" style={{ background: TONE_HEX.good }} />pass · {passed}</span>
          <span><span className="obs-legend-dot" style={{ background: TONE_HEX.bad }} />fail · {failed}</span>
          <span className="obs-tests-legend-aux">∑ {fmtDuration(totalMs)} across {tests.length} assertions</span>
        </div>
      </div>

      <div className="obs-relations">
        {byRelation.map(r => {
          const ok = r.failed === 0
          return (
            <div key={r.rel} className={`obs-relation ${ok ? '' : 'obs-relation--fail'}`}>
              <div className="obs-relation-name">{r.rel}</div>
              <div className="obs-relation-counts">
                <span style={{ color: ok ? TONE_HEX.good : TONE_HEX.bad }}>{r.passed}/{r.total}</span>
              </div>
              <div className="obs-relation-kinds">
                {r.kinds.map(k => <span key={k} className="obs-kind">{k.replace(/_/g, ' ')}</span>)}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function RecentRuns({ history }: { history: DbtHistoryEntry[] }) {
  if (history.length === 0) {
    return (
      <div className="obs-errors-empty">
        <span>No archived runs yet — the next dbt invocation will start populating this feed.</span>
      </div>
    )
  }
  return (
    <div className="obs-runs">
      {history.map((run, i) => {
        const ok = run.outcome === 'pass'
        const t = run.started_at ? new Date(run.started_at) : null
        const timeStr = t ? t.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '—'
        const tone: Tone = ok ? 'good' : run.outcome === 'fail' ? 'bad' : 'mute'
        return (
          <div key={i} className="obs-run">
            <span className="obs-run-time" suppressHydrationWarning>{timeStr}</span>
            <span className="obs-run-cmd">{run.command}</span>
            <Pill tone={tone}>{run.outcome.toUpperCase()}</Pill>
            <span style={{ color: 'var(--muted)' }}>{fmtDuration(run.duration_ms)}</span>
            <span className="obs-run-counts">
              {run.models_total > 0 && <span>{run.models_total} models</span>}
              {run.tests_total > 0 && <span>{run.tests_total} tests</span>}
            </span>
            {i === 0 && <span className="obs-run-latest">latest</span>}
          </div>
        )
      })}
    </div>
  )
}

function ErrorsFeed({ errors }: { errors: WatcherError[] }) {
  if (errors.length === 0) {
    return (
      <div className="obs-errors-empty">
        <Dot tone="good" size={8} />
        <span>No watcher errors recorded — the pipeline is <span style={{ color: TONE_HEX.good }}>running clean</span>.</span>
      </div>
    )
  }
  return (
    <div className="obs-errors-feed">
      {errors.slice(0, 20).map((e, i) => {
        const level: 'error' | 'warn' = e.source === 'dbt' ? 'warn' : 'error'
        const ts = new Date(e.ts)
        // Date + time so cross-day errors don't look like they happened
        // "today" — same shape as fmtRelative() above (used for dbt runs).
        const datePart = ts.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        const timePart = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
        const time = `${datePart} · ${timePart}`
        return (
          <div key={i} className={`obs-err obs-err--${level}`}>
            <span className="obs-err-time" suppressHydrationWarning>{time}</span>
            <span className={`obs-err-level obs-err-level--${level}`}>{level.toUpperCase()}</span>
            <span className="obs-err-source">{e.source}</span>
            <span className="obs-err-msg">{e.error_message}</span>
          </div>
        )
      })}
    </div>
  )
}

function ArtifactsFooter({ snapshot }: { snapshot: Snapshot }) {
  const [openRR, setOpenRR] = useState(false)
  const [openSrc, setOpenSrc] = useState(false)
  return (
    <footer className="obs-footer">
      <div className="obs-footer-bar">
        <span className="obs-footer-eyebrow">Raw artifacts · for deep debugging</span>
        <div className="obs-footer-toggles">
          <button className="obs-footer-btn" onClick={() => setOpenRR(v => !v)}>
            <span>{openRR ? '▼' : '▶'}</span> run_results.json
          </button>
          <button className="obs-footer-btn" onClick={() => setOpenSrc(v => !v)}>
            <span>{openSrc ? '▼' : '▶'}</span> sources.json
          </button>
        </div>
      </div>
      {openRR && (
        <pre className="obs-footer-code">{JSON.stringify(snapshot.artifacts?.run_results ?? null, null, 2)}</pre>
      )}
      {openSrc && (
        <pre className="obs-footer-code">{JSON.stringify(snapshot.artifacts?.sources ?? null, null, 2)}</pre>
      )}
      <div className="obs-footer-meta">
        <span>AURA · Observability</span>
        <span className="obs-footer-sep">·</span>
        <span>Sampled every 10 seconds.</span>
        {snapshot.artifacts?.last_modified && (
          <>
            <span className="obs-footer-sep">·</span>
            <span suppressHydrationWarning>Snapshot authoritative as of {fmtClock(snapshot.artifacts.last_modified)}.</span>
          </>
        )}
      </div>
    </footer>
  )
}

// ---------------------------------------------------------------------------
// Main client
// ---------------------------------------------------------------------------

const REFRESH_SEC = 10

export function PipelineLive({ initialData }: { initialData: Snapshot | null }) {
  const [data, setData] = useState<Snapshot | null>(initialData)
  const [lastFetch, setLastFetch] = useState<Date | null>(initialData ? new Date() : null)
  const [secondsAgo, setSecondsAgo] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    function poll() {
      fetch('/api/observability', { cache: 'no-store' })
        .then(r => r.json())
        .then((d: Snapshot) => {
          setData(d)
          setLastFetch(new Date())
          setSecondsAgo(0)
        })
        .catch(() => {
          // keep stale on error — banner doesn't change
        })
    }
    if (!initialData) poll()
    pollRef.current = setInterval(poll, REFRESH_SEC * 1000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [initialData])

  useEffect(() => {
    tickRef.current = setInterval(() => setSecondsAgo(s => s + 1), 1000)
    return () => { if (tickRef.current) clearInterval(tickRef.current) }
  }, [])

  void lastFetch

  const verdict: Verdict = useMemo(
    () => data ? deriveVerdict(data) : { state: 'mute', headline: 'Pipeline', accent: 'loading.', summary: 'Fetching the latest snapshot…', issues: [] },
    [data]
  )

  // UTC clock so a glance at the timestamp is unambiguous across machines.
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  const timeLabel = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC'

  if (!data) {
    return (
      <div className="muted eyebrow" style={{ padding: '64px 0' }}>
        Loading observability snapshot…
      </div>
    )
  }

  return (
    <div>
      <Crumb tone={verdict.state} refreshedAgo={secondsAgo} refreshSec={REFRESH_SEC} />

      <VerdictBlock verdict={verdict} timeLabel={timeLabel} />

      <RuleHeader label="I · Flow" sub="Watcher → Bronze → Silver → Gold → Consumers" />
      <FlowStrip snapshot={data} verdict={verdict} />

      <RuleHeader label="II · Medallion layers" sub="bronze · silver · gold" />
      <MedallionLayers layers={data.layers} />

      <RuleHeader label="III · At a glance" sub="every layer, one screen" />
      <KpiGrid snapshot={data} verdict={verdict} />

      <RuleHeader id="ingestion" label="IV · Ingestion volume" sub="rows written to raw_events" />
      <VolumeRow snapshot={data} />

      <RuleHeader
        id="freshness"
        label="V · Source freshness"
        sub={`${data.dbt?.source_freshness.length ?? 0} source · checked every dbt invocation`}
      />
      <SourceFreshnessTable rows={data.dbt?.source_freshness ?? []} />

      <RuleHeader
        id="tests"
        label="VI · dbt tests"
        sub={data.dbt
          ? `${data.dbt.tests_pass}/${data.dbt.tests_total} passed · last run ${fmtDuration((data.dbt.last_run_duration_s ?? 0) * 1000)}`
          : 'no dbt run yet'}
      />
      <TestSection tests={data.dbt?.per_test ?? []} />

      <RuleHeader label="VII · Recent invocations" sub={`last ${data.dbt_history.length} dbt runs`} />
      <RecentRuns history={data.dbt_history} />

      <RuleHeader id="errors" label="VIII · Watcher errors" sub="live stream" />
      <ErrorsFeed errors={data.errors} />

      <ArtifactsFooter snapshot={data} />
    </div>
  )
}
