export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { Eyebrow, Rule, StatBlock, Avatar, AgentLink, AppLink } from '../../../components/atoms'
import { SessionMiniTable } from '../../../components/tables'
import { ProfileBackRail } from '../../../components/panels'
import { fmt } from '../../../lib/fmt'

async function getPersonData(personId: string) {
  const base = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000'
  const res = await fetch(`${base}/api/people/${encodeURIComponent(personId)}`, { next: { revalidate: 30 } })
  if (!res.ok) return null
  return res.json()
}

export default async function PersonProfilePage({ params }: { params: { personId: string } }) {
  const data = await getPersonData(decodeURIComponent(params.personId))
  if (!data?.person) notFound()
  const { person, sessions } = data

  return (
    <div className="page-layout">
      <ProfileBackRail href="/people" label="People" />
      <div className="page-header">
        <Avatar name={person.person_name ?? person.person_id} />
        <div>
          <h2 className="serif">{person.person_name ?? person.person_id}</h2>
          <div className="muted mono">{person.person_id}</div>
        </div>
      </div>
      <Rule />
      <div className="kpi-strip">
        <StatBlock label="Total spend" value={fmt.usd(person.total_cost)} />
        <StatBlock label="Sessions" value={fmt.n(person.session_count)} />
        <StatBlock label="Turns" value={fmt.n(person.total_turns)} />
        <StatBlock label="Commits" value={fmt.n(person.total_commits ?? 0)} />
        <StatBlock label="Apps" value={fmt.n(person.app_count)} />
      </div>
      <Rule />
      <section>
        <Eyebrow>Agents used</Eyebrow>
        <div className="agent-chips">
          {(person.agents ?? []).map((a: string) => <AgentLink key={a} name={a} />)}
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
