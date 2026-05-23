import { Eyebrow, Rule, StatBlock, BarRow, ProviderTag, ModelPill, AgentLink, PersonLink, SeverityTag } from '../components/atoms'
import { DailyChart, Sparkline } from '../components/charts'
import { SessionMiniTable } from '../components/tables'
import { SideRail, SideSection } from '../components/panels'
import { fmt } from '../lib/fmt'

async function getDashboardData() {
  const base = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000'
  const res = await fetch(`${base}/api/dashboard`, { next: { revalidate: 30 } })
  if (!res.ok) return null
  return res.json()
}

export default async function DashboardPage() {
  const data = await getDashboardData()
  const kpis = data?.kpis ?? {}
  const dailySpend = data?.dailySpend ?? []
  const topApps = data?.topApps ?? []
  const topAgents = data?.topAgents ?? []
  const toolMix = data?.toolMix ?? []
  const providers = data?.providers ?? []
  const models = data?.models ?? []
  const recentErrors = data?.recentErrors ?? []
  const topFiles = data?.topFiles ?? []
  const topPeople = data?.topPeople ?? []

  const totalDays = dailySpend.length
  const maxCost = Math.max(...topApps.map((a: any) => a.total_cost ?? 0), 0.001)
  const maxToolCalls = Math.max(...toolMix.map((t: any) => t.call_count ?? 0), 1)

  return (
    <div className="page-layout">
      {/* Masthead strap */}
      <div className="strap eyebrow muted">
        {totalDays} days · {providers.length} providers · {fmt.n(kpis.total_people)} people · {fmt.n(kpis.total_apps)} apps
        {kpis.last_session && <span> · last ingest {fmt.time(kpis.last_session)}</span>}
      </div>

      {/* Hero */}
      <section className="hero">
        <div className="hero-text">
          <h1 className="serif">Spend, <em>with receipts.</em></h1>
          <p className="hero-lede">
            {fmt.usd(kpis.total_cost)} across {fmt.n(kpis.total_sessions)} sessions.
            Cache hit rate {fmt.pct(kpis.cache_hit_rate)}.
          </p>
          <div className="hero-ctas">
            <a href="/sessions" className="btn btn--filled">Sessions →</a>
            <a href="/errors" className="btn btn--ghost">Errors</a>
          </div>
        </div>
        <div className="hero-chart">
          <DailyChart data={dailySpend} />
        </div>
      </section>

      <Rule />

      {/* KPI strip */}
      <div className="kpi-strip">
        <StatBlock label="Active now" value={fmt.n(kpis.active_sessions)} />
        <StatBlock label="Cache hit %" value={fmt.pct(kpis.cache_hit_rate)} />
        <StatBlock label="Tool calls" value={fmt.k(kpis.total_tool_calls)} />
        <StatBlock label="Commits" value={fmt.n(kpis.total_commits ?? 0)} />
        <StatBlock label="Errors" value={fmt.n(recentErrors.length)} />
        <StatBlock label="Total spend" value={fmt.usd(kpis.total_cost)} />
      </div>

      <Rule />

      <div className="main-with-rail">
        <div className="main-col">
          {/* Apps ledger */}
          <section>
            <Eyebrow>Apps</Eyebrow>
            <table className="ledger-table">
              <thead><tr><th>App</th><th>Sessions</th><th>Turns</th><th>Agents</th><th>Cost</th></tr></thead>
              <tbody>
                {topApps.map((app: any) => (
                  <tr key={app.app_id}>
                    <td><a href={`/apps/${encodeURIComponent(app.app_id)}`}>{app.app_name}</a></td>
                    <td className="num">{fmt.n(app.session_count)}</td>
                    <td className="num">{fmt.n(app.total_turns)}</td>
                    <td className="muted">{(app.agents ?? []).slice(0, 2).join(', ')}</td>
                    <td className="num accent">{fmt.usd(app.total_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <Rule />

          {/* Agents */}
          <section>
            <Eyebrow>Agents</Eyebrow>
            <table className="ledger-table">
              <thead><tr><th>Agent</th><th>Sessions</th><th>Turns</th><th>Cost</th></tr></thead>
              <tbody>
                {topAgents.map((ag: any) => (
                  <tr key={ag.agent}>
                    <td><AgentLink name={ag.agent} /></td>
                    <td className="num">{fmt.n(ag.session_count)}</td>
                    <td className="num">{fmt.n(ag.total_turns)}</td>
                    <td className="num accent">{fmt.usd(ag.total_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <Rule />

          {/* Files */}
          <section>
            <Eyebrow>Most edited files</Eyebrow>
            {topFiles.slice(0, 8).map((f: any, i: number) => (
              <BarRow key={f.file_path} label={f.file_path?.split(/[/\\]/).pop() ?? f.file_path} value={f.edits} max={topFiles[0]?.edits ?? 1} fmt={fmt.n} />
            ))}
          </section>

          <Rule />

          {/* Recent errors */}
          <section>
            <Eyebrow>Recent errors</Eyebrow>
            <table className="ledger-table">
              <thead><tr><th>When</th><th>Kind</th><th>Tool</th><th>Message</th></tr></thead>
              <tbody>
                {recentErrors.map((e: any, i: number) => (
                  <tr key={i}>
                    <td className="mono muted">{fmt.time(e.ts)}</td>
                    <td><SeverityTag severity={e.severity} /></td>
                    <td className="mono">{e.tool ?? '—'}</td>
                    <td className="muted">{e.message?.slice(0, 60) ?? e.kind}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <a href="/errors" className="muted eyebrow">View all →</a>
          </section>
        </div>

        <SideRail>
          <SideSection title="People">
            {topPeople.map((p: any) => (
              <div key={p.person_id} className="side-row">
                <PersonLink personId={p.person_id} personName={p.person_name ?? p.person_id} />
                <span className="num accent">{fmt.usd(p.total_cost)}</span>
              </div>
            ))}
          </SideSection>

          <SideSection title="Tool mix">
            {toolMix.map((t: any) => (
              <BarRow key={t.tool_name} label={t.tool_name} value={t.call_count} max={maxToolCalls} fmt={fmt.k} />
            ))}
          </SideSection>

          <SideSection title="Providers">
            {providers.map((p: any) => (
              <div key={p.provider} className="side-row">
                <ProviderTag provider={p.provider} />
                <span className="num accent">{fmt.usd(p.cost)}</span>
              </div>
            ))}
          </SideSection>

          <SideSection title="Models">
            {models.map((m: any) => (
              <div key={m.model} className="side-row">
                <ModelPill model={m.model} />
                <span className="num muted">{fmt.usd(m.cost)}</span>
              </div>
            ))}
          </SideSection>

          <SideSection title="Cache">
            <StatBlock label="5m window" value={fmt.k(kpis.cache_5m_total)} />
            <StatBlock label="1h window" value={fmt.k(kpis.cache_1h_total)} />
          </SideSection>
        </SideRail>
      </div>
    </div>
  )
}
