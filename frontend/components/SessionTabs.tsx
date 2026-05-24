'use client'

import React, { useState } from 'react'
import { Eyebrow, Rule, StatBlock, ModelPill, SeverityTag, BarRow, AgentLink } from './atoms'
import { fmt } from '../lib/fmt'

interface SessionTabsProps {
  s: any
  turns: any[]
  errors: any[]
  toolExecutions: any[]
  gitCommands: any[]
  files: any[]
  toolMix: any[]
  prompts?: any[]
  filesWithAttribution?: any[]
}

// ── Title unwrap helper (guards against raw JSON content-block arrays) ────────
function unwrapTitle(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = raw.trim()
  if (s.startsWith('[{') && s.includes('"type"')) {
    try {
      const blocks = JSON.parse(s)
      if (Array.isArray(blocks)) {
        const text = blocks
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text as string)
          .join(' ')
          .trim()
        if (text) return text
      }
    } catch { /* fall through */ }
  }
  return s
}

// ── Inline TurnChart (ported from design's session.jsx) ─────────────────────
// Stacks bars [cacheR, cacheW, out, in] per turn, overlays a context-% line.
function TurnChart({ turns }: { turns: any[] }) {
  if (!turns.length) {
    return <div className="empty-block">Per-turn detail not retained for this session.</div>
  }

  const w = 1200, h = 280, pad = { l: 48, r: 48, t: 16, b: 28 }
  const innerW = w - pad.l - pad.r
  const innerH = h - pad.t - pad.b
  const n = turns.length
  const colW = innerW / n
  const barW = colW * 0.62

  const maxTokens = Math.max(
    ...turns.map((t: any) =>
      (t.cache_read_input_tokens ?? 0) +
      (t.ephemeral_5m_input_tokens ?? 0) +
      (t.ephemeral_1h_input_tokens ?? 0) +
      (t.output_tokens ?? 0) +
      (t.input_tokens ?? 0)
    ),
    1
  )
  const maxCtx = Math.max(...turns.map((t: any) => t.context_pct ?? 0), 0.01)

  const ctxPts = turns.map((t: any, i: number) => {
    const x = pad.l + colW * (i + 0.5)
    const y = pad.t + innerH - ((t.context_pct ?? 0) / maxCtx) * innerH * 0.95
    return [x, y] as [number, number]
  })
  const ctxPath = 'M' + ctxPts.map(([x, y]) => `${x},${y}`).join(' L')

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${w} ${h}`} className="chart" preserveAspectRatio="none">
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map(g => (
          <line
            key={g}
            x1={pad.l} x2={w - pad.r}
            y1={pad.t + innerH * (1 - g)} y2={pad.t + innerH * (1 - g)}
            stroke="var(--rule)" strokeWidth="0.5" strokeDasharray="2,3"
          />
        ))}
        {/* Left axis labels (token scale) */}
        {[0, 0.5, 1].map(g => (
          <text
            key={g}
            x={pad.l - 8} y={pad.t + innerH * (1 - g) + 3}
            className="axis-text" textAnchor="end" fontSize={9} fill="var(--muted)"
          >
            {fmt.k(maxTokens * g)}
          </text>
        ))}
        {/* Right axis labels (context % scale) */}
        {[0, 0.5, 1].map(g => (
          <text
            key={g}
            x={w - pad.r + 8} y={pad.t + innerH * (1 - g) + 3}
            className="axis-text" textAnchor="start" fontSize={9} fill="var(--muted)"
          >
            {Math.round(maxCtx * g * 100)}%
          </text>
        ))}

        {/* Stacked bars per turn */}
        {turns.map((t: any, i: number) => {
          const x = pad.l + colW * i + (colW - barW) / 2
          const segs = [
            { v: t.cache_read_input_tokens ?? 0,  c: 'var(--muted-bar)' },
            { v: (t.ephemeral_5m_input_tokens ?? 0) + (t.ephemeral_1h_input_tokens ?? 0), c: 'var(--accent)' },
            { v: t.output_tokens ?? 0,             c: 'var(--ink)' },
            { v: t.input_tokens ?? 0,              c: 'var(--accent-2)' },
          ]
          let yCursor = pad.t + innerH
          return (
            <g key={i}>
              {segs.map((seg, j) => {
                const segH = (seg.v / maxTokens) * innerH
                yCursor -= segH
                return (
                  <rect
                    key={j}
                    x={x} y={yCursor}
                    width={barW} height={Math.max(segH, 0)}
                    fill={seg.c}
                  />
                )
              })}
            </g>
          )
        })}

        {/* Context % overlay line */}
        <path d={ctxPath} stroke="var(--accent-2)" strokeWidth="1.4" fill="none" />
        {ctxPts.map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="1.4" fill="var(--accent-2)" />
        ))}

        {/* X-axis turn labels every 10 */}
        {turns.map((t: any, i: number) => i % 10 === 0 && (
          <text
            key={i}
            x={pad.l + colW * (i + 0.5)} y={h - 8}
            className="axis-text" textAnchor="middle" fontSize={9} fill="var(--muted)"
          >
            #{t.turn_number ?? i + 1}
          </text>
        ))}
      </svg>
    </div>
  )
}

function LegendSwatch({ color, label, line }: { color: string; label: string; line?: boolean }) {
  return (
    <div className="legend-item" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 16 }}>
      {line
        ? <span style={{ display: 'inline-block', width: 16, height: 2, borderTop: `2px solid ${color}` }} />
        : <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: color }} />
      }
      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>
    </div>
  )
}

// ── Overkill chip ────────────────────────────────────────────────────────────
function OverkillChip({ reason }: { reason: string }) {
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 6px',
      border: '1px solid var(--accent)',
      borderRadius: 3,
      fontSize: 10,
      color: 'var(--accent)',
      fontFamily: 'var(--mono)',
      lineHeight: 1.5,
    }}>
      overkill: {reason}
    </span>
  )
}

// ── Duration seconds → human string ─────────────────────────────────────────
function fmtSecs(s: number | null | undefined): string {
  if (s == null) return '—'
  const n = Math.round(s)
  if (n < 60) return `${n}s`
  return `${Math.floor(n / 60)}m ${n % 60}s`
}

// ── Compact message bubble for Messages tab ──────────────────────────────────
const PREVIEW_LEN = 280

function MessageTurn({ turn }: { turn: any }) {
  const [userExpanded, setUserExpanded] = React.useState(false)
  const [assistExpanded, setAssistExpanded] = React.useState(false)

  const userText: string = turn.user_prompt ?? ''
  const assistText: string = turn.assistant_response ?? ''
  const userTrunc = !userExpanded && userText.length > PREVIEW_LEN
  const assistTrunc = !assistExpanded && assistText.length > PREVIEW_LEN

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Turn header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="mono muted" style={{ fontSize: 11, minWidth: 36 }}>
          #{String(turn.turn_number).padStart(3, '0')}
        </span>
        <span className="mono muted" style={{ fontSize: 11 }}>{fmt.time(turn.assistant_ts)}</span>
        <span className="muted" style={{ fontSize: 11 }}>·</span>
        <span className="mono muted" style={{ fontSize: 11 }}>
          {fmt.k((turn.input_tokens ?? 0) + (turn.output_tokens ?? 0))} tok
        </span>
        {turn.context_pct > 0 && (
          <>
            <span className="muted" style={{ fontSize: 11 }}>·</span>
            <span className={`mono`} style={{ fontSize: 11, color: (turn.context_pct ?? 0) > 0.7 ? 'var(--warn)' : 'var(--muted)' }}>
              {fmt.pct(turn.context_pct)} ctx
            </span>
          </>
        )}
      </div>

      {/* User bubble */}
      {userText && (
        <div style={{ marginLeft: 44 }}>
          <div style={{
            padding: '8px 12px',
            borderLeft: '2px solid var(--accent-2)',
            background: 'rgba(239,230,214,0.06)',
            borderRadius: '0 4px 4px 0',
          }}>
            <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 4, fontFamily: 'var(--mono)' }}>
              USER
            </div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--ink-2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {userTrunc ? userText.slice(0, PREVIEW_LEN) + '…' : userText}
            </p>
            {userText.length > PREVIEW_LEN && (
              <button
                onClick={() => setUserExpanded(!userExpanded)}
                style={{ marginTop: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--accent)', padding: 0 }}
              >
                {userExpanded ? '▲ collapse' : `▼ show all (${userText.length} chars)`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Assistant bubble */}
      {assistText && (
        <div style={{ marginLeft: 44 }}>
          <div style={{
            padding: '8px 12px',
            borderLeft: '2px solid var(--ink-2)',
            borderRadius: '0 4px 4px 0',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', color: 'var(--muted)', fontFamily: 'var(--mono)' }}>
                CLAUDE
              </div>
              <span className="mono muted" style={{ fontSize: 10 }}>{fmt.k(turn.output_tokens)} out</span>
            </div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {assistTrunc ? assistText.slice(0, PREVIEW_LEN) + '…' : assistText}
            </p>
            {assistText.length > PREVIEW_LEN && (
              <button
                onClick={() => setAssistExpanded(!assistExpanded)}
                style={{ marginTop: 4, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--accent)', padding: 0 }}
              >
                {assistExpanded ? '▲ collapse' : `▼ show all (${assistText.length} chars)`}
              </button>
            )}
          </div>
        </div>
      )}

      {/* No text placeholder */}
      {!userText && !assistText && (
        <div className="muted" style={{ marginLeft: 44, fontSize: 12, fontStyle: 'italic' }}>
          No message text retained for this turn.
        </div>
      )}
    </div>
  )
}

// ── Main component ───────────────────────────────────────────────────────────
export function SessionTabs({
  s, turns, errors, toolExecutions, gitCommands,
  files, toolMix, prompts = [], filesWithAttribution = []
}: SessionTabsProps) {
  const [activeTab, setActiveTab] = useState<'details' | 'prompts' | 'agents' | 'errors' | 'files' | 'tokens' | 'tools' | 'git' | 'messages'>('details')

  const maxToolCalls = Math.max(...(toolMix ?? []).map((t: any) => t.calls ?? 0), 1)
  const maxEdits     = Math.max(...(files ?? []).map((f: any) => f.edit_count ?? 0), 1)

  // For the files tab, prefer attributed data; fall back to plain files
  const filePanelData = filesWithAttribution.length ? filesWithAttribution : files

  return (
    <div className="session-tabs-container">
      <div className="tab-nav">
        <button className={`tab-btn ${activeTab === 'details'  ? 'active' : ''}`} onClick={() => setActiveTab('details')}>Details</button>
        <button className={`tab-btn ${activeTab === 'messages' ? 'active' : ''}`} onClick={() => setActiveTab('messages')}>Messages{turns.length > 0 ? ` (${turns.length})` : ''}</button>
        <button className={`tab-btn ${activeTab === 'prompts'  ? 'active' : ''}`} onClick={() => setActiveTab('prompts')}>Prompts</button>
        <button className={`tab-btn ${activeTab === 'agents'   ? 'active' : ''}`} onClick={() => setActiveTab('agents')}>Agents</button>
        <button className={`tab-btn ${activeTab === 'errors'   ? 'active' : ''}`} onClick={() => setActiveTab('errors')}>Errors{errors.length > 0 ? ` (${errors.length})` : ''}</button>
        <button className={`tab-btn ${activeTab === 'files'    ? 'active' : ''}`} onClick={() => setActiveTab('files')}>Files</button>
        <button className={`tab-btn ${activeTab === 'tokens'   ? 'active' : ''}`} onClick={() => setActiveTab('tokens')}>Tokens</button>
        <button className={`tab-btn ${activeTab === 'tools'    ? 'active' : ''}`} onClick={() => setActiveTab('tools')}>Tools</button>
        <button className={`tab-btn ${activeTab === 'git'      ? 'active' : ''}`} onClick={() => setActiveTab('git')}>Git</button>
      </div>

      <div className="tab-content">
        {/* ── DETAILS TAB ─────────────────────────────────────────────── */}
        {activeTab === 'details' && (
          <div className="tab-panel">
            {/* Turns table */}
            {turns.length > 0 ? (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                  <Eyebrow>Turns — table view</Eyebrow>
                  <span className="muted" style={{ fontSize: 12 }}>first {Math.min(turns.length, 20)} of {turns.length}</span>
                </div>
                <table className="ledger-table" style={{ tableLayout: 'fixed', width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>#</th>
                      <th style={{ width: 72 }}>Time</th>
                      <th className="num" style={{ width: 72 }}>In</th>
                      <th className="num" style={{ width: 72 }}>Out</th>
                      <th className="num" style={{ width: 110 }}>Cache W</th>
                      <th className="num" style={{ width: 80 }}>Cache R</th>
                      <th style={{ width: 100 }}>Stop</th>
                      <th style={{ width: 80 }}>Tool</th>
                      <th className="num" style={{ width: 60 }}>Ctx %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {turns.slice(0, 20).map((t: any) => (
                      <tr key={t.turn_number}>
                        <td className="muted mono">{String(t.turn_number).padStart(3, '0')}</td>
                        <td className="mono muted" style={{ fontSize: 11 }}>{fmt.time(t.assistant_ts)}</td>
                        <td className="num">{fmt.n(t.input_tokens)}</td>
                        <td className="num">{fmt.n(t.output_tokens)}</td>
                        <td className="num">
                          <span className="muted">{fmt.k(t.ephemeral_5m_input_tokens)}</span>
                          {' / '}
                          <span style={{ color: 'var(--accent)' }}>{fmt.k(t.ephemeral_1h_input_tokens)}</span>
                        </td>
                        <td className="num">{fmt.k(t.cache_read_input_tokens)}</td>
                        <td>
                          {t.stop_reason
                            ? <span className={`pill ${t.stop_reason === 'end_turn' ? 'pill-end' : 'pill-tool'}`}>{t.stop_reason}</span>
                            : <span className="muted">—</span>}
                        </td>
                        <td>
                          {t.tool_name
                            ? <span className="mono" style={{ color: 'var(--accent)', fontSize: 11 }}>{t.tool_name}</span>
                            : <span className="muted">—</span>}
                        </td>
                        <td className="num">
                          <span className={(t.context_pct ?? 0) > 0.7 ? 'warn' : ''}>
                            {fmt.pct(t.context_pct)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Rule />
              </>
            ) : (
              <div className="empty-block" style={{ marginBottom: 24 }}>No turn data retained for this session.</div>
            )}

          </div>
        )}

        {/* ── ERRORS TAB ──────────────────────────────────────────────── */}
        {activeTab === 'errors' && (
          <div className="tab-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <Eyebrow>Errors · this session</Eyebrow>
              <span className="muted" style={{ fontSize: 12 }}>{errors.length} event{errors.length !== 1 ? 's' : ''}</span>
            </div>
            {errors.length === 0 ? (
              <div className="empty-block">No error events recorded — a clean run.</div>
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Severity</th>
                    <th>Kind</th>
                    <th>Tool</th>
                    <th>Message</th>
                    <th className="num">Turn</th>
                  </tr>
                </thead>
                <tbody>
                  {errors.map((e: any, i: number) => (
                    <tr key={i}>
                      <td className="mono muted" style={{ fontSize: 11 }}>{fmt.time(e.ts)}</td>
                      <td><SeverityTag severity={e.severity} /></td>
                      <td><span className="kind-tag mono">{e.kind}</span></td>
                      <td>{e.tool ? <span className="mono" style={{ color: 'var(--accent)' }}>{e.tool}</span> : <span className="muted">—</span>}</td>
                      <td className="muted err-msg mono" style={{ fontSize: 11 }}>{e.message}</td>
                      <td className="num">#{e.turn_number}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── MESSAGES TAB ────────────────────────────────────────────── */}
        {activeTab === 'messages' && (
          <div className="tab-panel">
            {turns.length === 0 ? (
              <div className="empty-block">No message data retained for this session.</div>
            ) : (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 20 }}>
                  <Eyebrow>Conversation · turn by turn</Eyebrow>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {turns.length} turn{turns.length !== 1 ? 's' : ''}{turns.length >= 60 ? ' · first 60 shown' : ''}
                  </span>
                </div>
                <div className="messages-feed" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {turns.map((t: any) => (
                    <MessageTurn key={t.turn_number} turn={t} />
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── PROMPTS TAB ─────────────────────────────────────────────── */}
        {activeTab === 'prompts' && (
          <div className="tab-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 20 }}>
              <Eyebrow>Prompts · in their voice</Eyebrow>
              <span className="muted" style={{ fontSize: 12 }}>
                {prompts.length} prompt{prompts.length !== 1 ? 's' : ''} · what was asked, what happened
              </span>
            </div>
            {prompts.length === 0 ? (
              <div className="empty-block">No operator prompts recorded for this session.</div>
            ) : (
              <ol className="prompts" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 0 }}>
                {prompts.map((p: any, i: number) => (
                  <li key={p.prompt_id ?? i} className="prompt" style={{ borderTop: '1px solid var(--rule)', padding: '16px 0' }}>
                    {/* Header row: date · time · agent · model · overkill */}
                    <div className="prompt-meta" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                      <span className="mono muted" style={{ fontSize: 11 }}>
                        #{String((p.prompt_idx ?? i) + 1).padStart(2, '0')} · {fmt.date(p.prompt_ts)} · {fmt.time(p.prompt_ts)}
                        {p.duration_seconds != null && ` · ${fmtSecs(p.duration_seconds)}`}
                      </span>
                      {p.agent && <AgentLink name={p.agent} />}
                      {p.model_primary && <ModelPill model={p.model_primary} />}
                      {p.is_overkill && p.overkill_reason && <OverkillChip reason={p.overkill_reason} />}
                    </div>

                    {/* Quote */}
                    {p.prompt_text_200 && (
                      <p className="prompt-text" style={{ fontStyle: 'italic', color: 'var(--ink-2)', margin: '0 0 10px', lineHeight: 1.6 }}>
                        &ldquo;{unwrapTitle(p.prompt_text_200)}&rdquo;
                      </p>
                    )}

                    {/* Mini stats row */}
                    <div className="prompt-mini-stats" style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                      {p.turn_count != null && <span>{fmt.n(p.turn_count)} turns</span>}
                      {p.tool_call_count != null && <span>{fmt.n(p.tool_call_count)} tools</span>}
                      {p.files_edited != null && <span>{fmt.n(p.files_edited)} files</span>}
                      {p.output_tokens_total != null && <span>{fmt.k(p.output_tokens_total)} tok</span>}
                      {p.cost_total != null && <span style={{ color: 'var(--accent)' }}>{fmt.usd(p.cost_total)}</span>}
                      {p.errors_caught > 0 && <span style={{ color: 'var(--warn)' }}>{p.errors_caught} err</span>}
                    </div>

                    {/* Summary */}
                    {p.summary_200 && (
                      <p style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.55, margin: '8px 0 0' }}>
                        {p.summary_200}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}

        {/* ── AGENTS TAB ──────────────────────────────────────────────── */}
        {activeTab === 'agents' && (
          <div className="tab-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
              <Eyebrow>Agents · in this session</Eyebrow>
              <span className="muted" style={{ fontSize: 12 }}>
                {Array.isArray(s.agents) ? s.agents.length : 1} distinct agent{Array.isArray(s.agents) && s.agents.length !== 1 ? 's' : ''}
              </span>
            </div>
            {(() => {
              const agentsList: string[] = Array.isArray(s.agents) && s.agents.length > 0
                ? s.agents
                : (s.agent ? [s.agent] : [])
              if (agentsList.length === 0) {
                return <div className="empty-block">No resolved agents for this session.</div>
              }
              // Per-agent prompt rollup from the prompts array we already have
              const byAgent: Record<string, { prompts: number; tools: number; files: number; cost: number; tokens: number; errors: number }> = {}
              for (const p of (prompts ?? [])) {
                const a = p.agent ?? 'main'
                if (!byAgent[a]) byAgent[a] = { prompts: 0, tools: 0, files: 0, cost: 0, tokens: 0, errors: 0 }
                byAgent[a].prompts += 1
                byAgent[a].tools   += p.tool_call_count     ?? 0
                byAgent[a].files   += p.files_edited        ?? 0
                byAgent[a].cost    += p.cost_total          ?? 0
                byAgent[a].tokens  += p.output_tokens_total ?? 0
                byAgent[a].errors  += p.errors_caught       ?? 0
              }
              const totalCost = Math.max(...Object.values(byAgent).map(v => v.cost), 0.001)
              return (
                <table className="ledger-table" style={{ tableLayout: 'fixed', width: '100%' }}>
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th className="num" style={{ width: 90 }}>Prompts</th>
                      <th className="num" style={{ width: 90 }}>Tool calls</th>
                      <th className="num" style={{ width: 80 }}>Files</th>
                      <th className="num" style={{ width: 100 }}>Tokens</th>
                      <th className="num" style={{ width: 90 }}>Cost</th>
                      <th className="num" style={{ width: 70 }}>Errors</th>
                      <th style={{ width: 120 }}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agentsList.map((a: string) => {
                      const v = byAgent[a] ?? { prompts: 0, tools: 0, files: 0, cost: 0, tokens: 0, errors: 0 }
                      const sharePct = (v.cost / totalCost) * 100
                      return (
                        <tr key={a}>
                          <td><AgentLink name={a} /></td>
                          <td className="num mono">{fmt.n(v.prompts)}</td>
                          <td className="num mono">{fmt.n(v.tools)}</td>
                          <td className="num mono">{fmt.n(v.files)}</td>
                          <td className="num mono">{fmt.k(v.tokens)}</td>
                          <td className="num mono strong">{fmt.usd(v.cost)}</td>
                          <td className="num mono">{v.errors > 0 ? <span style={{ color: 'var(--warn)' }}>{v.errors}</span> : '—'}</td>
                          <td>
                            <div className="tbar" style={{ width: '100%', height: 6, background: 'var(--rule)', borderRadius: 1, overflow: 'hidden' }}>
                              <div className="tbar-fill" style={{ width: `${sharePct}%`, height: '100%', background: 'var(--accent)' }} />
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )
            })()}
          </div>
        )}

        {/* ── FILES TAB ───────────────────────────────────────────────── */}
        {activeTab === 'files' && (
          <div className="tab-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
              <Eyebrow>Files · this session</Eyebrow>
              <span className="muted" style={{ fontSize: 12 }}>
                {filePanelData.length} file{filePanelData.length !== 1 ? 's' : ''}
                {filesWithAttribution.length > 0 ? ' · with attribution' : ' · edit counts only'}
              </span>
            </div>
            {filePanelData.length === 0 ? (
              <div className="empty-block">No files recorded for this session.</div>
            ) : (
              <table className="ledger-table" style={{ tableLayout: 'fixed', width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Path</th>
                    <th className="num" style={{ width: 90 }}>Tokens</th>
                    <th className="num" style={{ width: 90 }}>Time</th>
                    <th className="num" style={{ width: 80 }}>Cost</th>
                    <th className="num" style={{ width: 70 }}>Edits</th>
                  </tr>
                </thead>
                <tbody>
                  {filePanelData.map((f: any) => (
                    <tr key={f.file_path}>
                      <td className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.file_path}>
                        {f.file_path?.split(/[/\\]/).pop() ?? f.file_path}
                      </td>
                      <td className="num mono">
                        {f.tokens_attributed != null ? fmt.k(f.tokens_attributed) : '—'}
                      </td>
                      <td className="num mono">
                        {f.duration_attributed_seconds != null ? fmtSecs(f.duration_attributed_seconds) : '—'}
                      </td>
                      <td className="num mono">
                        {f.cost_attributed != null ? fmt.usd(f.cost_attributed) : '—'}
                      </td>
                      <td className="num mono">
                        {fmt.n(f.edit_count ?? 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── TOKENS TAB ──────────────────────────────────────────────── */}
        {activeTab === 'tokens' && (
          <div className="tab-panel">
            {/* TurnChart — stacked bars */}
            <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
              <Eyebrow>Per-turn ledger</Eyebrow>
              <span className="section-meta muted" style={{ fontSize: 12 }}>
                {turns.length} turns sampled · stacked tokens · context % overlay
              </span>
            </div>
            <TurnChart turns={turns} />
            {turns.length > 0 && (
              <div className="chart-legend" style={{ marginTop: 8, marginBottom: 24 }}>
                <LegendSwatch color="var(--muted-bar)" label="Cache read" />
                <LegendSwatch color="var(--accent)"    label="Cache write" />
                <LegendSwatch color="var(--ink)"       label="Output" />
                <LegendSwatch color="var(--accent-2)"  label="Fresh input" />
                <LegendSwatch color="var(--accent-2)"  label="Context %" line />
              </div>
            )}

            <Rule />

            {/* Tokens · where — stack-bar panel */}
            {(() => {
              const breakdown = [
                { name: 'Cache read',       value: s.cache_read_total ?? 0,       color: 'var(--muted-bar)' },
                { name: 'Cache write · 5m', value: s.ephemeral_5m_total ?? 0,     color: 'var(--ink-2)' },
                { name: 'Cache write · 1h', value: s.ephemeral_1h_total ?? 0,     color: 'var(--accent)' },
                { name: 'Output',           value: s.total_output_tokens ?? 0,    color: 'var(--ink)' },
                { name: 'Fresh input',      value: s.total_input_tokens ?? 0,     color: 'var(--accent-2)' },
              ]
              const totalU = breakdown.reduce((a, b) => a + b.value, 0)
              if (!totalU) return null
              return (
                <div style={{ marginBottom: 32 }}>
                  <Eyebrow>Tokens · where</Eyebrow>
                  <div className="stack-bar" style={{ display: 'flex', height: 8, borderRadius: 2, overflow: 'hidden', margin: '8px 0 12px' }}>
                    {breakdown.map(b => (
                      <div
                        key={b.name}
                        style={{ width: `${(b.value / totalU) * 100}%`, background: b.color }}
                        title={`${b.name} · ${fmt.n(b.value)}`}
                      />
                    ))}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {breakdown.map(b => (
                      <div key={b.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: b.color, flexShrink: 0 }} />
                        <span style={{ flex: 1, color: 'var(--muted)' }}>{b.name}</span>
                        <span className="mono">{fmt.k(b.value)}</span>
                        <span className="muted" style={{ width: 40, textAlign: 'right' }}>{totalU > 0 ? `${((b.value / totalU) * 100).toFixed(0)}%` : '—'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}

            <Rule />

            {/* Cost per turn + model summary strip */}
            <div className="strip strip-tight" style={{ marginBottom: 0 }}>
              <StatBlock
                label="Total Input"
                value={fmt.k(s.total_input_tokens)}
                footnote="tokens into the model"
              />
              <StatBlock
                label="Total Output"
                value={fmt.k(s.total_output_tokens)}
                footnote="tokens generated"
              />
              <StatBlock
                label="Cache read"
                value={fmt.k(s.cache_read_total)}
                footnote="0.10× input cost"
              />
              <StatBlock
                label="Cache 5m"
                value={fmt.k(s.ephemeral_5m_total)}
                footnote="1.25× input cost"
              />
              <StatBlock
                label="Cache 1h"
                value={fmt.k(s.ephemeral_1h_total)}
                footnote="2.5× input cost"
                accent
              />
              <StatBlock
                label="$ / turn"
                value={fmt.usd((s.turn_count ?? 0) > 0 ? (s.total_cost ?? 0) / s.turn_count : null)}
                footnote="amortized"
              />
            </div>
          </div>
        )}

        {/* ── TOOLS TAB ───────────────────────────────────────────────── */}
        {activeTab === 'tools' && (
          <div className="tab-panel">
            {/* Tool mix — bar rows */}
            <Eyebrow>Tool mix</Eyebrow>
            {toolMix.length === 0 ? (
              <div className="empty-block" style={{ marginBottom: 24 }}>No tool calls recorded for this session.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16, marginBottom: 40 }}>
                {toolMix.map((t: any) => (
                  <BarRow key={t.tool_name} label={t.tool_name} value={t.calls} max={maxToolCalls} fmt={fmt.n} />
                ))}
              </div>
            )}

            <Rule />

            {/* Tool executions log */}
            <div style={{ marginTop: 24 }}>
              <Eyebrow>Tool Executions — detailed timeline ({toolExecutions.length})</Eyebrow>
              {toolExecutions.length === 0 ? (
                <div className="empty-block">No tool execution records for this session.</div>
              ) : (
                <table className="ledger-table">
                  <thead>
                    <tr>
                      <th>Started</th>
                      <th>Ended</th>
                      <th>Tool</th>
                      <th>File acted on</th>
                      <th className="num">Duration</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {toolExecutions.map((te: any, i: number) => {
                      const fileName = te.file_path ? te.file_path.split(/[/\\]/).pop() : '—'
                      return (
                        <tr key={i}>
                          <td className="mono muted">{fmt.time(te.tool_call_ts)}</td>
                          <td className="mono muted">{fmt.time(te.tool_result_ts)}</td>
                          <td><span className="mono" style={{ color: 'var(--accent)' }}>{te.tool_name}</span></td>
                          <td className="mono muted" title={te.file_path}>{te.file_path ? fileName : '—'}</td>
                          <td className="num mono">{te.execution_duration_seconds != null ? `${te.execution_duration_seconds.toFixed(2)}s` : '—'}</td>
                          <td>
                            {te.is_error
                              ? <span style={{ color: 'var(--warn)', fontWeight: 600 }}>✗ Fail</span>
                              : <span style={{ color: 'var(--accent)', opacity: 0.85 }}>✓ OK</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* ── GIT TAB ─────────────────────────────────────────────────── */}
        {activeTab === 'git' && (
          <div className="tab-panel">
            <Eyebrow>Git commands ({gitCommands.length})</Eyebrow>
            {gitCommands.length === 0 ? (
              <div className="empty-block">No git commands executed during this session.</div>
            ) : (
              <table className="ledger-table">
                <thead>
                  <tr><th>Time</th><th>Op</th><th>Command</th><th>Output</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {gitCommands.map((g: any, i: number) => (
                    <tr key={i}>
                      <td className="mono muted">{fmt.time(g.ts)}</td>
                      <td className="mono">{g.git_op}</td>
                      <td className="mono">{g.raw_command?.slice(0, 60)}</td>
                      <td className="muted">{g.output_text?.slice(0, 80)}</td>
                      <td>{g.is_error ? <span className="warn">✗</span> : <span style={{ color: 'var(--accent)' }}>✓</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
