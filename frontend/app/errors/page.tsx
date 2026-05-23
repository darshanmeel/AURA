'use client'

import React, { useState, useEffect } from 'react'
import { Eyebrow, Rule, StatBlock, SeverityTag, AgentLink } from '../../components/atoms'
import { fmt } from '../../lib/fmt'

// ── Types ────────────────────────────────────────────────────────────────────
interface ErrorSummary {
  total_events: number
  hard_errors: number
  warnings: number
  info_events: number
  sessions_affected: number
  tool_failures: number
}

interface KindCount {
  kind: string
  cnt: number
}

interface ErrorRow {
  ts: string
  severity: string
  kind: string
  tool: string | null
  message: string
  session_id: string
  turn_number: number | null
  session_title: string
  agent: string
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function ErrorsPage() {
  const [summary, setSummary]     = useState<ErrorSummary | null>(null)
  const [kinds, setKinds]         = useState<KindCount[]>([])
  const [errors, setErrors]       = useState<ErrorRow[]>([])
  const [activeKind, setActiveKind] = useState<string>('All')
  const [loading, setLoading]     = useState(true)

  // Fetch summary + kinds once on mount
  useEffect(() => {
    Promise.all([
      fetch('/api/errors/summary').then(r => r.json()),
      fetch('/api/errors/kinds').then(r => r.json()),
    ]).then(([s, k]) => {
      setSummary(s ?? null)
      setKinds(Array.isArray(k) ? k : [])
    }).catch(() => {})
  }, [])

  // Fetch filtered errors whenever activeKind changes
  useEffect(() => {
    setLoading(true)
    const qs = activeKind !== 'All' ? `?kind=${encodeURIComponent(activeKind)}` : ''
    fetch(`/api/errors/filtered${qs}`)
      .then(r => r.json())
      .then(d => { setErrors(Array.isArray(d) ? d : []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [activeKind])

  const totalSessions = summary?.sessions_affected ?? 0

  return (
    <div className="page-layout">
      {/* ── MASTHEAD STRAP ───────────────────────────────────────────── */}
      <section className="masthead-strap" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <Eyebrow>Errors · across all sessions · 14 days</Eyebrow>
        {summary && (
          <span style={{
            padding: '2px 10px',
            border: '1px solid var(--rule-strong)',
            borderRadius: 4,
            fontSize: 12,
            fontFamily: 'var(--mono)',
            color: 'var(--muted)'
          }}>
            {fmt.n(summary.total_events)} events
          </span>
        )}
      </section>

      {/* ── HERO ─────────────────────────────────────────────────────── */}
      <section style={{ marginBottom: 32 }}>
        <Eyebrow>The error log</Eyebrow>
        <h1 className="display display-sm" style={{ margin: '8px 0 16px' }}>
          What went <em>wrong.</em>
        </h1>
        <p className="hero-lede" style={{ maxWidth: 560 }}>
          {summary
            ? `${summary.hard_errors} hard error${summary.hard_errors !== 1 ? 's' : ''} · ${summary.warnings} warning${summary.warnings !== 1 ? 's' : ''} · ${summary.info_events} info event${summary.info_events !== 1 ? 's' : ''}.`
            : 'Loading…'}
          {' '}Most agents recover and keep going; the table below is what to grep for in retros.
        </p>
      </section>

      <Rule weight="thick" />

      {/* ── 5-STAT STRIP ─────────────────────────────────────────────── */}
      <section className="kpi-strip" style={{ marginBottom: 24 }}>
        <StatBlock
          label="Total events"
          value={fmt.n(summary?.total_events ?? 0)}
          footnote="14 days"
        />
        <StatBlock
          label="Hard errors"
          value={fmt.n(summary?.hard_errors ?? 0)}
          footnote="severity = error"
          accent
        />
        <StatBlock
          label="Warnings"
          value={fmt.n(summary?.warnings ?? 0)}
          footnote="severity = warn"
        />
        <StatBlock
          label="Affected sessions"
          value={fmt.n(totalSessions)}
          footnote={`of all sessions`}
        />
        <StatBlock
          label="Tool failures"
          value={fmt.n(summary?.tool_failures ?? 0)}
          footnote="Read / Bash / WebFetch"
        />
      </section>

      <Rule />

      {/* ── KIND CHIP FILTER ROW ─────────────────────────────────────── */}
      <section style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '16px 0' }}>
        <button
          className={`chip ${activeKind === 'All' ? 'is-active' : ''}`}
          onClick={() => setActiveKind('All')}
          style={activeKind === 'All' ? { background: 'var(--accent)', color: 'var(--bg)', borderColor: 'var(--accent)' } : {}}
        >
          All
        </button>
        {kinds.map(k => (
          <button
            key={k.kind}
            className={`chip ${activeKind === k.kind ? 'is-active' : ''}`}
            onClick={() => setActiveKind(k.kind)}
            style={activeKind === k.kind ? { background: 'var(--accent)', color: 'var(--bg)', borderColor: 'var(--accent)' } : {}}
          >
            {k.kind}
            <span style={{
              marginLeft: 6,
              padding: '0 5px',
              borderRadius: 3,
              background: activeKind === k.kind ? 'rgba(0,0,0,0.2)' : 'var(--rule)',
              fontSize: 11,
              fontFamily: 'var(--mono)',
            }}>
              {fmt.n(k.cnt)}
            </span>
          </button>
        ))}
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
              {errors.map((e, i) => (
                <tr
                  key={i}
                  style={{ cursor: 'pointer' }}
                  onClick={() => window.location.href = `/sessions/${e.session_id}`}
                >
                  <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>
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
                  <td className="mono" style={{ fontSize: 11, color: 'var(--muted)', maxWidth: 320 }}>
                    {e.message}
                  </td>
                  <td>
                    <div style={{ fontSize: 13, color: 'var(--ink)' }}>
                      {e.session_title !== e.session_id
                        ? e.session_title
                        : <span className="mono muted">{e.session_id?.slice(0, 8)}</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      <AgentLink name={e.agent ?? 'main'} />
                      {' · '}
                      <span className="mono">{e.session_id?.slice(0, 8)}</span>
                    </div>
                  </td>
                  <td className="num mono" style={{ color: 'var(--muted)' }}>
                    {e.turn_number != null ? `#${e.turn_number}` : '—'}
                  </td>
                  <td style={{ color: 'var(--muted)', textAlign: 'center' }}>→</td>
                </tr>
              ))}
              {errors.length === 0 && !loading && (
                <tr>
                  <td colSpan={8} style={{ padding: '32px 0', textAlign: 'center', color: 'var(--muted)' }}>
                    No errors matching this filter — a quiet day.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>{fmt.n(errors.length)} errors</div>
      </section>
    </div>
  )
}
