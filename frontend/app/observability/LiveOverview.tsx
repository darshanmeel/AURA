'use client'

import React, { useEffect, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// Types (mirrors the API contract exactly)
// ---------------------------------------------------------------------------

type HealthLevel = 'green' | 'yellow' | 'red' | 'unknown'

interface OverallHealth {
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

interface IngestionStats {
  window: '1h' | '1d' | '7d'
  rows_ingested: number
  sessions_ingested: number
  files_seen: number
}

interface OverviewPayload {
  overall: OverallHealth | null
  stats: {
    '1h': IngestionStats | null
    '1d': IngestionStats | null
    '7d': IngestionStats | null
  }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function formatAge(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return '—'
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${Math.floor(seconds)}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

function formatNumber(n: number | null | undefined): string {
  if (n == null) return '—'
  return new Intl.NumberFormat().format(n)
}

interface StatusStyle {
  bg: string
  border: string
  text: string
  label: string
  dot: string
}

function statusColor(level: HealthLevel): StatusStyle {
  switch (level) {
    case 'green':
      return {
        bg: 'rgba(74, 192, 97, 0.08)',
        border: 'rgba(74, 192, 97, 0.3)',
        text: '#4ac061',
        dot: '#4ac061',
        label: 'Healthy',
      }
    case 'yellow':
      return {
        bg: 'rgba(217, 183, 135, 0.1)',
        border: 'rgba(217, 183, 135, 0.35)',
        text: '#d9b787',
        dot: '#d9b787',
        label: 'Degraded',
      }
    case 'red':
      return {
        bg: 'rgba(217, 124, 94, 0.1)',
        border: 'rgba(217, 124, 94, 0.35)',
        text: '#d97c5e',
        dot: '#d97c5e',
        label: 'Critical',
      }
    case 'unknown':
    default:
      return {
        bg: 'rgba(255, 255, 255, 0.04)',
        border: 'rgba(239, 230, 214, 0.12)',
        text: '#8a7d6a',
        dot: '#5f5547',
        label: 'Unknown',
      }
  }
}

function overallLabel(level: HealthLevel): string {
  switch (level) {
    case 'green':  return 'Pipeline Healthy'
    case 'yellow': return 'Pipeline Degraded'
    case 'red':    return 'Pipeline Critical'
    default:       return 'Pipeline Unknown'
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusPill({ level }: { level: HealthLevel }) {
  const s = statusColor(level)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        borderRadius: 999,
        background: s.bg,
        border: `1px solid ${s.border}`,
        color: s.text,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: s.dot,
          flexShrink: 0,
        }}
      />
      {s.label}
    </span>
  )
}

function BigStatusBanner({ level }: { level: HealthLevel }) {
  const s = statusColor(level)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 20,
        padding: '24px 28px',
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 6,
        margin: '24px 0',
      }}
    >
      {/* Big dot */}
      <span
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: s.dot,
          flexShrink: 0,
          boxShadow: `0 0 16px ${s.dot}55`,
        }}
      />
      <div>
        <div
          style={{
            fontFamily: 'var(--serif)',
            fontSize: 28,
            fontWeight: 400,
            color: s.text,
            letterSpacing: '-0.01em',
            lineHeight: 1.1,
          }}
        >
          {overallLabel(level)}
        </div>
        <div
          style={{
            fontFamily: 'var(--mono)',
            fontSize: 11,
            color: 'var(--muted)',
            letterSpacing: '0.06em',
            marginTop: 4,
          }}
        >
          OVERALL PIPELINE STATUS
        </div>
      </div>
    </div>
  )
}

function StatusCard({
  eyebrow,
  title,
  pill,
  primary,
  secondary,
}: {
  eyebrow: string
  title: string
  pill: React.ReactNode
  primary: string
  secondary: string
}) {
  return (
    <div
      style={{
        border: '1px solid var(--rule)',
        borderRadius: 4,
        padding: '20px 24px',
        background: 'rgba(255,255,255,0.02)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--muted)',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
        }}
      >
        {eyebrow}
      </div>
      <div
        style={{
          fontFamily: 'var(--sans)',
          fontSize: 16,
          fontWeight: 600,
          color: 'var(--ink)',
        }}
      >
        {title}
      </div>
      <div>{pill}</div>
      <div
        style={{
          fontFamily: 'var(--sans)',
          fontSize: 13,
          color: 'var(--ink-2)',
        }}
      >
        {primary}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: 'var(--muted)',
          letterSpacing: '0.04em',
        }}
      >
        {secondary}
      </div>
    </div>
  )
}

function WindowColumn({
  label,
  stats,
  footnote,
}: {
  label: string
  stats: IngestionStats | null
  footnote?: string
}) {
  return (
    <div
      style={{
        border: '1px solid var(--rule)',
        borderRadius: 4,
        padding: '20px 24px',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--accent)',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          marginBottom: 12,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'var(--serif)',
          fontSize: 48,
          fontWeight: 400,
          color: 'var(--ink)',
          lineHeight: 1,
          letterSpacing: '-0.02em',
          marginBottom: 4,
        }}
      >
        {formatNumber(stats?.rows_ingested ?? null)}
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: 'var(--muted)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          marginBottom: 16,
        }}
      >
        events
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div
          style={{
            fontFamily: 'var(--sans)',
            fontSize: 13,
            color: 'var(--ink-2)',
          }}
        >
          {formatNumber(stats?.sessions_ingested ?? null)}{' '}
          <span style={{ color: 'var(--muted)' }}>sessions</span>
        </div>
        <div
          style={{
            fontFamily: 'var(--sans)',
            fontSize: 13,
            color: 'var(--ink-2)',
          }}
        >
          {formatNumber(stats?.files_seen ?? null)}{' '}
          <span style={{ color: 'var(--muted)' }}>files watched</span>
          {footnote && (
            <span
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 10,
                color: 'var(--muted-2)',
                marginLeft: 6,
              }}
            >
              ({footnote})
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function CtaCard({
  href,
  title,
  teaser,
  level,
}: {
  href: string
  title: string
  teaser: string
  level: HealthLevel
}) {
  const s = statusColor(level)
  return (
    <a
      href={href}
      style={{
        display: 'block',
        border: `1px solid ${s.border}`,
        borderRadius: 4,
        padding: '20px 24px',
        background: s.bg,
        textDecoration: 'none',
        transition: 'border-color 0.15s',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <span
          style={{
            fontFamily: 'var(--sans)',
            fontSize: 16,
            fontWeight: 600,
            color: 'var(--ink)',
          }}
        >
          {title}
        </span>
        <span style={{ color: s.text, fontSize: 18 }}>→</span>
      </div>
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 11,
          color: s.text,
          letterSpacing: '0.04em',
        }}
      >
        {teaser}
      </div>
    </a>
  )
}

// ---------------------------------------------------------------------------
// Main client component
// ---------------------------------------------------------------------------

export function LiveOverview({ initialData }: { initialData: OverviewPayload | null }) {
  const [data, setData] = useState<OverviewPayload | null>(initialData)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(initialData ? new Date() : null)
  const [secondsAgo, setSecondsAgo] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const clockRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Poll every 10s
  useEffect(() => {
    function poll() {
      fetch('/api/observability?view=overview', { cache: 'no-store' })
        .then((r) => r.json())
        .then((d: OverviewPayload) => {
          setData(d)
          setLastUpdated(new Date())
          setSecondsAgo(0)
        })
        .catch(() => {
          // keep stale data on network error
        })
    }

    // Poll immediately on mount if no initial data
    if (!initialData) poll()

    timerRef.current = setInterval(poll, 10_000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [initialData])

  // Tick the "X seconds ago" clock every second
  useEffect(() => {
    clockRef.current = setInterval(() => {
      setSecondsAgo((s) => s + 1)
    }, 1000)
    return () => {
      if (clockRef.current) clearInterval(clockRef.current)
    }
  }, [])

  const overall = data?.overall
  const stats = data?.stats

  // Derived display values
  const overallStatus: HealthLevel = overall?.overall_status ?? 'unknown'
  const bronzeStatus: HealthLevel = overall?.bronze_status ?? 'unknown'
  const dbtStatus: HealthLevel = overall?.dbt_status ?? 'unknown'

  const bronzePrimary = overall?.bronze_age_seconds != null
    ? `Last event: ${formatAge(overall.bronze_age_seconds)}`
    : 'No events seen yet'

  const bronzeSecondary = formatTimestamp(overall?.bronze_latest_event ?? null)

  const dbtPrimary = (() => {
    if (!overall?.last_dbt_run_ts) return 'Never run'
    const ageS = overall.last_dbt_run_ts
      ? (Date.now() - new Date(overall.last_dbt_run_ts).getTime()) / 1000
      : null
    const ago = formatAge(ageS)
    const status = overall.last_dbt_run_status === 'success'
      ? 'Success'
      : overall.last_dbt_run_status === 'failure'
      ? 'Failure'
      : 'Unknown'
    return `Last run: ${status} · ${ago}`
  })()

  const dbtSecondary = formatTimestamp(overall?.last_dbt_run_ts ?? null)

  const errorsH = overall?.errors_last_hour ?? 0
  const errorsD = overall?.errors_last_day ?? 0
  const errStatus: HealthLevel = errorsH > 10 ? 'red' : errorsH > 0 ? 'yellow' : 'green'

  return (
    <div style={{ paddingTop: 8 }}>
      {/* Big status banner */}
      <BigStatusBanner level={overallStatus} />

      {/* 3-card status strip */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 16,
          margin: '24px 0',
        }}
      >
        {/* Card A: Bronze */}
        <StatusCard
          eyebrow="Bronze · raw_events"
          title="Ingestion"
          pill={<StatusPill level={bronzeStatus} />}
          primary={bronzePrimary}
          secondary={bronzeSecondary}
        />

        {/* Card B: dbt */}
        <StatusCard
          eyebrow="dbt · transforms"
          title="dbt Runs"
          pill={<StatusPill level={dbtStatus} />}
          primary={dbtPrimary}
          secondary={dbtSecondary}
        />

        {/* Card C: Errors */}
        <div
          style={{
            border: `1px solid ${errorsH > 0 ? 'rgba(217,124,94,0.35)' : 'var(--rule)'}`,
            borderRadius: 4,
            padding: '20px 24px',
            background: errorsH > 0 ? 'rgba(217,124,94,0.06)' : 'rgba(255,255,255,0.02)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--muted)',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            Errors · watcher
          </div>
          <div
            style={{
              fontFamily: 'var(--sans)',
              fontSize: 16,
              fontWeight: 600,
              color: 'var(--ink)',
            }}
          >
            Errors
          </div>
          <StatusPill level={errStatus} />
          <div
            style={{
              fontFamily: 'var(--serif)',
              fontSize: 40,
              fontWeight: 400,
              color: errorsH > 0 ? '#d97c5e' : 'var(--ink)',
              lineHeight: 1,
              letterSpacing: '-0.02em',
            }}
          >
            {formatNumber(errorsH)}
          </div>
          <div
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--muted)',
              letterSpacing: '0.04em',
            }}
          >
            in last hour
          </div>
          <div
            style={{
              fontFamily: 'var(--sans)',
              fontSize: 13,
              color: errorsD > 0 ? '#d97c5e' : 'var(--muted)',
            }}
          >
            {formatNumber(errorsD)} in last 24h
          </div>
        </div>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--rule)', margin: '32px 0 24px' }} />

      {/* Ingestion windows */}
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--accent)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          marginBottom: 16,
        }}
      >
        Ingestion windows
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 16,
          marginBottom: 32,
        }}
      >
        <WindowColumn label="Last 1 hour" stats={stats?.['1h'] ?? null} />
        <WindowColumn label="Last 1 day" stats={stats?.['1d'] ?? null} />
        <WindowColumn label="Last 7 days" stats={stats?.['7d'] ?? null} footnote="lifetime files" />
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: 'var(--rule)', margin: '8px 0 24px' }} />

      {/* CTA links */}
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--accent)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          marginBottom: 16,
        }}
      >
        Drill down
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 16,
          marginBottom: 40,
        }}
      >
        <CtaCard
          href="/observability/watcher"
          title="Watcher details →"
          teaser={`Bronze ${statusColor(bronzeStatus).label.toLowerCase()} · ${bronzePrimary.toLowerCase()}`}
          level={bronzeStatus}
        />
        <CtaCard
          href="/observability/dbt"
          title="dbt details →"
          teaser={`dbt ${statusColor(dbtStatus).label.toLowerCase()} · ${dbtPrimary.toLowerCase()}`}
          level={dbtStatus}
        />
      </div>

      {/* Last updated caption */}
      <div
        style={{
          fontFamily: 'var(--mono)',
          fontSize: 10,
          color: 'var(--muted-2)',
          letterSpacing: '0.08em',
          textAlign: 'right',
          paddingBottom: 8,
        }}
      >
        {lastUpdated
          ? `LAST UPDATED ${secondsAgo}s ago · AUTO-REFRESH EVERY 10s`
          : 'LOADING…'}
      </div>
    </div>
  )
}
