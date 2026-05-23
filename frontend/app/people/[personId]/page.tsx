export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { Eyebrow, Rule, StatBlock, Avatar, AgentLink, AppLink } from '../../../components/atoms'
import { SessionMiniTable } from '../../../components/tables'
import { ProfileBackRail } from '../../../components/panels'
import { fmt } from '../../../lib/fmt'
import { getPerson, getPersonSessions } from '../../../lib/queries/people'

export default async function PersonProfilePage({ params }: { params: { personId: string } }) {
  const personId = decodeURIComponent(params.personId)
  let person: any = null, sessions: any[] = []
  try {
    const [p, s] = await Promise.all([getPerson(personId), getPersonSessions(personId)])
    person = p; sessions = s as any[]
  } catch {}
  if (!person) notFound()

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
