export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { Eyebrow, Rule, StatBlock, ModelPill, BarRow } from '../../../components/atoms'
import { SessionMiniTable } from '../../../components/tables'
import { ProfileBackRail, SideRail, SideSection } from '../../../components/panels'
import { fmt } from '../../../lib/fmt'
import { getAgent, getAgentSessions, getAgentFiles } from '../../../lib/queries/agents'

export default async function AgentProfilePage({ params }: { params: { name: string } }) {
  const name = decodeURIComponent(params.name)
  let agent: any = null, sessions: any[] = [], files: any[] = []
  try {
    const [a, s, f] = await Promise.all([getAgent(name), getAgentSessions(name), getAgentFiles(name)])
    agent = a; sessions = s as any[]; files = f as any[]
  } catch {}
  if (!agent) notFound()
  const maxEdits = Math.max(...(files ?? []).map((f: any) => f.edits ?? 0), 1)

  return (
    <div className="page-layout">
      <ProfileBackRail href="/" label="Dashboard" />
      <div className="page-header">
        <span className="profile-glyph mono" aria-hidden>⌬</span>
        <div>
          <h2 className="serif mono">{agent.agent}</h2>
          <div className="muted">{fmt.usd(agent.total_cost)} · {fmt.date(agent.first_seen)} → {fmt.date(agent.last_seen)}</div>
        </div>
      </div>
      <Rule />
      <div className="kpi-strip">
        <StatBlock label="Total spend" value={fmt.usd(agent.total_cost)} />
        <StatBlock label="Sessions" value={fmt.n(agent.session_count)} />
        <StatBlock label="Turns" value={fmt.n(agent.total_turns)} />
        <StatBlock label="People" value={fmt.n(agent.people_count)} />
        <StatBlock label="Apps" value={fmt.n(agent.app_count)} />
      </div>
      <Rule />
      <div className="main-with-rail">
        <div className="main-col">
          <section>
            <Eyebrow>Models routed to</Eyebrow>
            <div className="model-chips">
              {(agent.models ?? []).map((m: string) => <ModelPill key={m} model={m} />)}
            </div>
          </section>
          <Rule />
          <section>
            <Eyebrow>Recent sessions</Eyebrow>
            <SessionMiniTable sessions={sessions ?? []} />
          </section>
        </div>
        <SideRail>
          <SideSection title="Top files">
            {(files ?? []).map((f: any) => (
              <BarRow key={f.file_path} label={f.file_path?.split(/[/\\]/).pop()} value={f.edits} max={maxEdits} fmt={fmt.n} />
            ))}
          </SideSection>
        </SideRail>
      </div>
    </div>
  )
}
