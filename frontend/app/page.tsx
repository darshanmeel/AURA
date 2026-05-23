export const dynamic = 'force-dynamic'

import React from 'react'
import { Eyebrow, Rule, StatBlock, BarRow, ProviderTag, ModelPill, AgentLink, PersonLink, SeverityTag, TBar, StackBar, StatusDot } from '../components/atoms'
import { DailyChart } from '../components/charts'
import { SideRail, SideSection } from '../components/panels'
import { fmt } from '../lib/fmt'
import {
  getDashboardKPIs, getDailySpend, getTopApps, getTopProjects, getTopAgents,
  getToolMix, getProviderSplit, getModelBreakdown,
  getRecentErrors, getTopFiles, getTopPeople
} from '../lib/queries/dashboard'

export default async function DashboardPage() {
  let kpis: any = {}, dailySpend: any[] = [], topApps: any[] = [], topProjects: any[] = [], topAgents: any[] = []
  let toolMix: any[] = [], providers: any[] = [], models: any[] = [], recentErrors: any[] = []
  let topFiles: any[] = [], topPeople: any[] = []
  try {
    const [kpisArr, ds, ta, tproj, tag, tm, prov, mod, re, tf, tp] = await Promise.all([
      getDashboardKPIs(), getDailySpend(), getTopApps(), getTopProjects(), getTopAgents(),
      getToolMix(), getProviderSplit(), getModelBreakdown(),
      getRecentErrors(), getTopFiles(), getTopPeople()
    ])
    kpis = kpisArr ?? {}
    dailySpend = ds as any[]; topApps = ta as any[]; topProjects = tproj as any[]; topAgents = tag as any[]
    toolMix = tm as any[]; providers = prov as any[]; models = mod as any[]
    recentErrors = re as any[]; topFiles = tf as any[]; topPeople = tp as any[]
  } catch { /* DB not ready yet — show empty state */ }

  const totalDays = dailySpend.length
  const maxCost = Math.max(...topApps.map((a: any) => a.total_cost ?? 0), 0.001)
  const maxToolCalls = Math.max(...toolMix.map((t: any) => t.call_count ?? 0), 1)

  const cache5m = kpis.cache_5m_total ?? 0
  const cache1h = kpis.cache_1h_total ?? 0
  const cacheR = kpis.cache_read_total ?? 0

  const anthropicCost = providers.find(p => p.provider.toLowerCase() === 'anthropic')?.cost ?? 0
  const googleCost = providers.find(p => p.provider.toLowerCase() === 'google')?.cost ?? 0
  const heroLede = `${providers.length} providers — Anthropic (${fmt.usd(anthropicCost)}) vs Google (${fmt.usd(googleCost)}) over ${totalDays} days.`

  return (
    <div className="page page-layout">
      {/* Masthead strap */}
      <section className="masthead-strap">
        <Eyebrow>{totalDays} days · {providers.length} providers · {fmt.n(kpis.total_people)} people · {fmt.n(kpis.total_apps)} apps</Eyebrow>
        <div className="strap-right">
          <span className="strap-pill"><StatusDot status={kpis.last_session ? 'active' : 'completed'} label={`pipeline live · ${fmt.time(kpis.last_session)}`} /></span>
          <span className="strap-pill is-muted">{fmt.n(kpis.total_sessions)} sessions · {topAgents.length} agents</span>
        </div>
      </section>

      {/* Hero */}
      <section className="hero">
        <div className="hero-left">
          <Eyebrow>The headline</Eyebrow>
          <h1 className="display">
            Spend, <em>with receipts.</em>
          </h1>
          <p className="hero-lede">{heroLede}</p>
          <div className="hero-actions">
            <a href="/sessions" className="btn btn-primary">
              Sessions <span className="arr">→</span>
            </a>
            <a href="/apps" className="btn btn-ghost">Apps →</a>
            <a href="/people" className="btn btn-ghost">People →</a>
          </div>
        </div>
        <div className="hero-right">
          <div className="hero-stat">
            <div className="hero-stat-eyebrow">{totalDays}-DAY SPEND</div>
            <div className="hero-stat-value">{fmt.usd(kpis.total_cost)}</div>
            <div className="hero-stat-foot">
              <em>against</em> {fmt.k(kpis.total_input_tokens + kpis.total_output_tokens)} tokens · {fmt.n(kpis.total_tool_calls)} tool calls · {fmt.n(kpis.total_commits ?? 0)} commits
            </div>
            <div className="hero-stat-spark">
              <DailyChart data={dailySpend} />
            </div>
          </div>
        </div>
      </section>

      <Rule weight="thick" />

      {/* KPI strip */}
      <section className="strip">
        <StatBlock label="Active now" value={fmt.n(kpis.active_sessions)} footnote="sessions in-flight" />
        <StatBlock label="Cache hit" value={fmt.pct(kpis.cache_hit_rate)} footnote="read / (read + write)" />
        <StatBlock label="Tool calls" value={fmt.k(kpis.total_tool_calls)} footnote={`last ${totalDays} days`} />
        <StatBlock label="Commits" value={fmt.n(kpis.total_commits ?? 0)} footnote={`across ${fmt.n(kpis.total_apps)} apps`} />
        <StatBlock label="Errors" value={fmt.n(recentErrors.length)} footnote="recorded recently" accent />
        <StatBlock label="Total spend" value={fmt.usd(kpis.total_cost)} footnote="overall total" />
      </section>

      <Rule weight="thick" />

      <section className="cols">
        <div className="col-main">
          {/* Projects ledger */}
          <div className="section-head">
            <h2 className="h-section">Projects — by cost</h2>
            <span className="section-meta">{topProjects.length} projects · click any row →</span>
          </div>
          <table className="ledger">
            <thead>
              <tr>
                <th>#</th>
                <th>Project</th>
                <th className="num">Apps</th>
                <th className="num">Sessions</th>
                <th className="num">Turns</th>
                <th className="num">Cost</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {topProjects.map((proj: any, i: number) => (
                <React.Fragment key={proj.project_id}>
                  <tr className="clickable" onClick={() => {}}>
                    <td className="muted">{String(i + 1).padStart(2, "0")}</td>
                    <td>
                      <div className="app-cell" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                        <span className="app-glyph-s" style={{ width: 24, height: 24, background: 'var(--rule)', borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{proj.project_name[0]?.toUpperCase() ?? '?'}</span>
                        <div>
                          <div className="strong">{proj.project_name}</div>
                          <div className="tiny muted">{proj.project_id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="num">{fmt.n(proj.app_count)}</td>
                    <td className="num">{fmt.n(proj.session_count)}</td>
                    <td className="num">{fmt.n(proj.total_turns)}</td>
                    <td className="num strong">{fmt.usd(proj.total_cost)}</td>
                    <td style={{ width: 100 }}><TBar pct={(proj.total_cost / Math.max(0.001, topProjects[0]?.total_cost ?? 1)) * 100} /></td>
                  </tr>
                  {proj.apps && proj.apps.map((app: any, idx: number) => (
                    <tr key={app.app_id} className="sub-row clickable" style={{ background: 'var(--surface-raised)' }}>
                      <td></td>
                      <td style={{ paddingLeft: '36px' }}>
                        <div className="app-cell" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                          <span style={{ color: 'var(--muted)', fontSize: 14 }}>↳</span>
                          <div>
                            <div className="strong"><a href={`/apps/${encodeURIComponent(app.app_id)}`} style={{ textDecoration: 'none', color: 'inherit' }}>{app.app_name}</a></div>
                            <div className="tiny muted">{app.app_id}</div>
                          </div>
                        </div>
                      </td>
                      <td></td>
                      <td className="num">{fmt.n(app.session_count)}</td>
                      <td className="num">{fmt.n(app.total_turns)}</td>
                      <td className="num">{fmt.usd(app.total_cost)}</td>
                      <td style={{ width: 100 }}><TBar pct={(app.total_cost / Math.max(0.001, topProjects[0]?.total_cost ?? 1)) * 100} /></td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>



          <Rule />

          {/* Agents */}
          <div className="section-head" style={{ marginTop: 32 }}>
            <h2 className="h-section">Agents — by cost</h2>
            <span className="section-meta">{topAgents.length} agents · click any name →</span>
          </div>
          <table className="ledger">
            <thead>
              <tr>
                <th>#</th>
                <th>Agent</th>
                <th className="num">Sessions</th>
                <th className="num">Turns</th>
                <th className="num">Cost</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {topAgents.map((ag: any, i: number) => (
                <tr key={ag.agent} className="clickable">
                  <td className="muted">{String(i + 1).padStart(2, "0")}</td>
                  <td><AgentLink name={ag.agent} /></td>
                  <td className="num">{fmt.n(ag.session_count)}</td>
                  <td className="num">{fmt.n(ag.total_turns)}</td>
                  <td className="num strong">{fmt.usd(ag.total_cost)}</td>
                  <td style={{ width: 100 }}><TBar pct={(ag.total_cost / Math.max(0.001, topAgents[0]?.total_cost ?? 1)) * 100} /></td>
                </tr>
              ))}
            </tbody>
          </table>

          <Rule />

          {/* Files */}
          <div className="section-head" style={{ marginTop: 32 }}>
            <h2 className="h-section">Files — most edited</h2>
            <span className="section-meta">top {topFiles.length} files touched</span>
          </div>
          <ul className="files-list" style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {topFiles.slice(0, 8).map((f: any) => (
              <li key={f.file_path} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 12, alignItems: 'center' }}>
                <span className="mono file-path">{f.file_path?.split(/[/\\]/).pop() ?? f.file_path}</span>
                <span className="mono muted">{f.edits} edits</span>
              </li>
            ))}
          </ul>

          <Rule />

          {/* Recent errors */}
          <div className="section-head" style={{ marginTop: 32 }}>
            <h2 className="h-section">Errors — recent</h2>
            <span className="section-meta">
              {recentErrors.length} recent events · <a href="/errors" className="inline-link">see all →</a>
            </span>
          </div>
          {recentErrors.length === 0 ? (
            <div className="empty-block">No errors recorded — a quiet fortnight.</div>
          ) : (
            <table className="ledger ledger-errors">
              <thead><tr><th>When</th><th>Severity</th><th>Kind</th><th>Tool</th><th>Message</th><th>Session</th></tr></thead>
              <tbody>
                {recentErrors.map((e: any, i: number) => (
                  <tr key={i} className="clickable">
                    <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>
                      <div>{fmt.date(e.ts)}</div>
                      <div className="tiny">{fmt.time(e.ts)}</div>
                    </td>
                    <td><SeverityTag severity={e.severity} /></td>
                    <td><span className="kind-tag" style={{ background: 'var(--rule)', padding: '2px 6px', borderRadius: 2, fontSize: 11 }}>{e.kind}</span></td>
                    <td className="mono">{e.tool ?? '—'}</td>
                    <td className="err-msg mono" style={{ opacity: 0.8, maxWidth: '280px' }} title={e.message}>{e.message?.slice(0, 60) ?? e.kind}</td>
                    <td className="session-cell"><a href={`/sessions/${e.session_id}`} style={{ textDecoration: 'none', color: 'inherit' }}>{e.session_id?.slice(0, 8)} ↗</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <aside className="col-side">
          {/* People leaderboard */}
          <div className="panel panel-feature">
            <Eyebrow>People · top operators</Eyebrow>
            <h3 className="h-panel">Who's <em>driving.</em></h3>
            <ul className="people-mini" style={{ listStyle: 'none', padding: 0, margin: '16px 0', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {topPeople.slice(0, 6).map(p => (
                <li key={p.person_id} className="people-mini-row" style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <PersonLink personId={p.person_id} personName={p.person_name ?? p.person_id} />
                  <div style={{ marginLeft: 'auto' }} className="people-mini-cost strong">{fmt.usd(p.total_cost)}</div>
                </li>
              ))}
            </ul>
            <div className="panel-foot">
              <a className="panel-link" href="/people">See all {topPeople.length} people →</a>
            </div>
          </div>

          {/* Tool mix */}
          <div className="panel">
            <Eyebrow>Tool mix</Eyebrow>
            <h3 className="h-panel">What the agents <em>reach for.</em></h3>
            <div className="bars" style={{ marginTop: 4 }}>
              {toolMix.map((t: any) => (
                <BarRow key={t.tool_name} label={t.tool_name} value={t.call_count} max={maxToolCalls} fmt={fmt.k} />
              ))}
            </div>
          </div>

          {/* Providers */}
          <div className="panel">
            <Eyebrow>Providers</Eyebrow>
            <h3 className="h-panel">Anthropic vs <em>Google.</em></h3>
            <StackBar segments={providers.map(p => ({
              pct: (p.cost / Math.max(kpis.total_cost, 0.001)) * 100,
              cls: `seg-${p.provider.toLowerCase()}`,
              title: `${p.provider}: ${fmt.usd(p.cost)}`
            }))} />
            <table className="model-table">
              <tbody>
                {providers.map(p => (
                  <tr key={p.provider}>
                    <td><ProviderTag provider={p.provider} /></td>
                    <td className="num strong">{fmt.usd(p.cost)}</td>
                    <td className="num muted">{fmt.pct(p.cost / Math.max(kpis.total_cost, 0.001))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Models */}
          <div className="panel">
            <Eyebrow>Models</Eyebrow>
            <h3 className="h-panel">Where the money went.</h3>
            <StackBar segments={models.map(m => {
              const pfx = m.model.includes('opus') ? 'opus' : m.model.includes('sonnet') ? 'sonnet' : m.model.includes('gemini-2.5-pro') ? 'gpro' : m.model.includes('gemini') ? 'gflash' : 'haiku';
              return {
                pct: (m.cost / Math.max(kpis.total_cost, 0.001)) * 100,
                cls: `seg-${pfx}`,
                title: `${m.model}: ${fmt.usd(m.cost)}`
              }
            })} />
            <table className="model-table">
              <tbody>
                {models.map(m => (
                  <tr key={m.model}>
                    <td><ModelPill model={m.model} /></td>
                    <td className="num strong">{fmt.usd(m.cost)}</td>
                    <td className="num muted">{fmt.pct(m.cost / Math.max(kpis.total_cost, 0.001))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Cache */}
          <div className="panel">
            <Eyebrow>Cache · ephemeral</Eyebrow>
            <h3 className="h-panel">5-min vs <em>1-hour</em> writes.</h3>
            <StackBar segments={[
              { pct: cache5m / Math.max(cache5m + cache1h, 1) * 100, cls: 'seg-haiku', title: '5-min' },
              { pct: cache1h / Math.max(cache5m + cache1h, 1) * 100, cls: 'seg-opus', title: '1-hour' }
            ]} />
            <div className="bars" style={{ marginTop: 14 }}>
              <div className="bar-row">
                <div className="bar-label"><span className="dot" style={{ background: "var(--muted-2)" }} /> 5-minute</div>
                <div className="bar-value">{fmt.k(cache5m)}</div>
                <div className="bar-pct muted">{fmt.pct(cache5m / Math.max(cache5m + cache1h, 1))}</div>
              </div>
              <div className="bar-row">
                <div className="bar-label"><span className="dot" style={{ background: "var(--accent)" }} /> 1-hour</div>
                <div className="bar-value">{fmt.k(cache1h)}</div>
                <div className="bar-pct muted">{fmt.pct(cache1h / Math.max(cache5m + cache1h, 1))}</div>
              </div>
              <div className="bar-row" style={{ marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--rule)" }}>
                <div className="bar-label muted">Cache reads</div>
                <div className="bar-value">{fmt.k(cacheR)}</div>
                <div className="bar-pct muted">{fmt.pct(cacheR / Math.max(cacheR + cache5m + cache1h, 1))}</div>
              </div>
            </div>
          </div>

          {/* Editor's note */}
          {/* TODO: Fetch editor quote from a static config file or a new dbt seed (e.g., team_memos.csv). */}
          <div className="panel panel-quote" style={{ background: 'transparent', border: 'none', borderTop: '1px solid var(--rule-strong)', padding: '24px 0' }}>
            <Eyebrow>Editor's note</Eyebrow>
            <blockquote className="pull" style={{ fontFamily: 'var(--serif)', fontSize: 24, margin: '8px 0 12px', fontWeight: 300, letterSpacing: '-0.015em', lineHeight: 1.2 }}>
              {kpis.editor_quote ?? null}
            </blockquote>
            <div className="pull-attrib" style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--muted)' }}>{kpis.editor_quote_author ?? '—'}</div>
          </div>
        </aside>
      </section>
    </div>
  )
}
