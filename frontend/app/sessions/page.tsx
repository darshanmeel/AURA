'use client'
import React, { Suspense, useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { Eyebrow, Rule, StatBlock, AgentLink, ModelPill, AppLink } from '../../components/atoms'
import { RangeFilter } from '../../components/RangeFilter'
import { parseRange } from '../../lib/range'
import { fmt } from '../../lib/fmt'
import { promptToPlain } from '../../lib/prompt-display'

function SessionsPageInner() {
  const searchParams = useSearchParams()
  const range = parseRange(searchParams?.get('range') ?? undefined)

  const [sessions, setSessions] = useState<any[]>([])
  const [stats, setStats] = useState<any>(null)
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
    params.set('range', range)
    setLoading(true)
    setFetchError(false)
    fetch(`/api/sessions?${params}`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(d => {
        setSessions(d.sessions ?? [])
        setStats(d.stats ?? null)
        setLoading(false)
      })
      .catch(() => {
        setFetchError(true)
        setLoading(false)
      })
  }, [q, provider, status, sort, range])

  // Client-side filter for search (server already does provider/status/sort filtering)
  const filtered = useMemo(() => sessions, [sessions])

  // Use server-side totals (all matching rows, not just the 200 returned)
  const totalCost    = stats?.total_cost    ?? filtered.reduce((a, s) => a + (s.total_cost ?? 0), 0)
  const totalTurns   = stats?.total_turns   ?? filtered.reduce((a, s) => a + (s.turn_count ?? 0), 0)
  const totalCommits = stats?.total_commits ?? filtered.reduce((a, s) => a + (s.commits ?? 0), 0)
  const totalCount   = stats?.total_count   ?? filtered.length

  return (
    <div className="page-layout">
      {/* Masthead strap */}
      <section className="masthead-strap">
        <Eyebrow>Sessions · all providers</Eyebrow>
        <div className="strap-right">
          <RangeFilter current={range} />
          <span className="strap-pill is-muted">
            {fmt.n(totalCount)} session{totalCount !== 1 ? 's' : ''}
            {filtered.length < totalCount ? ` · showing ${fmt.n(filtered.length)}` : ''}
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
        <StatBlock
          label="Sessions"
          value={fmt.n(totalCount)}
          footnote={filtered.length < totalCount ? `showing ${fmt.n(filtered.length)} of ${fmt.n(totalCount)}` : 'matching filters'}
        />
        <StatBlock label="Cost" value={fmt.usd(totalCost)} footnote="all matching sessions" accent />
        <StatBlock label="Turns" value={fmt.n(totalTurns)} footnote="aggregate" />
        <StatBlock label="Commits" value={fmt.n(totalCommits)} footnote="aggregate" />
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
                <th className="num" title="Skills loaded in this session">🧩</th>
                <th className="num" title="MCP servers loaded">⚡</th>
                <th className="num">Cost</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s: any) => {
                // Prefer app_id from dim_apps join; fall back to cwd last segment
                const appDisplay = s.app_id ?? s.cwd?.split(/[/\\]/).pop()
                // Prompt preview: unwrap JSON blocks and strip command tags
                const titleText = promptToPlain(s.session_title, 200)

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
                    <td title={Array.isArray(s.agents) ? s.agents.join(', ') : ''}>
                      {(() => {
                        const list: string[] = Array.isArray(s.agents) && s.agents.length
                          ? Array.from(new Set(s.agents.filter(Boolean)))
                          : (s.agent ? [s.agent] : [])
                        if (list.length === 0) return '—'
                        // Prefer real subagents over 'main' in the visible slot.
                        const sorted = [...list].sort((a, b) =>
                          (a === 'main' ? 1 : 0) - (b === 'main' ? 1 : 0)
                        )
                        const head = sorted.slice(0, 2)
                        const rest = sorted.length - head.length
                        return (
                          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
                            {head.map(a => <AgentLink key={a} name={a} />)}
                            {rest > 0 && (
                              <span className="mono muted" style={{ fontSize: 11 }}>+{rest}</span>
                            )}
                          </span>
                        )
                      })()}
                    </td>
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
                    <td
                      className="num mono"
                      title={Array.isArray(s.skills_loaded) ? s.skills_loaded.join(', ') : ''}
                      style={{ color: Number(s.skill_count ?? 0) > 0 ? 'var(--accent)' : 'var(--muted)' }}
                    >
                      {fmt.n(s.skill_count ?? 0)}
                    </td>
                    <td
                      className="num mono"
                      title={Array.isArray(s.mcp_servers) ? s.mcp_servers.join(', ') : ''}
                      style={{ color: Number(s.mcp_count ?? 0) > 0 ? 'var(--accent-2, #efe6d6)' : 'var(--muted)' }}
                    >
                      {fmt.n(s.mcp_count ?? 0)}
                    </td>
                    <td className="num strong">{fmt.usd(s.total_cost)}</td>
                    <td className="row-arr">→</td>
                  </tr>
                )
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={12} className="empty">
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

export default function SessionsPage() {
  return (
    <Suspense fallback={<div className="muted eyebrow" style={{ padding: '24px 0' }}>Loading…</div>}>
      <SessionsPageInner />
    </Suspense>
  )
}
