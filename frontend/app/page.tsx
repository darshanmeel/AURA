export const dynamic = 'force-dynamic'

import React from 'react'
import { Eyebrow, Rule, StatBlock, BarRow, ProviderTag, ModelPill, AgentLink, PersonLink, SeverityTag, TBar, StackBar, StatusDot } from '../components/atoms'
import { ClickableRow } from '../components/ClickableRow'
import { ClientTime } from '../components/ClientTime'
import { DailyChart } from '../components/charts'
import { SideRail, SideSection } from '../components/panels'
import { RangeFilter } from '../components/RangeFilter'
import { fmt } from '../lib/fmt'
import { safe } from '../lib/api-safe'
import { parseRange, rangeSince, rangeLabel } from '../lib/range'
import {
  getDashboardKPIs, getDailySpend, getTopApps, getTopProjects, getTopAgents,
  getToolMix, getProviderSplit, getModelBreakdown,
  getRecentErrors, getTopFiles, getTopPeople,
  getSpendPace, getHourlyActivity, getTokenSeries,
  getTopSkills, getTopMcps,
} from '../lib/queries/dashboard'
import { TokenSeriesChart, TOKEN_TYPE_SEGMENTS } from '../components/TokenSeriesChart'
import { getLoudestPromptOfDay } from '../lib/queries/prompts'
import { BurnRate } from '../components/BurnRate'
import { ActivityHeatmap } from '../components/ActivityHeatmap'

export default async function DashboardPage({
  searchParams,
}: { searchParams?: { range?: string } }) {
  const range = parseRange(searchParams?.range)
  const since = rangeSince(range)

  let kpis: any = {}, dailySpend: any[] = [], topApps: any[] = [], topProjects: any[] = [], topAgents: any[] = []
  let toolMix: any[] = [], providers: any[] = [], models: any[] = [], recentErrors: any[] = []
  let topFiles: any[] = [], topPeople: any[] = []
  let loudestPrompt: { prompt_text_200: string; agent: string; app_id: string; model_primary: string } | null = null
  let spendPace: any = null
  let hourlyActivity: any[] = []

  // Each query is isolated via safe() (lib/api-safe): a missing table (e.g.
  // dim_sessions before the first dbt run) must not blank the whole dashboard.
  // A genuine failure logs under the greppable [aura:safe] marker and falls
  // back, so it is distinguishable from a legitimately empty result.

  // Hourly bucket only when looking at today; everything else bucket by day.
  const hourly = range === 'today'

  const [kpisArr, ds, ta, tproj, tag, tm, prov, mod, re, tf, tp, lp, sp, ha, ts, tsk, tmcp] = await Promise.all([
    safe('kpis',            () => getDashboardKPIs(since),  null),
    safe('dailySpend',      () => getDailySpend(since),     [] as any[]),
    safe('topApps',         () => getTopApps(since),        [] as any[]),
    safe('topProjects',     () => getTopProjects(since),    [] as any[]),
    safe('topAgents',       () => getTopAgents(since),      [] as any[]),
    safe('toolMix',         () => getToolMix(since),        [] as any[]),
    safe('providers',       () => getProviderSplit(since),  [] as any[]),
    safe('models',          () => getModelBreakdown(since), [] as any[]),
    safe('recentErrors',    () => getRecentErrors(since),   [] as any[]),
    safe('topFiles',        () => getTopFiles(since),       [] as any[]),
    safe('topPeople',       () => getTopPeople(since),      [] as any[]),
    safe('loudestPrompt',   () => getLoudestPromptOfDay(),  null),
    safe('spendPace',       () => getSpendPace(),           null),
    safe('hourlyActivity',  () => getHourlyActivity(),      [] as any[]),
    safe('tokenSeries',     () => getTokenSeries(since, hourly), [] as any[]),
    safe('topSkills',       () => getTopSkills(since),      [] as any[]),
    safe('topMcps',         () => getTopMcps(since),        [] as any[]),
  ])
  kpis = kpisArr ?? {}
  dailySpend = ds as any[]; topApps = ta as any[]; topProjects = tproj as any[]; topAgents = tag as any[]
  toolMix = tm as any[]; providers = prov as any[]; models = mod as any[]
  recentErrors = re as any[]; topFiles = tf as any[]; topPeople = tp as any[]
  loudestPrompt = lp as any
  spendPace = sp as any
  hourlyActivity = ha as any[]
  const tokenSeries = (ts as any[]) ?? []
  const topSkills = (tsk as any[]) ?? []
  const topMcps   = (tmcp as any[]) ?? []

  const totalDays = dailySpend.length
  const maxCost = Math.max(...topApps.map((a: any) => a.total_cost ?? 0), 0.001)
  const maxToolCalls = Math.max(...toolMix.map((t: any) => t.call_count ?? 0), 1)

  const cache5m = kpis.cache_5m_total ?? 0
  const cache1h = kpis.cache_1h_total ?? 0
  const cacheR = kpis.cache_read_total ?? 0

  const providerSummary = providers
    .slice(0, 3)
    .map(p => `${p.provider ?? 'Unknown'} (${fmt.usd(p.cost)})`)
    .join(' · ')
  const heroLede = `${providers.length} provider${providers.length !== 1 ? 's' : ''} — ${providerSummary || '—'} — ${fmt.usd(kpis.total_cost)} total over ${rangeLabel(range)}.`

  const rangeLabelUp = rangeLabel(range).toUpperCase()

  // Projected 30d: when range is 'all', fall back to totalDays from dailySpend
  const effectiveDays = range === 'all' ? Math.max(1, totalDays || 1)
    : range === '30d' ? 30
    : range === '7d' ? 7
    : 1
  const dailyAvg = (kpis.total_cost ?? 0) / effectiveDays
  const proj30 = dailyAvg * 30

  return (
    <div className="page page-layout">
      {/* Masthead strap */}
      <section className="masthead-strap">
        <Eyebrow>{rangeLabel(range)} · {providers.length} providers · {fmt.n(kpis.total_people)} people · {fmt.n(kpis.total_apps)} apps</Eyebrow>
        <div className="strap-right">
          <RangeFilter current={range} />
          <span className="strap-pill"><StatusDot status={kpis.last_session ? 'active' : 'completed'} label={<>pipeline live · <ClientTime ts={kpis.last_session} /></>} /></span>
          <span className="strap-pill is-muted">{fmt.n(kpis.total_sessions)} sessions · {fmt.n(kpis.total_agents ?? topAgents.length)} agents</span>
        </div>
      </section>

      {/* Burn rate strip */}
      <BurnRate pace={spendPace} />

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
            <div className="hero-stat-eyebrow">{rangeLabelUp} SPEND</div>
            <div className="hero-stat-value">{fmt.usd(kpis.total_cost)}</div>
            <div className="hero-stat-foot">
              <em>against</em> {fmt.k((kpis.total_input_tokens ?? 0) + (kpis.total_output_tokens ?? 0))} tokens · {fmt.n(kpis.total_tool_calls)} tool calls · {fmt.n(kpis.total_commits ?? 0)} commits
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
        <StatBlock label="Tool calls" value={fmt.k(kpis.total_tool_calls)} footnote={rangeLabel(range)} />
        <StatBlock label="Commits" value={fmt.n(kpis.total_commits ?? 0)} footnote={`across ${fmt.n(kpis.total_apps)} apps`} />
        <StatBlock label="Errors" value={fmt.n(recentErrors.length)} footnote="recorded recently" accent />
        <StatBlock label="Budget-killed" value={fmt.n(kpis.budget_killed_count ?? 0)} footnote="runs hit max turns" />
        <StatBlock label="Projected · 30d" value={`$${proj30.toFixed(0)}`} footnote={`@$${dailyAvg.toFixed(2)} / day`} />
      </section>

      <Rule weight="thick" />

      {/* Token volume over time — stacked by token type. Hourly for 'today',
          daily for longer ranges. Drill-down lives at /tokens. */}
      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h2 className="h-section">Tokens over {hourly ? 'today (hourly)' : `${rangeLabel(range)} (daily)`}</h2>
          <span className="section-meta">
            stacked by type · <a href={`/tokens?range=${range}`} style={{ color: 'var(--accent)' }}>full breakdown →</a>
          </span>
        </div>
        <TokenSeriesChart rows={tokenSeries} segments={TOKEN_TYPE_SEGMENTS} hourly={hourly} height={180} />
      </section>

      <Rule weight="thick" />

      <section className="cols">
        <div className="col-main">
          {/* Apps ledger — flat */}
          <div className="section-head">
            <h2 className="h-section">Apps — by cost</h2>
            <span className="section-meta">{topApps.length} apps · click any row →</span>
          </div>
          <table className="ledger">
            <thead>
              <tr>
                <th>#</th>
                <th>App</th>
                <th className="num">Agents</th>
                <th className="num">Sessions</th>
                <th className="num">Cost</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {topApps.map((app: any, i: number) => (
                <ClickableRow key={app.app_id} href={`/apps/${encodeURIComponent(app.app_id)}`}>
                  <td className="muted">{String(i + 1).padStart(2, "0")}</td>
                  <td>
                    <div className="app-cell">
                      <span className="app-glyph-s">{(app.app_name ?? app.app_id)[0]?.toUpperCase() ?? '?'}</span>
                      <div>
                        <div className="strong">{app.app_name ?? app.app_id}</div>
                        <div className="tiny muted">{app.app_id}</div>
                      </div>
                    </div>
                  </td>
                  <td className="num">{app.agents ? (Array.isArray(app.agents) ? app.agents.length : fmt.n(app.agent_count)) : '—'}</td>
                  <td className="num">{fmt.n(app.session_count)}</td>
                  <td className="num strong">{fmt.usd(app.total_cost)}</td>
                  <td style={{ width: 100 }}><TBar pct={(app.total_cost / Math.max(0.001, topApps[0]?.total_cost ?? 1)) * 100} /></td>
                </ClickableRow>
              ))}
              {topApps.length === 0 && (
                <tr><td colSpan={6} className="empty">No app data — dbt mart will populate after next run.</td></tr>
              )}
            </tbody>
          </table>

          {/* Projects ledger — nested rollup under apps */}
          <div className="section-head" style={{ marginTop: 32 }}>
            <h2 className="h-section">Projects — rollup</h2>
            <span className="section-meta">{topProjects.length} project{topProjects.length !== 1 ? 's' : ''} · apps nested within</span>
          </div>
          {topProjects.length === 0 ? (
            <div className="empty-block">No project data — dim_projects will populate after dbt runs.</div>
          ) : (
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
                  <React.Fragment key={proj.project_id ?? i}>
                    <tr>
                      <td className="muted">{String(i + 1).padStart(2, '0')}</td>
                      <td>
                        <div className="strong">{proj.project_name ?? proj.project_id}</div>
                        {proj.project_id && proj.project_name !== proj.project_id && (
                          <div className="tiny muted mono">{proj.project_id}</div>
                        )}
                      </td>
                      <td className="num">{fmt.n(proj.app_count ?? (proj.apps ?? []).length)}</td>
                      <td className="num">{fmt.n(proj.session_count)}</td>
                      <td className="num">{fmt.n(proj.total_turns)}</td>
                      <td className="num strong">{fmt.usd(proj.total_cost)}</td>
                      <td style={{ width: 100 }}><TBar pct={(proj.total_cost / Math.max(0.001, topProjects[0]?.total_cost ?? 1)) * 100} /></td>
                    </tr>
                    {(proj.apps ?? []).map((a: any) => (
                      <ClickableRow key={a.app_id} href={`/apps/${encodeURIComponent(a.app_id)}`}>
                        <td className="muted" style={{ paddingLeft: 20, fontSize: 11 }}>↳</td>
                        <td className="muted" style={{ paddingLeft: 16 }}>
                          <div style={{ fontSize: 12 }}>{a.app_name ?? a.app_id}</div>
                        </td>
                        <td />
                        <td className="num muted" style={{ fontSize: 12 }}>{fmt.n(a.session_count)}</td>
                        <td className="num muted" style={{ fontSize: 12 }}>{fmt.n(a.total_turns)}</td>
                        <td className="num muted" style={{ fontSize: 12 }}>{fmt.usd(a.total_cost)}</td>
                        <td><TBar pct={((a.total_cost ?? 0) / Math.max(0.001, proj.total_cost ?? 1)) * 100} /></td>
                      </ClickableRow>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}

          <Rule />

          {/* Agents */}
          <div className="section-head" style={{ marginTop: 32 }}>
            <h2 className="h-section">Agents — by cost</h2>
            <span className="section-meta">{topAgents.length} rows · <a href="/agents" className="inline-link">see all →</a></span>
          </div>
          <table className="ledger">
            <thead>
              <tr>
                <th>#</th>
                <th>Agent</th>
                <th>App</th>
                <th>Project</th>
                <th className="num">Sessions</th>
                <th className="num">Turns</th>
                <th className="num">Cost</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {topAgents.map((ag: any, i: number) => (
                <tr key={`${ag.agent}-${ag.app_id}`} className="clickable">
                  <td className="muted">{String(i + 1).padStart(2, "0")}</td>
                  <td><AgentLink name={ag.agent} /></td>
                  <td>
                    {ag.app_id
                      ? <a href={`/apps/${encodeURIComponent(ag.app_id)}`} className="inline-link" style={{ fontSize: 12 }}>{ag.app_id}</a>
                      : <span className="muted">—</span>}
                  </td>
                  <td className="muted" style={{ fontSize: 12 }}>{ag.project_id ?? '—'}</td>
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
            <span className="section-meta">top {topFiles.slice(0, 8).length} of {topFiles.length} files</span>
          </div>
          <ul className="files-list">
            {topFiles.slice(0, 8).map((f: any) => {
              const ext = f.file_ext ?? f.file_path?.split('.').pop() ?? ''
              const maxEdits = Math.max(...topFiles.slice(0, 8).map((x: any) => x.edits ?? 0), 1)
              return (
                <li key={f.file_path} className="file-row">
                  <span className={`file-kind file-kind-${ext}`}>{ext || '?'}</span>
                  <span className="mono file-path" title={f.file_path}>
                    {f.file_path?.split(/[/\\]/).slice(-3).join('/') ?? f.file_path}
                  </span>
                  <span className="file-bar">
                    <span className="file-bar-fill" style={{ width: `${((f.edits ?? 0) / maxEdits) * 100}%` }} />
                  </span>
                  <span className="mono file-edits">{f.edits} edits</span>
                </li>
              )
            })}
            {topFiles.length === 0 && (
              <li className="empty-block">No file data — fact_session_files will populate after dbt runs.</li>
            )}
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
            <div className="empty-block">No errors recorded — a quiet {rangeLabel(range)}.</div>
          ) : (
            <table className="ledger ledger-errors">
              <thead><tr><th>When</th><th>Severity</th><th>Kind</th><th>Tool</th><th>Message</th><th>Session</th></tr></thead>
              <tbody>
                {recentErrors.map((e: any, i: number) => (
                  <tr key={i} className="clickable">
                    <td className="mono muted" style={{ whiteSpace: 'nowrap' }}>
                      <div><ClientTime ts={e.ts} mode="date" /></div>
                      <div className="tiny"><ClientTime ts={e.ts} /></div>
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
          {/* Activity heatmap */}
          <ActivityHeatmap data={hourlyActivity} />
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
            {(() => {
              const MODELS_VISIBLE = 8
              const visibleModels = models.slice(0, MODELS_VISIBLE)
              const hiddenModels = models.slice(MODELS_VISIBLE)
              const visibleCost = visibleModels.reduce((a: number, m: any) => a + (m.cost ?? 0), 0)
              const hiddenCost = hiddenModels.reduce((a: number, m: any) => a + (m.cost ?? 0), 0)
              return (
                <>
                  <StackBar segments={visibleModels.map((m: any) => {
                    const pfx = m.model.includes('opus') ? 'opus' : m.model.includes('sonnet') ? 'sonnet' : m.model.includes('gemini-2.5-pro') ? 'gpro' : m.model.includes('gemini') ? 'gflash' : 'haiku';
                    return {
                      pct: (m.cost / Math.max(kpis.total_cost, 0.001)) * 100,
                      cls: `seg-${pfx}`,
                      title: `${m.model}: ${fmt.usd(m.cost)}`
                    }
                  })} />
                  <table className="model-table">
                    <tbody>
                      {visibleModels.map((m: any) => (
                        <tr key={m.model}>
                          <td><ModelPill model={m.model} /></td>
                          <td className="num strong">
                            {m.cost == null
                              ? <span className="muted tiny">$ — (no pricing)</span>
                              : fmt.usd(m.cost)}
                          </td>
                          <td className="num muted">{m.cost == null ? '—' : fmt.pct(m.cost / Math.max(kpis.total_cost, 0.001))}</td>
                        </tr>
                      ))}
                      {hiddenModels.length > 0 && (
                        <tr>
                          <td className="muted tiny">+ {hiddenModels.length} more</td>
                          <td className="num muted tiny">{fmt.usd(hiddenCost)}</td>
                          <td className="num muted tiny">{fmt.pct(hiddenCost / Math.max(kpis.total_cost, 0.001))}</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {hiddenModels.length > 0 && (
                    <div className="tiny muted" style={{ marginTop: 4 }}>
                      top {MODELS_VISIBLE} of {models.length} · {fmt.usd(visibleCost)} of {fmt.usd(visibleCost + hiddenCost)}
                    </div>
                  )}
                </>
              )
            })()}
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
          <div className="panel panel-quote" style={{ background: 'transparent', border: 'none', borderTop: '1px solid var(--rule-strong)', padding: '24px 0' }}>
            <Eyebrow>Editor's note</Eyebrow>
            <blockquote className="pull" style={{ fontFamily: 'var(--serif)', fontSize: 24, margin: '8px 0 12px', fontWeight: 300, letterSpacing: '-0.015em', lineHeight: 1.2, fontStyle: 'italic' }}>
              {loudestPrompt
                ? loudestPrompt.prompt_text_200
                : <em>The loudest prompt of the day will appear here.</em>
              }
            </blockquote>
            <div className="pull-attrib" style={{ fontFamily: 'var(--sans)', fontSize: 12, color: 'var(--muted)' }}>
              {loudestPrompt
                ? `— ${loudestPrompt.agent} · ${loudestPrompt.app_id}`
                : '—'
              }
            </div>
          </div>
        </aside>
      </section>

      <Rule weight="thick" />

      {/* Skills & MCPs — lives at the bottom; useful context but not headline.
          Empty state is normal until the first dbt cycle after a fresh parser
          deployment populates raw_session_skills / raw_session_mcps. */}
      <section style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
          <h2 className="h-section">Skills &amp; MCPs</h2>
          <span className="section-meta">loaded per session · top 10 each</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {/* Top skills */}
          <div>
            <div className="section-head" style={{ marginBottom: 4 }}>
              <h3 className="h-section" style={{ fontSize: 13 }}>🧩 Top skills</h3>
              <span className="section-meta">{topSkills.length} skill{topSkills.length !== 1 ? 's' : ''}</span>
            </div>
            {topSkills.length === 0 ? (
              <div className="empty-block">No skills loaded in this range.</div>
            ) : (
              <table className="ledger" style={{ tableLayout: 'fixed', width: '100%' }}>
                <thead>
                  <tr>
                    <th>Skill</th>
                    <th className="num" style={{ width: 90 }}>Sessions</th>
                    <th style={{ width: 120 }}>Last used</th>
                  </tr>
                </thead>
                <tbody>
                  {topSkills.map((r: any) => (
                    <tr key={r.skill}>
                      <td className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.skill}
                      </td>
                      <td className="num mono">{fmt.n(r.session_count)}</td>
                      <td className="mono muted">{r.last_used ? fmt.date(r.last_used) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {/* Top MCPs */}
          <div>
            <div className="section-head" style={{ marginBottom: 4 }}>
              <h3 className="h-section" style={{ fontSize: 13 }}>⚡ Top MCP servers</h3>
              <span className="section-meta">{topMcps.length} server{topMcps.length !== 1 ? 's' : ''}</span>
            </div>
            {topMcps.length === 0 ? (
              <div className="empty-block">No MCP servers loaded in this range.</div>
            ) : (
              <table className="ledger" style={{ tableLayout: 'fixed', width: '100%' }}>
                <thead>
                  <tr>
                    <th>MCP server</th>
                    <th className="num" style={{ width: 90 }}>Sessions</th>
                    <th style={{ width: 120 }}>Last used</th>
                  </tr>
                </thead>
                <tbody>
                  {topMcps.map((r: any) => (
                    <tr key={r.mcp_server}>
                      <td className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.mcp_server}
                      </td>
                      <td className="num mono">{fmt.n(r.session_count)}</td>
                      <td className="mono muted">{r.last_used ? fmt.date(r.last_used) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
