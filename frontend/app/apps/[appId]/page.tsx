export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { Eyebrow, Rule, StatBlock, AgentLink } from '../../../components/atoms'
import { SessionMiniTable } from '../../../components/tables'
import { ProfileBackRail } from '../../../components/panels'
import { fmt } from '../../../lib/fmt'
import { getApp, getAppSessions } from '../../../lib/queries/apps'

export default async function AppProfilePage({ params }: { params: { appId: string } }) {
  const appId = decodeURIComponent(params.appId)
  let app: any = null, sessions: any[] = []
  try {
    const [a, s] = await Promise.all([getApp(appId), getAppSessions(appId)])
    app = a; sessions = s as any[]
  } catch {}
  if (!app) notFound()

  return (
    <div className="page-layout">
      <ProfileBackRail href="/apps" label="Apps" />
      <div className="page-header">
        <div className="profile-glyph mono">{app.app_name?.[0]?.toUpperCase()}</div>
        <div>
          <h2 className="serif">{app.app_name}</h2>
          <div className="muted mono">{app.app_id}</div>
        </div>
      </div>
      <Rule />
      <div className="kpi-strip">
        <StatBlock label="Total spend" value={fmt.usd(app.total_cost)} />
        <StatBlock label="Sessions" value={fmt.n(app.session_count)} />
        <StatBlock label="Turns" value={fmt.n(app.total_turns)} />
        <StatBlock label="Agents" value={fmt.n(app.agent_count)} />
        <StatBlock label="First seen" value={fmt.date(app.first_seen)} />
        <StatBlock label="Last active" value={fmt.date(app.last_seen)} />
      </div>
      <Rule />
      <section>
        <Eyebrow>Agents in rotation</Eyebrow>
        <div className="agent-chips">
          {(app.agents ?? []).map((a: string) => <AgentLink key={a} name={a} />)}
        </div>
      </section>
      <Rule />
      <section>
        <Eyebrow>Recent sessions</Eyebrow>
        <SessionMiniTable sessions={sessions ?? []} />
      </section>
    </div>
  )
}
