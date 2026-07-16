'use client'
import React, { Suspense, useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { Eyebrow, Rule, StatBlock, AgentLink, ModelPill, AppLink, SdkBadge, StatusPill } from '../../components/atoms'
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
  const [selected, setSelected] = useState<Set<string>>(new Set())

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

  // Use server-side totals (all matching rows, not just the 200 returned)
  const totalCost    = stats?.total_cost    ?? sessions.reduce((a, s) => a + (s.total_cost ?? 0), 0)
  const totalTurns   = stats?.total_turns   ?? sessions.reduce((a, s) => a + (s.turn_count ?? 0), 0)
  const totalCommits = stats?.total_commits ?? sessions.reduce((a, s) => a + (s.commits ?? 0), 0)
  const totalCount   = stats?.total_count   ?? sessions.length

  return (
    <div className="page-layout">
      {/* Masthead strap */}
      <section className="masthead-strap">
        <Eyebrow>Sessions · all providers</Eyebrow>
        <div className="strap-right">
          <RangeFilter current={range} />
          <span className="strap-pill is-muted">
            {fmt.n(totalCount)} session{totalCount !== 1 ? 's' : ''}
            {sessions.length < totalCount ? ` · showing ${fmt.n(sessions.length)}` : ''}
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
          footnote={sessions.length < totalCount ? `showing ${fmt.n(sessions.length)} of ${fmt.n(totalCount)}` : 'matching filters'}
        />
        <StatBlock label="Cost" value={fmt.usd(totalCost)} footnote="all matching sessions" accent />
        <StatBlock label="Turns" value={fmt.n(totalTurns)} footnote="aggregate" />
        <StatBlock label="Commits" value={fmt.n(totalCommits)} footnote="aggregate" />
      </section>

      <Rule />

      {/* Compare bar — floats when 2 sessions are checked */}
      {selected.size > 0 && (
        <div style={{
          position: 'sticky', top: 0, zIndex: 10,
          background: 'var(--paper, #0e1012)',
          borderBottom: '1px solid var(--rule)',
          padding: '8px 0',
          display: 'flex', alignItems: 'center', gap: 12,
        }}>
          <span className="mono" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
            {selected.size} session{selected.size !== 1 ? 's' : ''} selected
            {selected.size < 2 && <span className="muted"> · select one more to compare</span>}
          </span>
          {selected.size === 2 && (() => {
            const [a, b] = Array.from(selected)
            return (
              <a
                href={`/sessions/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`}
                style={{
                  fontSize: 12,
                  padding: '3px 12px',
                  border: '1px solid var(--accent)',
                  borderRadius: 4,
                  color: 'var(--accent)',
                  textDecoration: 'none',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                Compare →
              </a>
            )
          })()}
          <button
            onClick={() => setSelected(new Set())}
            style={{
              fontSize: 11, padding: '2px 8px',
              border: '1px solid var(--ink-3)',
              borderRadius: 4, background: 'transparent',
              color: 'var(--ink-2)', cursor: 'pointer',
            }}
          >
            Clear
          </button>
        </div>
      )}

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
                <th style={{ width: 28 }}></th>
                <th>Started</th>
                <th>Status</th>
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
              {sessions.map((s: any) => {
                // Prefer app_id from dim_apps join; fall back to cwd last segment
                const appDisplay = s.app_id ?? s.cwd?.split(/[/\\]/).pop()
                // Prompt preview: unwrap JSON blocks and strip command tags
                const titleText = promptToPlain(s.session_title, 200)

                const isSelected = selected.has(s.session_id)
                const canSelect = isSelected || selected.size < 2
                return (
                  <tr
                    key={s.session_id}
                    className="clickable"
                    onClick={() => { window.location.href = `/sessions/${s.session_id}` }}
                    style={isSelected ? { background: 'var(--accent-bg, rgba(127,207,142,0.06))' } : {}}
                  >
                    <td
                      style={{ textAlign: 'center', padding: '0 4px' }}
                      onClick={e => {
                        e.stopPropagation()
                        if (!canSelect && !isSelected) return
                        setSelected(prev => {
                          const next = new Set(prev)
                          if (next.has(s.session_id)) next.delete(s.session_id)
                          else next.add(s.session_id)
                          return next
                        })
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={!canSelect}
                        onChange={() => {/* handled by td click */}}
                        style={{ cursor: canSelect ? 'pointer' : 'not-allowed', accentColor: 'var(--accent)' }}
                      />
                    </td>
                    <td className="mono muted">
                      <div>{fmt.date(s.start_ts)}</div>
                      <div className="tiny">
                        {fmt.time(s.start_ts)}
                        {s.end_ts && ` · ${fmt.duration(s.start_ts, s.end_ts)}`}
                      </div>
                    </td>
                    <td><StatusPill status={s.session_status} /></td>
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
                    <td>
                      {s.model ? <ModelPill model={s.model} /> : '—'}
                      {s.source === 'sdk_trace' && <SdkBadge />}
                    </td>
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
              {sessions.length === 0 && (
                <tr>
                  <td colSpan={14} className="empty">
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
