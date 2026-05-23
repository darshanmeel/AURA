'use client'

import React, { useState } from 'react'
import { Eyebrow, Rule, StatBlock, ModelPill, SeverityTag, BarRow } from './atoms'
import { TurnChart } from './charts'
import { fmt } from '../lib/fmt'

interface SessionTabsProps {
  s: any
  turns: any[]
  errors: any[]
  toolExecutions: any[]
  gitCommands: any[]
  files: any[]
  toolMix: any[]
}

export function SessionTabs({ s, turns, errors, toolExecutions, gitCommands, files, toolMix }: SessionTabsProps) {
  const [activeTab, setActiveTab] = useState<'details' | 'tools' | 'git' | 'tokens'>('details')

  const maxToolCalls = Math.max(...(toolMix ?? []).map((t: any) => t.calls ?? 0), 1)
  const maxEdits = Math.max(...(files ?? []).map((f: any) => f.edit_count ?? 0), 1)

  return (
    <div className="session-tabs-container">
      <div className="tab-nav">
        <button className={`tab-btn ${activeTab === 'details' ? 'active' : ''}`} onClick={() => setActiveTab('details')}>Details & Prompts</button>
        <button className={`tab-btn ${activeTab === 'tools' ? 'active' : ''}`} onClick={() => setActiveTab('tools')}>Tools</button>
        <button className={`tab-btn ${activeTab === 'git' ? 'active' : ''}`} onClick={() => setActiveTab('git')}>Git Commands</button>
        <button className={`tab-btn ${activeTab === 'tokens' ? 'active' : ''}`} onClick={() => setActiveTab('tokens')}>Tokens & Caching</button>
      </div>

      <div className="tab-content">
        {activeTab === 'details' && (
          <div className="tab-panel">
            <Eyebrow>Turns (first 60)</Eyebrow>
            <table className="ledger-table" style={{ tableLayout: 'fixed', width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th style={{ width: 80 }}>Time</th>
                  <th style={{ width: 100 }}>Model</th>
                  <th>User Prompt</th>
                  <th className="num" style={{ width: 80 }}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {(turns ?? []).map((t: any) => (
                  <tr key={t.turn_number}>
                    <td className="num muted">{t.turn_number}</td>
                    <td className="mono muted">{fmt.time(t.assistant_ts)}</td>
                    <td><ModelPill model={t.model} /></td>
                    <td style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '300px' }}>
                      <span title={t.assistant_response?.slice(0, 800) + '...'} style={{ cursor: 'help' }}>
                        {t.user_prompt ? t.user_prompt.slice(0, 150) + (t.user_prompt.length > 150 ? '...' : '') : <span className="muted">{'<No prompt>'}</span>}
                      </span>
                    </td>
                    <td className="num accent">{fmt.usd(t.calculated_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {errors?.length > 0 && (
              <>
                <div style={{ marginTop: 48 }} />
                <Eyebrow>Errors ({errors.length})</Eyebrow>
                <table className="ledger-table ledger-errors">
                  <thead><tr><th>Time</th><th>Severity</th><th>Kind</th><th>Tool</th><th>Message</th></tr></thead>
                  <tbody>
                    {errors.map((e: any, i: number) => (
                      <tr key={i}>
                        <td className="mono muted">{fmt.time(e.ts)}</td>
                        <td><SeverityTag severity={e.severity} /></td>
                        <td className="mono">{e.kind}</td>
                        <td className="mono muted">{e.tool ?? '—'}</td>
                        <td className="muted err-msg">{e.message?.slice(0, 80) ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}

        {activeTab === 'tools' && (
          <div className="tab-panel">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 48 }}>
              <div>
                <Eyebrow>Tool Executions — detailed timeline ({toolExecutions.length})</Eyebrow>
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
                      const fileName = te.file_path ? (te.file_path.split(/[/\\]/).pop()) : '—'
                      return (
                        <tr key={i}>
                          <td className="mono muted">{fmt.time(te.tool_call_ts)}</td>
                          <td className="mono muted">{fmt.time(te.tool_result_ts)}</td>
                          <td><span className="mono strong" style={{ color: 'var(--accent)' }}>{te.tool_name}</span></td>
                          <td className="mono muted" title={te.file_path}>{te.file_path ? fileName : '—'}</td>
                          <td className="num mono">{te.execution_duration_seconds != null ? `${te.execution_duration_seconds.toFixed(2)}s` : '—'}</td>
                          <td>
                            {te.is_error ? (
                              <span style={{ color: 'var(--warn)', fontWeight: '600' }}>✗ Fail</span>
                            ) : (
                              <span style={{ color: 'var(--accent)', opacity: 0.85 }}>✓ Success</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div>
                <Eyebrow>Tool mix</Eyebrow>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
                  {(toolMix ?? []).map((t: any) => (
                    <BarRow key={t.tool_name} label={t.tool_name} value={t.calls} max={maxToolCalls} fmt={fmt.n} />
                  ))}
                </div>

                <div style={{ marginTop: 48 }} />
                <Eyebrow>Files touched</Eyebrow>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
                  {(files ?? []).map((f: any) => (
                    <BarRow key={f.file_path} label={f.file_path?.split(/[/\\]/).pop()} value={f.edit_count} max={maxEdits} fmt={fmt.n} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'git' && (
          <div className="tab-panel">
            <Eyebrow>Git commands ({gitCommands.length})</Eyebrow>
            {gitCommands.length === 0 ? (
              <div className="empty-block">No git commands executed during this session.</div>
            ) : (
              <table className="ledger-table">
                <thead><tr><th>Time</th><th>Op</th><th>Command</th><th>Output</th><th>Status</th></tr></thead>
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

        {activeTab === 'tokens' && (
          <div className="tab-panel">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 48 }}>
              <div>
                <Eyebrow>Per-turn tokens ({Math.min(turns?.length ?? 0, 60)} sampled)</Eyebrow>
                <TurnChart data={turns ?? []} />
                
                <div style={{ marginTop: 48 }} />
                <table className="ledger-table">
                  <thead><tr><th>#</th><th>Input</th><th>Output</th><th>Cost</th><th>Ctx%</th></tr></thead>
                  <tbody>
                    {(turns ?? []).map((t: any) => (
                      <tr key={t.turn_number}>
                        <td className="num muted">{t.turn_number}</td>
                        <td className="num">{fmt.k(t.input_tokens)}</td>
                        <td className="num">{fmt.k(t.output_tokens)}</td>
                        <td className="num accent">{fmt.usd(t.calculated_cost)}</td>
                        <td className="num muted">{fmt.pct(t.context_pct)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <Eyebrow>Token breakdown</Eyebrow>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
                  <StatBlock label="Total Input" value={fmt.k(s.total_input_tokens)} large />
                  <StatBlock label="Total Output" value={fmt.k(s.total_output_tokens)} large />
                  <Rule />
                  <StatBlock label="Cache read" value={fmt.k(s.cache_read_total)} />
                  <StatBlock label="Cache 5m" value={fmt.k(s.ephemeral_5m_total)} />
                  <StatBlock label="Cache 1h" value={fmt.k(s.ephemeral_1h_total)} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
