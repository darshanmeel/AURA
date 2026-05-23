'use client'
import React, { useState, useEffect } from 'react'
import { Eyebrow, Rule, AgentLink, ModelPill, ProviderTag } from '../../components/atoms'
import { fmt } from '../../lib/fmt'

export default function SessionsPage() {
  const [sessions, setSessions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [provider, setProvider] = useState('')
  const [status, setStatus] = useState('')
  const [sort, setSort] = useState('started')

  useEffect(() => {
    const params = new URLSearchParams()
    if (q) params.set('q', q)
    if (provider) params.set('provider', provider)
    if (status) params.set('status', status)
    if (sort) params.set('sort', sort)
    setLoading(true)
    fetch(`/api/sessions?${params}`)
      .then(r => r.json())
      .then(d => { setSessions(d.sessions ?? []); setLoading(false) })
      .catch(() => setLoading(false))
  }, [q, provider, status, sort])

  return (
    <div className="page-layout">
      <div className="page-header">
        <Eyebrow>Sessions</Eyebrow>
        <h2 className="serif">Sessions ledger</h2>
      </div>
      <Rule />

      {/* Filters */}
      <div className="filter-bar">
        <input
          className="filter-search"
          placeholder="Search title, session ID, app…"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <select className="filter-select" value={provider} onChange={e => setProvider(e.target.value)}>
          <option value="">All providers</option>
          <option value="Anthropic">Anthropic</option>
          <option value="Google">Google</option>
        </select>
        <select className="filter-select" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">All status</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
        </select>
        <select className="filter-select" value={sort} onChange={e => setSort(e.target.value)}>
          <option value="started">Newest first</option>
          <option value="cost">By cost</option>
          <option value="turns">By turns</option>
          <option value="tokens">By tokens</option>
        </select>
      </div>

      {loading ? (
        <div className="muted eyebrow">Loading…</div>
      ) : (
        <table className="ledger-table">
          <thead>
            <tr>
              <th>Started</th><th>Person</th><th>App</th><th>Agent</th>
              <th>Title</th><th>Model</th><th>Turns</th><th>Commits</th><th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s: any) => (
              <tr key={s.session_id}>
                <td className="mono muted">{fmt.time(s.start_ts)}</td>
                <td>{s.person_name ?? '—'}</td>
                <td className="mono muted" title={s.cwd}>{s.cwd?.split('/').pop() ?? '—'}</td>
                <td>{s.agent ? <AgentLink name={s.agent} /> : '—'}</td>
                <td><a href={`/sessions/${s.session_id}`}>{s.session_title ?? s.session_id?.slice(0, 12)}</a></td>
                <td>{s.model ? <ModelPill model={s.model} /> : '—'}</td>
                <td className="num">{fmt.n(s.turn_count)}</td>
                <td className="num">{fmt.n(s.commits ?? 0)}</td>
                <td className="num accent">{fmt.usd(s.total_cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="muted eyebrow">{sessions.length} sessions</div>
    </div>
  )
}
