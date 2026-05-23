import React from 'react'
import { fmt } from '../lib/fmt'
import { AgentLink, ModelPill, ProviderTag, SeverityTag } from './atoms'

interface Session {
  session_id: string; start_ts: string; person_name?: string; cwd?: string
  agent?: string; session_title?: string; model?: string; turn_count?: number
  commits?: number; total_cost?: number; status?: string; provider?: string
}

export function LedgerTable({ sessions }: { sessions: Session[] }) {
  return (
    <table className="ledger-table">
      <thead>
        <tr>
          <th>Started</th><th>Person</th><th>App</th><th>Agent</th>
          <th>Title</th><th>Model</th><th>Turns</th><th>Commits</th><th>Cost</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map(s => (
          <tr key={s.session_id}>
            <td className="mono muted">{fmt.time(s.start_ts)}</td>
            <td>{s.person_name ?? '—'}</td>
            <td className="mono muted" title={s.cwd}>{s.cwd?.split('/').pop() ?? s.cwd ?? '—'}</td>
            <td>{s.agent ? <AgentLink name={s.agent} /> : '—'}</td>
            <td><a href={`/sessions/${s.session_id}`}>{s.session_title ?? s.session_id.slice(0, 12)}</a></td>
            <td>{s.model ? <ModelPill model={s.model} /> : '—'}</td>
            <td className="num">{fmt.n(s.turn_count)}</td>
            <td className="num">{fmt.n(s.commits ?? 0)}</td>
            <td className="num accent">{fmt.usd(s.total_cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface SessionMiniRow {
  session_id: string; start_ts: string; session_title?: string
  status?: string; turn_count?: number; total_cost?: number
}

export function SessionMiniTable({ sessions }: { sessions: SessionMiniRow[] }) {
  return (
    <table className="ledger-table ledger-table--mini">
      <thead>
        <tr><th>Started</th><th>Title</th><th>Turns</th><th>Cost</th></tr>
      </thead>
      <tbody>
        {sessions.map(s => (
          <tr key={s.session_id}>
            <td className="mono muted">{fmt.date(s.start_ts)}</td>
            <td><a href={`/sessions/${s.session_id}`}>{s.session_title ?? s.session_id.slice(0, 12)}</a></td>
            <td className="num">{fmt.n(s.turn_count)}</td>
            <td className="num accent">{fmt.usd(s.total_cost)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
