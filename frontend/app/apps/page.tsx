export const dynamic = 'force-dynamic'

import { Eyebrow, Rule, StatBlock } from '../../components/atoms'
import { RangeFilter } from '../../components/RangeFilter'
import { fmt } from '../../lib/fmt'
import { parseRange, rangeSince, rangeLabel } from '../../lib/range'
import { getApps, getAppsTotalCost } from '../../lib/queries/apps'

function trunc200(s: string | null | undefined): string {
  if (!s) return ''
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}

export default async function AppsPage({
  searchParams,
}: { searchParams?: { range?: string } }) {
  const range = parseRange(searchParams?.range)
  const since = rangeSince(range)

  let apps: any[] = [], totalCostRow: any = null
  try {
    [apps, totalCostRow] = await Promise.all([getApps(since), getAppsTotalCost(since)])
  } catch {}

  const totalCost: number = totalCostRow?.total_cost ?? apps.reduce((a: number, x: any) => a + (x.total_cost ?? 0), 0)

  return (
    <div className="page-layout">
      {/* Masthead strap */}
      <section className="masthead-strap">
        <Eyebrow>Apps · {apps.length} projects · {rangeLabel(range)}</Eyebrow>
        <div className="strap-right">
          <RangeFilter current={range} />
          <span className="strap-pill is-muted">{fmt.usd(totalCost)} aggregate</span>
        </div>
      </section>

      {/* Page hero */}
      <section className="page-head">
        <Eyebrow>The slate</Eyebrow>
        <h1 className="display display-sm">
          {apps.length} app{apps.length !== 1 ? 's' : ''}, <em>one ledger.</em>
        </h1>
        <p className="hero-lede">
          Each project, the agents working in it, the people driving them, and what it costs.
        </p>
      </section>

      <Rule weight="thick" />

      {/* Apps grid */}
      <section className="apps-grid">
        {apps.map((app: any) => {
          const agents: string[] = Array.isArray(app.agents) ? app.agents.filter(Boolean) : []
          const shownAgents = agents.slice(0, 5)
          const overflow = agents.length > 5 ? agents.length - 5 : 0

          return (
            <a
              key={app.app_id}
              href={`/apps/${encodeURIComponent(app.app_id)}`}
              className="app-card"
              style={{ textDecoration: 'none', display: 'block' }}
            >
              {/* Card head: eyebrow + name + cost */}
              <div className="app-card-head">
                <div>
                  <Eyebrow dot={false}>
                    {app.project_id ?? app.app_id} · {fmt.n(app.agent_count ?? agents.length)} agents
                  </Eyebrow>
                  <h3 className="h-panel" style={{ margin: '6px 0 4px' }}>
                    {app.app_name ?? app.app_id}
                  </h3>
                  {app.description && (
                    <p className="app-desc">{trunc200(app.description)}</p>
                  )}
                </div>
                <div className="app-card-cost">
                  <div className="muted tiny">{rangeLabel(range)} spend</div>
                  <div className="app-card-cost-v">{fmt.usd(app.total_cost)}</div>
                </div>
              </div>

              {/* Stats row: SESSIONS / TURNS / COMMITS / ERRORS */}
              <div className="app-card-stats">
                <div>
                  <span>Sessions</span>
                  <b>{fmt.n(app.session_count ?? 0)}</b>
                </div>
                <div>
                  <span>Turns</span>
                  <b>{fmt.n(app.total_turns ?? 0)}</b>
                </div>
                <div>
                  <span>Commits</span>
                  <b>{app.commits != null ? fmt.n(app.commits) : '—'}</b>
                </div>
                <div>
                  <span>Errors</span>
                  <b>{app.errors != null ? fmt.n(app.errors) : '—'}</b>
                </div>
              </div>

              {/* Agents chip row */}
              <div className="app-card-meta">
                <div className="meta-block">
                  <div className="meta-label">Agents</div>
                  <div className="meta-chips">
                    {shownAgents.map((ag: string) => (
                      <span key={ag} className="chip-mini">{ag}</span>
                    ))}
                    {overflow > 0 && (
                      <span className="chip-mini muted">+{overflow}</span>
                    )}
                    {agents.length === 0 && (
                      <span className="chip-mini muted">—</span>
                    )}
                  </div>
                </div>
              </div>
            </a>
          )
        })}
      </section>

      {apps.length === 0 && (
        <div className="empty-block">No apps found. Sessions will appear once dbt has run.</div>
      )}
    </div>
  )
}
