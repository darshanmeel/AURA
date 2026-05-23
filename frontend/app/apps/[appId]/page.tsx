export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { Eyebrow, Rule, StatBlock, AgentLink } from '../../../components/atoms'
import { SessionMiniTable } from '../../../components/tables'
import { ProfileBackRail } from '../../../components/panels'
import { fmt } from '../../../lib/fmt'

async function getAppData(appId: string) {
  const base = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000'
  const res = await fetch(`${base}/api/apps/${encodeURIComponent(appId)}`, { next: { revalidate: 30 } })
  if (!res.ok) return null
  return res.json()
}

export default async function AppProfilePage({ params }: { params: { appId: string } }) {
  const data = await getAppData(decodeURIComponent(params.appId))
  if (!data?.app) notFound()
  const { app, sessions } = data

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
