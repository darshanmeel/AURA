export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import {
  Eyebrow, Rule, StatBlock, Avatar,
  AgentLink, AppLink, PersonLink, TBar,
} from '../../../components/atoms'
import { ProfileBackRail } from '../../../components/panels'
import { RangeFilter } from '../../../components/RangeFilter'
import { fmt } from '../../../lib/fmt'
import { parseRange, rangeSince, rangeLabel } from '../../../lib/range'
import {
  getPerson, getPersonSessions, getPersonAgents, getPersonApps, getPersonPrompts,
  getPersonRangeAggregates,
} from '../../../lib/queries/people'

function trunc200(s: string | null | undefined): string {
  if (!s) return ''
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}

export default async function PersonProfilePage({
  params, searchParams,
}: { params: { personId: string }; searchParams?: { range?: string } }) {
  const personId = decodeURIComponent(params.personId)
  const range = parseRange(searchParams?.range)
  const since = rangeSince(range)

  let person: any = null
  let sessions: any[] = []
  let agentList: any[] = []
  let appList: any[] = []
  let prompts: any[] = []
  let rangeAgg: any = null

  try {
    const [p, s, ag, ap, ra] = await Promise.all([
      getPerson(personId),
      getPersonSessions(personId, since),
      getPersonAgents(personId, since),
      getPersonApps(personId, since),
      getPersonRangeAggregates(personId, since),
    ])
    person = p
    sessions = s as any[]
    agentList = ag as any[]
    appList = ap as any[]
    rangeAgg = ra
  } catch {}

  // Prompts — guard: fact_prompts may not exist yet
  try {
    prompts = (await getPersonPrompts(personId, 8, since)) as any[]
  } catch {}

  if (!person) notFound()

  // Range-aware KPIs (fall back to lifetime when since is null).
  const totalCost = Number((rangeAgg?.total_cost ?? person.total_cost) ?? 0)
  const totalTurns = Number((rangeAgg?.total_turns ?? person.total_turns) ?? 0)
  const totalTokens = Number((rangeAgg?.total_output_tokens ?? person.total_output_tokens) ?? 0)
  const totalCommits = Number((rangeAgg?.total_commits ?? person.total_commits) ?? 0)
  const sessionCount = Number((rangeAgg?.session_count ?? person.session_count) ?? 0)
  const appCount = appList.length
  const agentCount = agentList.length

  const maxAgentCost = agentList.length > 0 ? Math.max(Number(agentList[0].total_cost ?? 0), 0.0001) : 1
  const maxAppCost = appList.length > 0 ? Math.max(Number(appList[0].total_cost ?? 0), 0.0001) : 1

  const firstName = (person.person_name ?? personId).split(' ')[0]

  return (
    <div className="page-layout">
      <ProfileBackRail href="/people" label="Back to people" />

      {/* Masthead strap with RangeFilter */}
      <section className="masthead-strap">
        <Eyebrow dot={false}>
          Person · {person.person_name ?? person.person_id} · {rangeLabel(range)}
        </Eyebrow>
        <div className="strap-right">
          <RangeFilter current={range} />
          <span className="strap-pill is-muted">
            {fmt.n(sessionCount)} session{sessionCount !== 1 ? 's' : ''} · {fmt.usd(totalCost)}
          </span>
        </div>
      </section>

      {/* Profile head */}
      <section className="profile-head">
        <div className="profile-head-left">
          <Avatar name={person.person_name ?? person.person_id} />
          <div>
            <Eyebrow>{person.role ?? 'operator'}</Eyebrow>
            <h1 className="display display-sm" style={{ margin: '8px 0 12px' }}>
              {person.person_name ?? person.person_id}
            </h1>
            <div className="profile-meta">
              <span><b>{sessionCount}</b> sessions</span>
              <span className="meta-dot">·</span>
              <span><b>{appCount}</b> apps</span>
              <span className="meta-dot">·</span>
              <span><b>{agentCount}</b> agents</span>
              <span className="meta-dot">·</span>
              <span><b>{totalCommits}</b> commits</span>
            </div>
          </div>
        </div>
        <div className="profile-head-right">
          <div className="hero-stat hero-stat-detail">
            <div className="hero-stat-eyebrow">{rangeLabel(range).toUpperCase()} SPEND</div>
            <div className="hero-stat-value">{fmt.usd(totalCost)}</div>
            <div className="hero-stat-foot">
              <em>across</em> {fmt.k(totalTokens)} tokens · {fmt.n(totalTurns)} turns
            </div>
          </div>
        </div>
      </section>

      <Rule weight="thick" />

      {/* 6-stat strip */}
      <section className="strip">
        <StatBlock label="Sessions" value={sessionCount} footnote={rangeLabel(range)} />
        <StatBlock label="Apps" value={appCount} footnote="worked in" />
        <StatBlock label="Agents" value={agentCount} footnote="delegated to" />
        <StatBlock label="Commits" value={totalCommits} footnote={rangeLabel(range)} accent />
        <StatBlock label="Tokens" value={fmt.k(totalTokens)} footnote={rangeLabel(range)} />
        <StatBlock label="Errors" value="—" footnote="across sessions" />
      </section>

      <Rule weight="thick" />

      {/* Two-col layout */}
      <section className="cols">
        {/* Main column */}
        <div className="col-main">

          {/* Agents delegated to */}
          <div className="section-head">
            <h2 className="h-section">Agents — delegated to</h2>
            <span className="section-meta">cost split by who got the work</span>
          </div>
          {agentList.length > 0 ? (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="num">Sessions</th>
                  <th className="num">Turns</th>
                  <th className="num">Cost</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {agentList.map((a: any) => (
                  <tr key={a.agent}>
                    <td><AgentLink name={a.agent} /></td>
                    <td className="num">{fmt.n(a.session_count)}</td>
                    <td className="num">{fmt.n(a.total_turns)}</td>
                    <td className="num strong">{fmt.usd(a.total_cost)}</td>
                    <td>
                      <div className="tbar">
                        <div
                          className="tbar-fill"
                          style={{ width: `${(Number(a.total_cost ?? 0) / maxAgentCost) * 100}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-block">No agent data yet.</div>
          )}

          <Rule />

          {/* Apps worked in */}
          <div className="section-head" style={{ marginTop: 28 }}>
            <h2 className="h-section">Apps — worked in</h2>
            <span className="section-meta">cost by project</span>
          </div>
          {appList.length > 0 ? (
            <table className="ledger">
              <thead>
                <tr>
                  <th>App</th>
                  <th className="num">Sessions</th>
                  <th className="num">Turns</th>
                  <th className="num">Cost</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {appList.map((a: any) => (
                  <tr key={a.app_id ?? a.app_name}>
                    <td>
                      {a.app_id
                        ? <AppLink appId={a.app_id} appName={a.app_name ?? a.app_id} />
                        : <span className="muted mono" style={{ fontSize: 12 }}>{a.app_name ?? '—'}</span>
                      }
                    </td>
                    <td className="num">{fmt.n(a.session_count)}</td>
                    <td className="num">{fmt.n(a.total_turns)}</td>
                    <td className="num strong">{fmt.usd(a.total_cost)}</td>
                    <td>
                      <div className="tbar">
                        <div
                          className="tbar-fill"
                          style={{ width: `${(Number(a.total_cost ?? 0) / maxAppCost) * 100}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-block">No app data yet.</div>
          )}

          <Rule />

          {/* Recent sessions */}
          <div className="section-head" style={{ marginTop: 28 }}>
            <h2 className="h-section">Sessions — recent</h2>
            <span className="section-meta">{sessions.length} sessions</span>
          </div>
          {sessions.length > 0 ? (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Agent</th>
                  <th>Title</th>
                  <th className="num">Turns</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s: any) => (
                  <tr key={s.session_id}>
                    <td className="mono muted">
                      <div>{fmt.date(s.start_ts)}</div>
                      <div className="tiny">{fmt.time(s.start_ts)}</div>
                    </td>
                    <td>{s.agent ? <AgentLink name={s.agent} /> : '—'}</td>
                    <td>
                      <a href={`/sessions/${s.session_id}`} className="sess-title-sm">
                        {s.session_title ?? s.session_id?.slice(0, 12)}
                      </a>
                    </td>
                    <td className="num">{fmt.n(s.turn_count)}</td>
                    <td className="num strong">{fmt.usd(s.total_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-block">No sessions recorded yet.</div>
          )}
        </div>

        {/* Side: prompts panel */}
        <aside className="col-side">
          {prompts.length > 0 ? (
            <div className="panel panel-prompts">
              <Eyebrow>Prompts · in their voice</Eyebrow>
              <h3 className="h-panel">What {firstName} actually types</h3>
              <ol className="prompts">
                {prompts.map((p: any, i: number) => (
                  <li key={i} className="prompt">
                    <div className="prompt-meta">
                      <span className="mono tiny muted">
                        {fmt.date(p.prompt_ts)} · {fmt.time(p.prompt_ts)}
                      </span>
                      {p.agent && <AgentLink name={p.agent} />}
                    </div>
                    <p className="prompt-text">&ldquo;{trunc200(p.prompt_text_200)}&rdquo;</p>
                    <div className="prompt-mini-stats">
                      {p.turn_count != null && <span>{p.turn_count} turns</span>}
                      {p.tool_call_count != null && <span>{p.tool_call_count} tools</span>}
                      {p.files_edited != null && <span>{p.files_edited} files</span>}
                      {p.cost_total != null && <span>{fmt.usd(p.cost_total)}</span>}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <aside className="col-side" />
          )}
        </aside>
      </section>
    </div>
  )
}
