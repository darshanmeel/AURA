export const dynamic = 'force-dynamic'

import React from 'react'
import { Eyebrow, Rule, StatBlock } from '../../../components/atoms'
import { WatcherErrorsTable, type WatcherError } from './WatcherErrorsTable'
import {
  formatBytes,
  formatAge,
  bronzeStatusColor,
} from '../../../lib/watcher-helpers'

// ---------------------------------------------------------------------------
// Types matching /api/observability?view=watcher
// ---------------------------------------------------------------------------

interface WatcherData {
  bronze_latest_event: string | null
  bronze_age_seconds: number | null
  bronze_status: 'green' | 'yellow' | 'red' | 'unknown'
  files_total: number
  total_bytes_ingested: number
  ingestion_1h: number
  ingestion_1d: number
  ingestion_7d: number
  errors_last_hour: number
  errors_last_day: number
}

interface ApiResponse {
  watcher?: WatcherData | null
  errors?: WatcherError[]
  error?: string   // safe() fallback key
}

// ---------------------------------------------------------------------------
// Data fetch — server-side, single call
// ---------------------------------------------------------------------------

async function fetchWatcherData(): Promise<ApiResponse> {
  try {
    // On the server we always call the internal API handler directly;
    // using an absolute URL ensures this works both in Docker and locally.
    const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const res = await fetch(`${base}/api/observability?view=watcher`, {
      cache: 'no-store',
    })
    if (!res.ok) return {}
    return (await res.json()) as ApiResponse
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Sub-components (server-only, no 'use client')
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: string | null | undefined }) {
  const color = bronzeStatusColor(status)
  const label = (status ?? 'unknown').toUpperCase()
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.08em',
        background: `${color}18`,
        color,
        border: `1px solid ${color}44`,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
        }}
      />
      {label}
    </span>
  )
}

function VolumeCard({
  window,
  count,
}: {
  window: string
  count: number
}) {
  const isZero = count === 0
  return (
    <div
      style={{
        flex: '1 1 0',
        padding: '20px 24px',
        border: '1px solid var(--rule)',
        borderRadius: 4,
        background: 'rgba(239,230,214,0.02)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          letterSpacing: '0.10em',
          color: 'var(--muted)',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        Last {window}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 28,
          fontWeight: 500,
          color: isZero ? 'var(--warn)' : 'var(--ink)',
          letterSpacing: '-0.02em',
          lineHeight: 1,
        }}
      >
        {count.toLocaleString()}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: isZero ? 'var(--warn)' : 'var(--muted)',
          marginTop: 6,
          letterSpacing: '0.03em',
        }}
      >
        {isZero ? 'no events ingested — check watcher' : 'rows ingested'}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function WatcherPage() {
  const data = await fetchWatcherData()
  const w: WatcherData | null = (data.watcher && !('error' in data.watcher))
    ? data.watcher
    : null

  const errors: WatcherError[] = Array.isArray(data.errors) ? data.errors : []

  const bronzeStatus = w?.bronze_status ?? 'unknown'
  const latestEventTs = w?.bronze_latest_event ?? null
  const ageSeconds = w?.bronze_age_seconds ?? null

  const latestAbsolute = latestEventTs
    ? (() => {
        try {
          return new Date(latestEventTs).toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
          })
        } catch {
          return latestEventTs
        }
      })()
    : '—'

  return (
    <div className="page page-layout">

      {/* ── BREADCRUMB / TAB NAV ──────────────────────────────────────── */}
      <section className="masthead-strap">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <a
            href="/observability"
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--muted)',
              textDecoration: 'none',
              letterSpacing: '0.06em',
            }}
          >
            Observability
          </a>
          <span style={{ color: 'var(--muted-2)', fontFamily: 'var(--mono)', fontSize: 12 }}>›</span>
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 12,
              color: 'var(--accent)',
              letterSpacing: '0.06em',
            }}
          >
            Watcher
          </span>
        </div>

        {/* Sub-page tab strip */}
        <nav style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
          {[
            { href: '/observability',        label: 'Overview' },
            { href: '/observability/watcher', label: 'Watcher', active: true },
            { href: '/observability/dbt',     label: 'dbt' },
          ].map(tab => (
            <a
              key={tab.href}
              href={tab.href}
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                letterSpacing: '0.06em',
                padding: '5px 12px',
                borderRadius: 3,
                textDecoration: 'none',
                color: tab.active ? 'var(--accent)' : 'var(--muted)',
                background: tab.active ? 'rgba(217,183,135,0.08)' : 'transparent',
                border: tab.active ? '1px solid rgba(217,183,135,0.25)' : '1px solid transparent',
              }}
            >
              {tab.label}
            </a>
          ))}
        </nav>
      </section>

      {/* ── PAGE HEAD ─────────────────────────────────────────────────── */}
      <section className="page-head">
        <Eyebrow>Watcher · ingestion health</Eyebrow>
        <h1 className="display display-sm">
          Pipeline <em>status.</em>
        </h1>
        <p className="hero-lede">
          JSONL ingestion rate, checkpoint file inventory, and recent watcher errors.
          A yellow or red status here means events are not flowing from{' '}
          <span className="mono" style={{ fontSize: 13 }}>~/.claude/projects/</span>{' '}
          into the bronze layer.
        </p>
      </section>

      <Rule weight="thick" />

      {/* ── TOP STATUS STRIP — 4 CARDS ─────────────────────────────────── */}
      <section className="strip">

        {/* Card 1: Bronze freshness */}
        <div className="stat" style={{ minWidth: 200 }}>
          <div className="stat-label">Bronze freshness</div>
          <div className="stat-value" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <StatusPill status={bronzeStatus} />
          </div>
          <div className="stat-foot">
            {ageSeconds != null
              ? `Latest event: ${formatAge(ageSeconds)}`
              : 'No events recorded'}
          </div>
          {latestEventTs && (
            <div
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--muted-2)',
                marginTop: 4,
                letterSpacing: '0.03em',
              }}
              title={latestEventTs}
            >
              {latestAbsolute}
            </div>
          )}
        </div>

        {/* Card 2: Files watched */}
        <StatBlock
          label="Files watched"
          value={w?.files_total?.toLocaleString() ?? '—'}
          footnote="checkpointed JSONL files"
        />

        {/* Card 3: Total bytes ingested */}
        <StatBlock
          label="Total bytes ingested"
          value={formatBytes(w?.total_bytes_ingested)}
          footnote="sum of last_offset across checkpoints"
        />

        {/* Card 4: Errors */}
        <div className={`stat ${(w?.errors_last_hour ?? 0) > 0 ? 'stat-accent' : ''}`}>
          <div className="stat-label">Errors</div>
          <div
            className="stat-value"
            style={{
              color: (w?.errors_last_hour ?? 0) > 0 ? 'var(--warn)' : undefined,
            }}
          >
            {w?.errors_last_hour?.toLocaleString() ?? '—'}
          </div>
          <div className="stat-foot">
            last hour ·{' '}
            <span
              style={{
                color: (w?.errors_last_day ?? 0) > 0 ? 'var(--warn)' : 'var(--muted)',
              }}
            >
              {w?.errors_last_day?.toLocaleString() ?? '—'} today
            </span>
          </div>
        </div>

      </section>

      <Rule />

      {/* ── INGESTION VOLUME ──────────────────────────────────────────── */}
      <section style={{ marginBottom: 40 }}>
        <div className="section-head">
          <h2 className="h-section">Ingestion volume</h2>
          <span className="section-meta">rows written to raw_events</span>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <VolumeCard window="1h" count={w?.ingestion_1h ?? 0} />
          <VolumeCard window="1d" count={w?.ingestion_1d ?? 0} />
          <VolumeCard window="7d" count={w?.ingestion_7d ?? 0} />
        </div>
      </section>

      <Rule />

      {/* ── RECENT ERRORS TABLE — CLIENT (live polling) ───────────────── */}
      <section style={{ marginBottom: 40 }}>
        <WatcherErrorsTable initialErrors={errors} />
      </section>

    </div>
  )
}
