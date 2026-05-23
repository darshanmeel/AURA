import { Eyebrow, Rule, Avatar } from '../../components/atoms'
import { fmt } from '../../lib/fmt'

async function getPeople() {
  const base = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000'
  const res = await fetch(`${base}/api/people`, { next: { revalidate: 30 } })
  if (!res.ok) return []
  const data = await res.json()
  return data.people ?? []
}

export default async function PeoplePage() {
  const people = await getPeople()
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
