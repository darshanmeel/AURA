'use client'
import React, { useState, useEffect } from 'react'
import { Eyebrow, Rule, SeverityTag } from '../../components/atoms'
import { fmt } from '../../lib/fmt'

const KINDS = ['All', 'tool_error', 'max_tokens', 'refusal']

export default function ErrorsPage() {
  const [errors, setErrors] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [kind, setKind] = useState('All')

  useEffect(() => {
    fetch('/api/errors')
      .then(r => r.json())
      .then(d => { setErrors(d.errors ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  const filtered = kind === 'All' ? errors : errors.filter(e => e.kind === kind)

  return (
    <div className="page-layout">
      <div className="page-header">
        <Eyebrow>Errors</Eyebrow>
        <h2 className="serif">Error log</h2>
        <p className="muted">{errors.length} total errors across all sessions</p>
      </div>
      <Rule />

      {/* Kind filter chips */}
      <div className="chip-bar">
        {KINDS.map(k => (
          <button
            key={k}
            className={`chip ${kind === k ? 'chip--active' : ''}`}
            onClick={() => setKind(k)}
          >
            {k}
            <span className="chip-count muted">
              {k === 'All' ? errors.length : errors.filter(e => e.kind === k).length}
            </span>
          </button>
        ))}
      </div>

      <Rule />

      {loading ? (
        <div className="muted eyebrow">Loading…</div>
      ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th>When</th><th>Severity</th><th>Kind</th><th>Tool</th>
              <th>Message</th><th>Session</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((e: any, i: number) => (
              <tr key={i} onClick={() => window.location.href = `/sessions/${e.session_id}`} style={{ cursor: 'pointer' }}>
                <td className="mono muted">{fmt.time(e.ts)}</td>
                <td><SeverityTag severity={e.severity} /></td>
                <td className="mono">{e.kind}</td>
                <td className="mono muted">{e.tool ?? '—'}</td>
                <td className="muted">{e.message?.slice(0, 80) ?? '—'}</td>
                <td className="mono muted"><a href={`/sessions/${e.session_id}`}>{e.session_id?.slice(0, 8)}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="muted eyebrow">{filtered.length} errors</div>
    </div>
  )
}
