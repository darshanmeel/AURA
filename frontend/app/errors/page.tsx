'use client'

import React, { useState, useEffect } from 'react'
import { Eyebrow, Rule, StatBlock, SeverityTag, AgentLink } from '../../components/atoms'
import { fmt } from '../../lib/fmt'

interface ErrorRow {
  ts: string
  severity: string
  kind: string
  tool: string | null
  message: string
  session_id: string
  turn_number: number | null
  // present when the API joins dim_sessions; may be absent in older response shape
  session_title?: string
  agent?: string
}

export default function ErrorsPage() {
  const [allErrors, setAllErrors] = useState<ErrorRow[]>([])
  const [loading, setLoading]     = useState(true)
  const [activeKind, setActiveKind] = useState<string>('All')

  useEffect(() => {
    fetch('/api/errors')
      .then(r => r.json())
      .then(d => {
        // endpoint returns { errors: [...] } or a bare array
        const rows = Array.isArray(d) ? d : (d.errors ?? [])
        setAllErrors(rows)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [])

  // ── Derived counts ─────────────────────────────────────────────────────────
  const bySev: Record<string, number> = {}
  allErrors.forEach(e => { bySev[e.severity] = (bySev[e.severity] ?? 0) + 1 })

  const byKind: Record<string, number> = {}
  allErrors.forEach(e => { byKind[e.kind] = (byKind[e.kind] ?? 0) + 1 })
  const kinds = Object.keys(byKind).sort((a, b) => byKind[b] - byKind[a])

  const sessionsAffected = new Set(allErrors.map(e => e.session_id)).size
  const toolFailures = allErrors.filter(e => e.kind === 'tool_error').length

  const filtered = activeKind === 'All'
    ? allErrors
    : allErrors.filter(e => e.kind === activeKind)

  return (
    <div className="page-layout">
      {/* ── MASTHEAD STRAP ───────────────────────────────────────────── */}
      <section style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <Eyebrow>Errors · across all sessions · 14 days</Eyebrow>
        <span style={{
          padding: '2px 10px',
          border: '1px solid var(--rule-strong)',
          borderRadius: 4,
          fontSize: 12,
          fontFamily: 'var(--mono)',
          color: 'var(--muted)',
        }}>
          {fmt.n(allErrors.length)} events
        </span>
      </section>

      {/* ── HERO ─────────────────────────────────────────────────────── */}
      <section style={{ marginBottom: 32 }}>
        <Eyebrow>The error log</Eyebrow>
        <h1 className="display display-sm" style={{ margin: '8px 0 16px' }}>
          What went <em>wrong.</em>
        </h1>
        <p className="hero-lede" style={{ maxWidth: 560 }}>
          {bySev.error ?? 0} hard error{(bySev.error ?? 0) !== 1 ? 's' : ''}{' '}
          · {bySev.warn ?? 0} warning{(bySev.warn ?? 0) !== 1 ? 's' : ''}{' '}
          · {bySev.info ?? 0} info event{(bySev.info ?? 0) !== 1 ? 's' : ''}.{' '}
          Most agents recover and keep going; the table below is what to grep for in retros.
        </p>
      </section>

      <Rule weight="thick" />

      {/* ── 5-STAT STRIP ─────────────────────────────────────────────── */}
      <section className="kpi-strip" style={{ marginBottom: 24 }}>
        <StatBlock
          label="Total events"
          value={fmt.n(allErrors.length)}
          footnote="14 days"
        />
        <StatBlock
          label="Hard errors"
          value={fmt.n(bySev.error ?? 0)}
          footnote="severity = error"
          accent
        />
        <StatBlock
          label="Warnings"
          value={fmt.n(bySev.warn ?? 0)}
          footnote="severity = warn"
        />
        <StatBlock
          label="Affected sessions"
          value={fmt.n(sessionsAffected)}
          footnote="unique sessions"
        />
        <StatBlock
          label="Tool failures"
          value={fmt.n(toolFailures)}
          footnote="Read / Bash / WebFetch"
        />
      </section>

      <Rule />

      {/* ── KIND CHIP FILTER ROW ─────────────────────────────────────── */}
      <section style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '16px 0' }}>
        {(['All', ...kinds] as string[]).map(k => {
          const isActive = activeKind === k
          return (
            <button
              key={k}
              className={`chip${isActive ? ' is-active' : ''}`}
              onClick={() => setActiveKind(k)}
              style={isActive
                ? { background: 'var(--accent)', color: 'var(--bg)', borderColor: 'var(--accent)' }
                : undefined}
            >
              {k}
              {k !== 'All' && (
                <span style={{
                  marginLeft: 6,
                  padding: '0 5px',
                  borderRadius: 3,
                  background: isActive ? 'rgba(0,0,0,0.2)' : 'var(--rule)',
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                }}>
                  {fmt.n(byKind[k])}
                </span>
              )}
            </button>
          )
        })}
      </section>

      {/* ── ERROR TABLE ──────────────────────────────────────────────── */}
      <section style={{ paddingTop: 8 }}>
        {loading ? (
          <div className="muted eyebrow" style={{ padding: '24px 0' }}>Loading…</div>
        ) : (
          <table className="ledger-table ledger-errors" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>When</th>
                <th>Severity</th>
                <th>Kind</th>
                <th>Tool</th>
                <th>Message</th>
                <th>Session</th>
                <th className="num">Turn</th>
                <th style={{ width: 24 }} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => (
                <tr
                  key={i}
                  style={{ cursor: 'pointer' }}
                  onClick={() => { window.location.href = `/sessions/${e.session_id}` }}
                >
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                    <div style={{ fontSize: 12 }}>{fmt.date(e.ts)}</div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>{fmt.time(e.ts)}</div>
                  </td>
                  <td><SeverityTag severity={e.severity} /></td>
                  <td>
                    <span style={{
                      display: 'inline-block',
                      padding: '1px 6px',
                      border: '1px solid var(--rule-strong)',
                      borderRadius: 3,
                      fontSize: 11,
                      fontFamily: 'var(--mono)',
                    }}>
                      {e.kind}
                    </span>
                  </td>
                  <td>
                    {e.tool
                      ? <span className="mono" style={{ color: 'var(--accent)' }}>{e.tool}</span>
                      : <span className="muted">—</span>}
                  </td>
                  {/* Message — truncation happens SQL-side; we do NOT slice here (200-char rule) */}
                  <td className="mono" style={{ fontSize: 11, color: 'var(--muted)', maxWidth: 340 }}>
                    {e.message}
                  </td>
                  <td>
                    {e.session_title && e.session_title !== e.session_id
                      ? (
                        <div style={{ fontSize: 13, color: 'var(--ink)', marginBottom: 2 }}>
                          {e.session_title}
                        </div>
                      )
                      : null}
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      {e.agent
                        ? <AgentLink name={e.agent} />
                        : <span className="mono muted">main</span>}
                      {' · '}
                      <a href={`/sessions/${e.session_id}`} className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {e.session_id?.slice(0, 8)}
                      </a>
                    </div>
                  </td>
                  <td className="num mono" style={{ color: 'var(--muted)' }}>
                    {e.turn_number != null ? `#${e.turn_number}` : '—'}
                  </td>
                  <td style={{ color: 'var(--muted)', textAlign: 'center' }}>→</td>
                </tr>
              ))}
              {filtered.length === 0 && !loading && (
                <tr>
                  <td colSpan={8} style={{ padding: '32px 0', textAlign: 'center', color: 'var(--muted)' }}>
                    No errors matching this filter — a quiet day.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{fmt.n(filtered.length)} errors</div>
      </section>
    </div>
  )
}
