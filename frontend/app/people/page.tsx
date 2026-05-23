export const dynamic = 'force-dynamic'

import { Eyebrow, Rule, Avatar } from '../../components/atoms'
import { fmt } from '../../lib/fmt'
import { getPeople } from '../../lib/queries/people'

export default async function PeoplePage() {
  let people: any[] = []
  try { people = await getPeople() as any[] } catch {}
  return (
    <div className="page-layout">
      <div className="page-header">
        <Eyebrow>People</Eyebrow>
        <h2 className="serif">All contributors</h2>
        <p className="muted">{people.length} {people.length === 1 ? 'person' : 'people'} tracked</p>
      </div>
      <Rule />
      <div className="card-grid">
        {people.map((p: any) => (
          <a key={p.person_id} href={`/people/${encodeURIComponent(p.person_id)}`} className="card card--link">
            <Avatar name={p.person_name ?? p.person_id} />
            <div className="card-body">
              <div className="card-title">{p.person_name ?? p.person_id}</div>
              <div className="card-sub muted mono">{p.person_id}</div>
              <div className="card-stats">
                <span className="accent">{fmt.usd(p.total_cost)}</span>
                <span className="muted">{fmt.n(p.session_count)} sessions</span>
                <span className="muted">{fmt.n(p.total_commits ?? 0)} commits</span>
              </div>
              <div className="muted">{fmt.n(p.app_count)} apps</div>
            </div>
          </a>
        ))}
      </div>
    </div>
  )
}
