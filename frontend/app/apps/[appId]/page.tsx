export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { Eyebrow, Rule, StatBlock, AgentLink, ModelPill } from '../../../components/atoms'
import { ProfileBackRail } from '../../../components/panels'
import { fmt } from '../../../lib/fmt'
import { getApp, getAppSessions } from '../../../lib/queries/apps'
import { getAppPrompts } from '../../../lib/queries/prompts'
import { query } from '../../../lib/db'

function trunc200(s: string | null | undefined): string {
  if (!s) return ''
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}

async function getAppAgents(appId: string) {
  try {
    return await query(`
      SELECT agent, session_count, total_turns, total_cost, total_tool_calls
      FROM dim_agents WHERE app_id = ?
      ORDER BY total_cost DESC
    `, [appId]) as any[]
  } catch { return [] }
}

export default async function AppProfilePage({ params }: { params: { appId: string } }) {
  const appId = decodeURIComponent(params.appId)

  let app: any = null
  let sessions: any[] = []
  let agents: any[] = []
  let prompts: any[] = []

  try {
    const [a, s, ag, pr] = await Promise.all([
      getApp(appId),
      getAppSessions(appId),
      getAppAgents(appId),
      getAppPrompts(appId, 6),
    ])
    app = a
    sessions = s as any[]
    agents = ag
    prompts = pr as any[]
  } catch {}

  if (!app) notFound()

  const maxAgentCost = agents.length > 0 ? agents[0].total_cost ?? 0 : 1

  return (
    <div className="page-layout">
      <ProfileBackRail href="/apps" label="Back to apps" />

      {/* Profile head */}
      <section className="profile-head">
        <div className="profile-head-left">
          <span className="app-glyph">
            {(app.app_name ?? app.app_id)?.[0]?.toUpperCase() ?? '?'}
          </span>
          <div>
            <Eyebrow dot={false}>
              app · {app.project_id ?? app.app_id} · owner —
            </Eyebrow>
            <h1 className="display display-sm" style={{ margin: '8px 0 12px' }}>
              {app.app_name ?? app.app_id}
            </h1>
            {app.description && (
              <p className="hero-lede" style={{ maxWidth: '52ch', marginBottom: 0 }}>
                {app.description}
              </p>
            )}
          </div>
        </div>
        <div className="profile-head-right">
          <div className="hero-stat hero-stat-detail">
            <div className="hero-stat-eyebrow">14-DAY SPEND</div>
            <div className="hero-stat-value">{fmt.usd(app.total_cost)}</div>
            <div className="hero-stat-foot">
              <em>across</em> {fmt.k(app.total_output_tokens ?? 0)} tokens · {fmt.n(app.total_turns)} turns
            </div>
          </div>
        </div>
      </section>

      <Rule weight="thick" />

      {/* 6-stat strip */}
      <section className="strip">
        <StatBlock label="Sessions" value={fmt.n(app.session_count)} footnote="14 days" />
        <StatBlock label="People" value="—" footnote="contributors" />
        <StatBlock label="Agents" value={fmt.n(app.agent_count)} footnote="in rotation" accent />
        <StatBlock label="Commits" value={app.commits != null ? fmt.n(app.commits) : '—'} footnote="aggregate" />
        <StatBlock label="Tokens" value={fmt.k(app.total_output_tokens ?? 0)} footnote="aggregate" />
        <StatBlock label="Errors" value={app.errors != null ? fmt.n(app.errors) : '—'} footnote="across sessions" />
      </section>

      <Rule weight="thick" />

      {/* Two-col layout: main + side */}
      <section className="cols">
        {/* ── Main column ── */}
        <div className="col-main">

          {/* Agents in this app */}
          <div className="section-head">
            <h2 className="h-section">Agents — in this app</h2>
            <span className="section-meta">cost split by agent</span>
          </div>
          {agents.length > 0 ? (
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
                {agents.map((ag: any) => (
                  <tr key={ag.agent}>
                    <td><AgentLink name={ag.agent} /></td>
                    <td className="num">{fmt.n(ag.session_count)}</td>
                    <td className="num">{fmt.n(ag.total_turns)}</td>
                    <td className="num strong">{fmt.usd(ag.total_cost)}</td>
                    <td>
                      <div className="tbar">
                        <div
                          className="tbar-fill"
                          style={{ width: `${maxAgentCost > 0 ? ((ag.total_cost ?? 0) / maxAgentCost) * 100 : 0}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-block">No agent data yet — dim_agents will populate after dbt runs.</div>
          )}

          <Rule />

          {/* Sessions — recent */}
          <div className="section-head" style={{ marginTop: 28 }}>
            <h2 className="h-section">Sessions — recent</h2>
            <span className="section-meta">{sessions.length} sessions in {app.app_name ?? app.app_id}</span>
          </div>
          {sessions.length > 0 ? (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Agent</th>
                  <th>Title</th>
                  <th>Model</th>
                  <th className="num">Turns</th>
                  <th className="num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s: any) => (
                  <tr key={s.session_id} className="clickable">
                    <td className="mono muted">
                      <div>{fmt.date(s.start_ts)}</div>
                      <div className="tiny">{fmt.time(s.start_ts)}</div>
                    </td>
                    <td>{s.agent ? <AgentLink name={s.agent} /> : '—'}</td>
                    <td>
                      <a href={`/sessions/${s.session_id}`} className="sess-title-sm">
                        {trunc200(s.session_title) || s.session_id?.slice(0, 12)}
                      </a>
                    </td>
                    <td>{s.model ? <ModelPill model={s.model} /> : '—'}</td>
                    <td className="num">{fmt.n(s.turn_count)}</td>
                    <td className="num strong">{fmt.usd(s.total_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-block">No sessions recorded for this app yet.</div>
          )}
        </div>

        {/* ── Side panel ── */}
        <aside className="col-side">
          <div className="panel panel-prompts">
            <Eyebrow>Prompts · in their voice</Eyebrow>
            <h3 className="h-panel">
              Recent prompts in <em>{app.app_name ?? app.app_id}</em>
            </h3>
            {prompts.length > 0 ? (
              <ol className="prompts">
                {prompts.map((p: any, i: number) => (
                  <li key={i} className="prompt">
                    <div className="prompt-meta">
                      <span className="mono tiny muted">
                        {fmt.date(p.prompt_ts)} · {fmt.time(p.prompt_ts)}
                      </span>
                      {p.agent && <AgentLink name={p.agent} />}
                    </div>
                    <p className="prompt-text">
                      &ldquo;{trunc200(p.prompt_text_200)}&rdquo;
                    </p>
                    <div className="prompt-mini-stats">
                      {p.turn_count != null && <span>{p.turn_count} turns</span>}
                      {p.tool_call_count != null && <span>{p.tool_call_count} tools</span>}
                      {p.files_edited != null && <span>{p.files_edited} files</span>}
                      {p.cost_total != null && <span>{fmt.usd(p.cost_total)}</span>}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted" style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 14 }}>
                No prompts recorded yet — fact_prompts will populate after dbt runs.
              </p>
            )}
          </div>
        </aside>
      </section>
    </div>
  )
}
