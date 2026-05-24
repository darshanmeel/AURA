'use client'

import React, { useState, useEffect } from 'react'
import { Eyebrow, Rule, StatBlock, SeverityTag, AgentLink } from '../../components/atoms'
import { fmt } from '../../lib/fmt'

function unwrapTitle(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = raw.trim()
  if (s.startsWith('[{') && s.includes('"type"')) {
    try {
      const blocks = JSON.parse(s)
      if (Array.isArray(blocks)) {
        const text = blocks.filter((b: any) => b.type === 'text' && b.text).map((b: any) => b.text as string).join(' ').trim()
        if (text) return text.length > 80 ? text.slice(0, 80) + '…' : text
      }
    } catch { /* fall through */ }
  }
  return s.length > 80 ? s.slice(0, 80) + '…' : s
}

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
      <section className="masthead-strap">
        <Eyebrow>Errors · across all sessions · 14 days</Eyebrow>
        <div className="strap-right">
          <span className="strap-pill is-muted">{fmt.n(allErrors.length)} events</span>
        </div>
      </section>

      {/* ── HERO ─────────────────────────────────────────────────────── */}
      <section className="page-head">
        <Eyebrow>The error log</Eyebrow>
        <h1 className="display display-sm">
          What went <em>wrong.</em>
        </h1>
        <p className="hero-lede">
          {bySev.error ?? 0} hard error{(bySev.error ?? 0) !== 1 ? 's' : ''}{' '}
          · {bySev.warn ?? 0} warning{(bySev.warn ?? 0) !== 1 ? 's' : ''}{' '}
          · {bySev.info ?? 0} info event{(bySev.info ?? 0) !== 1 ? 's' : ''}.{' '}
          Most agents recover and keep going; the table below is what to grep for in retros.
        </p>
      </section>

      <Rule weight="thick" />

      {/* ── 5-STAT STRIP ─────────────────────────────────────────────── */}
      <section className="strip strip-tight">
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
      <section className="chip-row">
        {(['All', ...kinds] as string[]).map(k => (
          <button
            key={k}
            className={`chip${activeKind === k ? ' is-active' : ''}`}
            onClick={() => setActiveKind(k)}
          >
            {k}
            {k !== 'All' && <span className="chip-count">{fmt.n(byKind[k])}</span>}
          </button>
        ))}
      </section>

      {/* ── ERROR TABLE ──────────────────────────────────────────────── */}
      <section style={{ paddingTop: 8 }}>
        {loading ? (
          <div className="muted eyebrow" style={{ padding: '24px 0' }}>Loading…</div>
        ) : (
          <table className="ledger ledger-errors" style={{ width: '100%' }}>
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
                        <div className="sess-title-sm" style={{ marginBottom: 2 }}>
                          {unwrapTitle(e.session_title)}
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
                  <td colSpan={8} className="empty">
                    No errors matching this filter — a quiet day.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <div className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 11, marginTop: 8, letterSpacing: '0.04em' }}>{fmt.n(filtered.length)} error{filtered.length !== 1 ? 's' : ''} shown</div>
      </section>
    </div>
  )
}
