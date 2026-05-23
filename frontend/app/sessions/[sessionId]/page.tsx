export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { Eyebrow, Rule, StatBlock, ModelPill, ProviderTag, SeverityTag, BarRow, AgentLink } from '../../../components/atoms'
import { ProfileBackRail } from '../../../components/panels'
import { SessionTabs } from '../../../components/SessionTabs'
import { fmt } from '../../../lib/fmt'
import {
  getSession, getSessionTurns, getSessionErrors,
  getSessionFiles, getSessionToolMix, getSessionGitCommands,
  getSessionToolExecutions
} from '../../../lib/queries/sessions'

export default async function SessionDetailPage({ params }: { params: { sessionId: string } }) {
  const id = params.sessionId
  let s: any = null, turns: any[] = [], errors: any[] = [], files: any[] = [], toolMix: any[] = [], gitCommands: any[] = [], toolExecutions: any[] = []
  try {
    const [sess, t, e, f, tm, gc, te] = await Promise.all([
      getSession(id), getSessionTurns(id), getSessionErrors(id),
      getSessionFiles(id), getSessionToolMix(id), getSessionGitCommands(id),
      getSessionToolExecutions(id)
    ])
    s = sess; turns = t as any[]; errors = e as any[]
    files = f as any[]; toolMix = tm as any[]; gitCommands = gc as any[]
    toolExecutions = te as any[]
  } catch {}
  if (!s) notFound()
  const maxToolCalls = Math.max(...(toolMix ?? []).map((t: any) => t.calls ?? 0), 1)
  const maxEdits = Math.max(...(files ?? []).map((f: any) => f.edit_count ?? 0), 1)

  return (
    <div className="page-layout">
      <ProfileBackRail href="/sessions" label="Sessions" />

      {/* Header */}
      <div className="session-header">
        <div className="session-meta-chips">
          <ProviderTag provider={s.provider} />
          {s.person_name && <span className="muted">{s.person_name}</span>}
          {s.cwd && <span className="mono muted">{s.cwd?.split(/[/\\]/).pop()}</span>}
          {s.agent && <AgentLink name={s.agent} />}
        </div>
        <h2 className="serif">{s.session_title ?? s.session_id?.slice(0, 24)}</h2>
      </div>

      {/* Meta grid */}
      <div className="meta-grid">
        <div><span className="eyebrow">Session ID</span><span className="mono">{s.session_id}</span></div>
        <div><span className="eyebrow">CWD</span><span className="mono">{s.cwd}</span></div>
        <div><span className="eyebrow">Branch · Commits</span><span className="mono">{s.git_branch ?? '—'} · {s.commits ?? 0}</span></div>
        <div><span className="eyebrow">Model</span><ModelPill model={s.model} /></div>
        <div><span className="eyebrow">Started</span><span>{fmt.date(s.start_ts)} {fmt.time(s.start_ts)}</span></div>
        <div><span className="eyebrow">Duration · Status</span><span>{fmt.duration(s.start_ts, s.end_ts)} · {s.status}</span></div>
      </div>

      <Rule />

      {/* KPI strip */}
      <div className="kpi-strip">
        <StatBlock label="Turns" value={fmt.n(s.turn_count)} />
        <StatBlock label="Output tokens" value={fmt.k(s.total_output_tokens)} />
        <StatBlock label="Cache 1h" value={fmt.k(s.ephemeral_1h_total)} />
        <StatBlock label="Cache 5m" value={fmt.k(s.ephemeral_5m_total)} />
        <StatBlock label="Cache hit" value={fmt.pct(s.total_input_tokens > 0 ? s.cache_read_total / s.total_input_tokens : null)} />
        <StatBlock label="$/turn" value={fmt.usd(s.turn_count > 0 ? s.total_cost / s.turn_count : null)} />
      </div>

      <Rule />

      <SessionTabs 
        s={s}
        turns={turns}
        errors={errors}
        toolExecutions={toolExecutions}
        gitCommands={gitCommands}
        files={files}
        toolMix={toolMix}
      />
    </div>
  )
}
