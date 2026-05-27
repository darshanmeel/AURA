'use client'

import React, { useEffect, useRef, useState } from 'react'
import { formatAge, truncateMiddle, sourceTag } from '../../../lib/watcher-helpers'

export interface WatcherError {
  ts: string
  source: string
  file_path: string | null
  error_message: string
  stack_trace: string
}

interface Props {
  initialErrors: WatcherError[]
}

// Relative time formatted client-side to avoid SSR mismatch.
function RelativeTime({ ts }: { ts: string }) {
  const [label, setLabel] = useState<string>('—')

  useEffect(() => {
    function update() {
      const ageSeconds = (Date.now() - new Date(ts).getTime()) / 1000
      setLabel(formatAge(ageSeconds))
    }
    update()
    const id = setInterval(update, 10_000)
    return () => clearInterval(id)
  }, [ts])

  const abs = (() => {
    try {
      return new Date(ts).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
    } catch {
      return ts
    }
  })()

  return (
    <span title={abs} suppressHydrationWarning>
      {label}
    </span>
  )
}

// Row-level expand/collapse for stack trace
function ErrorRow({ err, idx }: { err: WatcherError; idx: number }) {
  const [expanded, setExpanded] = useState(false)
  const [msgExpanded, setMsgExpanded] = useState(false)

  const tag = sourceTag(err.source)
  const isDbt = err.source === 'dbt'
  const rowBg = isDbt
    ? 'rgba(217,124,94,0.06)'
    : idx % 2 === 0
      ? 'transparent'
      : 'rgba(239,230,214,0.02)'

  const fullMsg = err.error_message ?? ''
  const shortMsg = fullMsg.length > 200 ? fullMsg.slice(0, 200) + '…' : fullMsg

  return (
    <>
      <tr style={{ background: rowBg, borderBottom: '1px solid var(--rule)' }}>
        {/* Time */}
        <td
          className="mono"
          style={{ whiteSpace: 'nowrap', paddingRight: 16, verticalAlign: 'top', paddingTop: 10 }}
        >
          <RelativeTime ts={err.ts} />
        </td>

        {/* Source pill */}
        <td style={{ verticalAlign: 'top', paddingTop: 8 }}>
          <span
            style={{
              display: 'inline-block',
              padding: '2px 7px',
              borderRadius: 3,
              fontSize: 11,
              fontFamily: 'var(--mono)',
              background: tag.bg,
              color: tag.color,
              border: `1px solid ${tag.color}44`,
              whiteSpace: 'nowrap',
            }}
          >
            {tag.label}
          </span>
        </td>

        {/* File path */}
        <td
          className="mono"
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            maxWidth: 240,
            verticalAlign: 'top',
            paddingTop: 10,
          }}
          title={err.file_path ?? undefined}
        >
          {truncateMiddle(err.file_path, 40)}
        </td>

        {/* Error message */}
        <td style={{ verticalAlign: 'top', paddingTop: 10 }}>
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: isDbt ? 'var(--warn)' : 'var(--ink-2)',
              display: 'block',
              maxWidth: 420,
              lineHeight: 1.5,
            }}
          >
            {msgExpanded ? fullMsg : shortMsg}
            {fullMsg.length > 200 && (
              <button
                onClick={() => setMsgExpanded(v => !v)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--accent)',
                  fontFamily: 'var(--mono)',
                  fontSize: 10,
                  padding: '0 4px',
                  marginLeft: 4,
                }}
              >
                {msgExpanded ? '↑ less' : '↓ more'}
              </button>
            )}
          </span>
          {err.stack_trace && (
            <button
              onClick={() => setExpanded(v => !v)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--muted)',
                fontFamily: 'var(--mono)',
                fontSize: 10,
                padding: '4px 0 0',
                display: 'block',
                letterSpacing: '0.05em',
              }}
            >
              {expanded ? '▲ hide trace' : '▼ stack trace'}
            </button>
          )}
        </td>
      </tr>

      {/* Stack trace expansion row */}
      {expanded && err.stack_trace && (
        <tr style={{ background: 'rgba(239,230,214,0.03)' }}>
          <td colSpan={4} style={{ padding: '0 0 12px 16px' }}>
            <pre
              style={{
                fontFamily: 'var(--mono)',
                fontSize: 11,
                color: 'var(--muted)',
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 320,
                overflowY: 'auto',
                borderLeft: '2px solid var(--rule-strong)',
                paddingLeft: 12,
                paddingTop: 8,
                paddingBottom: 8,
              }}
            >
              {err.stack_trace}
            </pre>
          </td>
        </tr>
      )}
    </>
  )
}

export function WatcherErrorsTable({ initialErrors }: Props) {
  const [errors, setErrors] = useState<WatcherError[]>(initialErrors)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [pollStatus, setPollStatus] = useState<'ok' | 'error'>('ok')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    async function poll() {
      try {
        const res = await fetch('/api/observability?view=watcher', { cache: 'no-store' })
        if (!res.ok) { setPollStatus('error'); return }
        const data = await res.json()
        const errs: WatcherError[] = Array.isArray(data.errors) ? data.errors : []
        setErrors(errs)
        setLastRefresh(new Date())
        setPollStatus('ok')
      } catch {
        setPollStatus('error')
      }
    }

    // First poll immediately, then every 10 s
    poll()
    timerRef.current = setInterval(poll, 10_000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [])

  const [refreshLabel, setRefreshLabel] = useState<string>('')
  useEffect(() => {
    if (!lastRefresh) return
    function tick() {
      if (!lastRefresh) return
      const s = Math.round((Date.now() - lastRefresh.getTime()) / 1000)
      setRefreshLabel(`refreshed ${s}s ago`)
    }
    tick()
    const id = setInterval(tick, 5_000)
    return () => clearInterval(id)
  }, [lastRefresh])

  return (
    <div>
      {/* Section header */}
      <div className="section-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h2 className="h-section" style={{ margin: 0 }}>Recent watcher errors</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {pollStatus === 'error' && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--warn)' }}>
              poll failed
            </span>
          )}
          {refreshLabel && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)' }}>
              {refreshLabel}
            </span>
          )}
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 10,
              letterSpacing: '0.08em',
              color: 'var(--muted)',
              background: 'rgba(239,230,214,0.04)',
              border: '1px solid var(--rule)',
              borderRadius: 3,
              padding: '2px 7px',
            }}
          >
            LIVE · 10s
          </span>
        </div>
      </div>

      {errors.length === 0 ? (
        <div
          style={{
            padding: '28px 20px',
            border: '1px dashed var(--rule)',
            borderRadius: 4,
            fontFamily: 'var(--mono)',
            fontSize: 12,
            color: '#7fcf8e',
            letterSpacing: '0.04em',
          }}
        >
          No watcher errors recorded — the pipeline is running clean.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table
            className="ledger"
            style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse' }}
          >
            <colgroup>
              <col style={{ width: 110 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 220 }} />
              <col />
            </colgroup>
            <thead>
              <tr>
                <th>When</th>
                <th>Source</th>
                <th>File path</th>
                <th>Error message</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((err, i) => (
                <ErrorRow key={`${err.ts}-${i}`} err={err} idx={i} />
              ))}
            </tbody>
          </table>
          <div
            style={{
              marginTop: 8,
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--muted-2)',
              letterSpacing: '0.04em',
            }}
          >
            {errors.length} error{errors.length !== 1 ? 's' : ''} · newest first
          </div>
        </div>
      )}
    </div>
  )
}
