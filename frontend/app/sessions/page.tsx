'use client'
import React, { useState, useEffect, useMemo } from 'react'
import { Eyebrow, Rule, StatBlock, AgentLink, ModelPill, AppLink } from '../../components/atoms'
import { fmt } from '../../lib/fmt'

function trunc200(s: string | null | undefined): string {
  if (!s) return ''
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}

/**
 * Defensively unwrap a session_title that may contain raw JSON content-block arrays.
 * Pattern: '[{"type":"text","text":"..."}]' or '[{"type":"text","text":"..."},...]'
 * Returns the plain text of the first text block, or the original string.
 */
function unwrapTitle(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = raw.trim()
  // Detect JSON content-block array: starts with [{ and contains "type"
  if (s.startsWith('[{') && s.includes('"type"')) {
    try {
      const blocks = JSON.parse(s)
      if (Array.isArray(blocks)) {
        const text = blocks
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text as string)
          .join(' ')
          .trim()
        if (text) return trunc200(text)
      }
    } catch {
      // fall through to original
    }
  }
  return trunc200(s)
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState(false)
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
    setFetchError(false)
    fetch(`/api/sessions?${params}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(d => {
        setSessions(d.sessions ?? [])
        setLoading(false)
      })
      .catch(() => {
        setFetchError(true)
        setLoading(false)
      })
  }, [q, provider, status, sort])

  // Client-side filter for search (server already does provider/status/sort filtering)
  const filtered = useMemo(() => sessions, [sessions])

  // Aggregate stats over the filtered set
  const totalCost    = filtered.reduce((a, s) => a + (s.total_cost ?? 0), 0)
  const totalTurns   = filtered.reduce((a, s) => a + (s.turn_count ?? 0), 0)
  const totalCommits = filtered.reduce((a, s) => a + (s.commits ?? 0), 0)
  const totalErrors  = filtered.reduce((a, s) => a + (s.errors ?? 0), 0)

  return (
    <div className="page-layout">
      {/* Masthead strap */}
      <section className="masthead-strap">
        <Eyebrow>Sessions · all providers</Eyebrow>
        <div className="strap-right">
          <span className="strap-pill is-muted">
            {filtered.length} session{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>
      </section>

      {/* Hero */}
      <section className="page-head">
        <Eyebrow>The full ledger</Eyebrow>
        <h1 className="display display-sm">
          Every session, <em>line by line.</em>
        </h1>
        <p className="hero-lede" style={{ marginBottom: 24 }}>
          Filter by provider, agent, or status. Click any row to open the per-turn ledger.
        </p>
      </section>

      <Rule weight="thick" />

      {/* Filters */}
      <section className="filters">
        <div className="filter">
          <label>Search</label>
          <input
            type="text"
            className="filter-search"
            placeholder="title, session id, app…"
            value={q}
            onChange={e => setQ(e.target.value)}
          />
        </div>
        <div className="filter">
          <label>Provider</label>
          <div className="select-wrap">
            <select value={provider} onChange={e => setProvider(e.target.value)}>
              <option value="">All providers</option>
              <option value="Anthropic">Anthropic</option>
              <option value="Google">Google</option>
            </select>
            <span className="select-arr">▾</span>
          </div>
        </div>
        <div className="filter">
          <label>Status</label>
          <div className="select-wrap">
            <select value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All status</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
            </select>
            <span className="select-arr">▾</span>
          </div>
        </div>
        <div className="filter">
          <label>Sort by</label>
          <div className="select-wrap">
            <select value={sort} onChange={e => setSort(e.target.value)}>
              <option value="started">Newest first</option>
              <option value="cost">By cost</option>
              <option value="turns">By turns</option>
              <option value="tokens">By tokens</option>
            </select>
            <span className="select-arr">▾</span>
          </div>
        </div>
      </section>

      {/* 5-stat strip for filtered set */}
      <section className="strip strip-tight">
        <StatBlock label="Sessions" value={fmt.n(filtered.length)} footnote="matching filters" />
        <StatBlock label="Cost" value={fmt.usd(totalCost)} footnote="across set" accent />
        <StatBlock label="Turns" value={fmt.n(totalTurns)} footnote="aggregate" />
        <StatBlock label="Commits" value={fmt.n(totalCommits)} footnote="aggregate" />
        <StatBlock label="Errors" value={fmt.n(totalErrors)} footnote="across set" />
      </section>

      <Rule />

      {/* Sessions table */}
      {loading ? (
        <div className="muted eyebrow" style={{ padding: '24px 0' }}>Loading…</div>
      ) : fetchError ? (
        <div className="empty-block" style={{ marginTop: 24 }}>
          Could not load sessions — the database may not be ready yet. Check that the watcher is running and dbt has completed at least one run.
        </div>
      ) : (
        <section style={{ paddingTop: 24 }}>
          <table className="ledger ledger-sessions ledger-sessions-full">
            <thead>
              <tr>
                <th>Started</th>
                <th>Person</th>
                <th>App</th>
                <th>Agent</th>
                <th>Title · Prompt</th>
                <th>Model</th>
                <th className="num">Turns</th>
                <th className="num">Commits</th>
                <th className="num">Cost</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s: any) => {
                // Prefer app_id from dim_apps join; fall back to cwd last segment
                const appDisplay = s.app_id ?? s.cwd?.split(/[/\\]/).pop()
                // Prompt preview: defensively unwrap JSON content-block titles
                const titleText = unwrapTitle(s.session_title)

                return (
                  <tr
                    key={s.session_id}
                    className="clickable"
                    onClick={() => { window.location.href = `/sessions/${s.session_id}` }}
                  >
                    <td className="mono muted">
                      <div>{fmt.date(s.start_ts)}</div>
                      <div className="tiny">
                        {fmt.time(s.start_ts)}
                        {s.end_ts && ` · ${fmt.duration(s.start_ts, s.end_ts)}`}
                      </div>
                    </td>
                    <td>{s.person_name ?? '—'}</td>
                    <td>
                      {appDisplay
                        ? <AppLink appId={appDisplay} appName={appDisplay} />
                        : <span className="muted">—</span>
                      }
                    </td>
                    <td>{s.agent ? <AgentLink name={s.agent} /> : '—'}</td>
                    <td style={{ maxWidth: 340 }}>
                      <div className="sess-title">
                        <a
                          href={`/sessions/${s.session_id}`}
                          onClick={e => e.stopPropagation()}
                        >
                          {titleText || s.session_id?.slice(0, 12)}
                        </a>
                      </div>
                      {s.git_branch && (
                        <div className="tiny muted mono">
                          {s.session_id?.slice(0, 8)} · {s.git_branch}
                        </div>
                      )}
                    </td>
                    <td>{s.model ? <ModelPill model={s.model} /> : '—'}</td>
                    <td className="num">{fmt.n(s.turn_count)}</td>
                    <td className="num">{fmt.n(s.commits ?? 0)}</td>
                    <td className="num strong">{fmt.usd(s.total_cost)}</td>
                    <td className="row-arr">→</td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={10} className="empty">
                    No sessions match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}
