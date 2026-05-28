export const dynamic = 'force-dynamic'

import { Eyebrow, Rule, Avatar, TBar } from '../../components/atoms'
import { RangeFilter } from '../../components/RangeFilter'
import { fmt } from '../../lib/fmt'
import { parseRange, rangeSince, rangeLabel } from '../../lib/range'
import { getPeople } from '../../lib/queries/people'

export default async function PeoplePage({
  searchParams,
}: { searchParams?: { range?: string } }) {
  const range = parseRange(searchParams?.range)
  const since = rangeSince(range)

  let people: any[] = []
  let totalCost = 0
  let totalSessions = 0

  try {
    people = (await getPeople(since)) as any[]
    totalCost = people.reduce((a: number, p: any) => a + Number(p.total_cost ?? 0), 0)
    totalSessions = people.reduce((a: number, p: any) => a + Number(p.session_count ?? 0), 0)
  } catch {}

  const topCost = people.length > 0 ? Number(people[0].total_cost ?? 0) : 1

  return (
    <div className="page-layout">
      {/* Masthead strap */}
      <section className="masthead-strap">
        <Eyebrow dot={false}>
          People · {people.length} operator{people.length !== 1 ? 's' : ''} · {rangeLabel(range)}
        </Eyebrow>
        <div className="strap-right">
          <RangeFilter current={range} />
          <span className="strap-pill is-muted">
            {totalSessions} session{totalSessions !== 1 ? 's' : ''} · {fmt.usd(totalCost)} aggregate
          </span>
        </div>
      </section>

      {/* Hero / page-head */}
      <section className="page-head">
        <Eyebrow>The roster</Eyebrow>
        <h1 className="display display-sm">
          Who&rsquo;s <em>driving</em> the agents.
        </h1>
        <p className="hero-lede">
          {people.length} operator{people.length !== 1 ? 's' : ''},{' '}
          {Array.from(new Set(people.flatMap((p: any) => p.apps ?? []))).length} apps,{' '}
          {Array.from(new Set(people.flatMap((p: any) => p.agents ?? []))).length} agents.
          Click anyone to see what they delegate, what they spend, and what they actually type into the prompt.
        </p>
      </section>

      <Rule weight="thick" />

      {/* People grid */}
      <section className="people-grid">
        {people.map((p: any) => {
          const cost = Number(p.total_cost ?? 0)
          const apps: string[] = Array.isArray(p.apps) ? p.apps.filter(Boolean) : []
          const agents: string[] = Array.isArray(p.agents) ? p.agents.filter(Boolean) : []
          const pct = totalCost > 0 ? cost / totalCost : 0
          const barPct = topCost > 0 ? (cost / topCost) * 100 : 0

          return (
            <a
              key={p.person_id}
              href={`/people/${encodeURIComponent(p.person_id)}`}
              className="person-card"
              style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}
            >
              <div className="person-card-head">
                <Avatar name={p.person_name ?? p.person_id} />
                <div>
                  <div className="person-name-l">{p.person_name ?? p.person_id}</div>
                  {p.role && <div className="muted tiny">{p.role}</div>}
                </div>
              </div>

              <div className="person-card-stats">
                <div>
                  <span className="muted">Cost</span>
                  <b>{fmt.usd(cost)}</b>
                </div>
                <div>
                  <span className="muted">Sessions</span>
                  <b>{fmt.n(p.session_count)}</b>
                </div>
                <div>
                  <span className="muted">Turns</span>
                  <b>{fmt.n(p.total_turns)}</b>
                </div>
                <div>
                  <span className="muted">Commits</span>
                  <b>{fmt.n(p.total_commits ?? 0)}</b>
                </div>
              </div>

              <div className="person-card-meta">
                <div className="meta-block">
                  <div className="meta-label">Apps</div>
                  <div className="meta-chips">
                    {apps.length > 0
                      ? apps.map((a: string) => (
                          <span key={a} className="chip-mini">{a.split(/[/\\]/).pop() ?? a}</span>
                        ))
                      : <span className="muted tiny">—</span>
                    }
                  </div>
                </div>
                <div className="meta-block">
                  <div className="meta-label">Agents</div>
                  <div className="meta-chips">
                    {agents.slice(0, 4).map((a: string) => (
                      <span key={a} className="chip-mini">{a}</span>
                    ))}
                    {agents.length > 4 && (
                      <span className="chip-mini muted">+{agents.length - 4}</span>
                    )}
                    {agents.length === 0 && <span className="muted tiny">—</span>}
                  </div>
                </div>
              </div>

              <div className="person-card-bar">
                <div className="tbar" style={{ flex: 1 }}>
                  <div className="tbar-fill" style={{ width: `${barPct}%` }} />
                </div>
                <span className="tiny muted">{fmt.pct(pct)} of org spend</span>
              </div>
            </a>
          )
        })}
      </section>
    </div>
  )
}
