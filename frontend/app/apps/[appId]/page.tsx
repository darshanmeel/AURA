export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { Eyebrow, Rule, StatBlock, AgentLink, ModelPill } from '../../../components/atoms'
import { ProfileBackRail } from '../../../components/panels'
import { ClickableRow } from '../../../components/ClickableRow'
import { fmt } from '../../../lib/fmt'
import { getApp, getAppSessions, getProjectApps } from '../../../lib/queries/apps'
import { getAppPrompts, getAppAllPrompts } from '../../../lib/queries/prompts'
import { query } from '../../../lib/db'

function trunc200(s: string | null | undefined): string {
  if (!s) return ''
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}

function unwrapTitle(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = raw.trim()
  if (s.startsWith('[{') && s.includes('"type"')) {
    try {
      const blocks = JSON.parse(s)
      if (Array.isArray(blocks)) {
        const text = blocks.filter((b: any) => b.type === 'text' && b.text).map((b: any) => b.text as string).join(' ').trim()
        if (text) return trunc200(text)
      }
    } catch { /* fall through */ }
  }
  return trunc200(s)
}

async function getAppAgents(appId: string) {
  try {
    return await query(`
      SELECT agent, session_count, total_turns, total_cost, total_tool_calls
      FROM dim_agents WHERE app_id = ?
      ORDER BY total_cost DESC
    `, [appId]) as any[]
  } catch (e) { console.error('[app-profile] getAppAgents failed:', e); return [] }
}

export default async function AppProfilePage({ params }: { params: { appId: string } }) {
  const appId = decodeURIComponent(params.appId)

  let app: any = null
  let sessions: any[] = []
  let agents: any[] = []
  let prompts: any[] = []
  let allPrompts: any[] = []
  let siblingApps: any[] = []

  try {
    const [a, s, ag, pr, allPr] = await Promise.all([
      getApp(appId),
      getAppSessions(appId),
      getAppAgents(appId),
      getAppPrompts(appId, 6),
      getAppAllPrompts(appId, 200),
    ])
    app = a
    sessions = s as any[]
    agents = ag
    prompts = pr as any[]
    allPrompts = allPr as any[]
    if (app?.project_id) {
      siblingApps = (await getProjectApps(app.project_id) as any[]).filter(x => x.app_id !== appId)
    }
  } catch (e) { console.error('[app-profile] data load failed:', e) }

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
              app · <span style={{ color: 'var(--accent)' }}>{app.project_name ?? app.project_id ?? app.app_id}</span> · project
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

          {/* Other apps in this project */}
          {(app.project_id && (siblingApps.length > 0)) && (
            <>
              <Rule />
              <div className="section-head" style={{ marginTop: 28 }}>
                <h2 className="h-section">Project — {app.project_name ?? app.project_id}</h2>
                <span className="section-meta">{siblingApps.length + 1} app{siblingApps.length + 1 !== 1 ? 's' : ''} in this project</span>
              </div>
              <table className="ledger">
                <thead>
                  <tr>
                    <th>App</th>
                    <th className="num">Sessions</th>
                    <th className="num">Turns</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Current app row */}
                  <tr style={{ background: 'rgba(217,183,135,0.06)' }}>
                    <td><span className="strong">{app.app_name ?? app.app_id}</span> <span className="muted tiny">← this app</span></td>
                    <td className="num">{fmt.n(app.session_count)}</td>
                    <td className="num">{fmt.n(app.total_turns)}</td>
                    <td className="num strong">{fmt.usd(app.total_cost)}</td>
                  </tr>
                  {siblingApps.map((a: any) => (
                    <ClickableRow key={a.app_id} href={`/apps/${encodeURIComponent(a.app_id)}`}>
                      <td>{a.app_name ?? a.app_id}</td>
                      <td className="num">{fmt.n(a.session_count)}</td>
                      <td className="num">{fmt.n(a.total_turns)}</td>
                      <td className="num">{fmt.usd(a.total_cost)}</td>
                    </ClickableRow>
                  ))}
                </tbody>
              </table>
            </>
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
                        {unwrapTitle(s.session_title) || s.session_id?.slice(0, 12)}
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

      {/* All prompts — full chronological feed for this app */}
      <Rule weight="thick" />
      <section style={{ marginTop: 32 }}>
        <div className="section-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
          <h2 className="h-section">All prompts — {app.app_name ?? app.app_id}</h2>
          <span className="section-meta muted">
            {allPrompts.length} prompt{allPrompts.length !== 1 ? 's' : ''} · newest first
          </span>
        </div>
        {allPrompts.length === 0 ? (
          <div className="empty-block">No prompts recorded for this app yet.</div>
        ) : (
          <ol className="prompts prompts-wide" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 0 }}>
            {allPrompts.map((p: any, i: number) => (
              <li key={p.session_id + '_' + (p.prompt_idx ?? i)} style={{ display: 'flex', gap: 24, padding: '20px 0', borderTop: '1px solid var(--rule)' }}>
                {/* Left aside */}
                <div style={{ flexShrink: 0, width: 140, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div className="mono muted" style={{ fontSize: 11 }}>
                    {fmt.date(p.prompt_ts)} · {fmt.time(p.prompt_ts)}
                  </div>
                  {p.agent && <AgentLink name={p.agent} />}
                  {p.model_primary && <ModelPill model={p.model_primary} />}
                  {p.is_overkill && (
                    <span style={{ display: 'inline-block', padding: '2px 6px', fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--warn)', border: '1px solid var(--warn)', borderRadius: 2, marginTop: 4 }}>
                      OVERKILL
                    </span>
                  )}
                  <a href={`/sessions/${p.session_id}`} className="tiny mono muted" style={{ marginTop: 4 }}>
                    → {p.session_id?.slice(0, 8)}
                  </a>
                </div>

                {/* Body */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  {p.prompt_text_200 && (
                    <p style={{ fontStyle: 'italic', color: 'var(--ink-2)', marginBottom: 10, lineHeight: 1.6 }}>
                      &ldquo;{trunc200(p.prompt_text_200)}&rdquo;
                    </p>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                    {p.turn_count != null && (
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        <b style={{ color: 'var(--ink)' }}>{p.turn_count}</b> turns
                      </span>
                    )}
                    {p.tool_call_count != null && (
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        · <b style={{ color: 'var(--ink)' }}>{p.tool_call_count}</b> tools
                      </span>
                    )}
                    {p.files_edited != null && (
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        · <b style={{ color: 'var(--ink)' }}>{p.files_edited}</b> files
                      </span>
                    )}
                    {p.output_tokens_total != null && (
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                        · <b style={{ color: 'var(--ink)' }}>{fmt.k(p.output_tokens_total)}</b> tokens
                      </span>
                    )}
                    {p.cost_total != null && (
                      <span style={{ fontSize: 12, color: 'var(--accent)' }}>
                        · {fmt.usd(p.cost_total)}
                      </span>
                    )}
                    {p.errors_caught > 0 && (
                      <span style={{ fontSize: 12, color: 'var(--warn)' }}>
                        · {p.errors_caught} error{p.errors_caught !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                  {p.summary_200 && (
                    <p className="muted" style={{ fontSize: 13, lineHeight: 1.55, margin: 0 }}>
                      {trunc200(p.summary_200)}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
