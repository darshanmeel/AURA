export const dynamic = 'force-dynamic'

import { Eyebrow, Rule, StatBlock, AgentLink, TBar } from '../../components/atoms'
import { ClickableRow } from '../../components/ClickableRow'
import { InlineLink } from '../../components/InlineLink'
import { RangeFilter } from '../../components/RangeFilter'
import { fmt } from '../../lib/fmt'
import { parseRange, rangeSince, rangeLabel } from '../../lib/range'
import { getAllAgents } from '../../lib/queries/agents'

export default async function AgentsPage({
  searchParams,
}: { searchParams?: { range?: string } }) {
  const range = parseRange(searchParams?.range)
  const since = rangeSince(range)

  let agents: any[] = []
  try {
    agents = await getAllAgents(since) as any[]
  } catch (e) { console.error('[agents] data load failed:', e) }

  const totalCost = agents.reduce((s: number, a: any) => s + (a.total_cost ?? 0), 0)
  const uniqueNames = new Set(agents.map((a: any) => a.agent)).size
  const maxCost = agents[0]?.total_cost ?? 1

  // Group rows by agent name so we can show how many apps each one appears in
  const appCountByAgent: Record<string, number> = {}
  for (const a of agents) {
    appCountByAgent[a.agent] = (appCountByAgent[a.agent] ?? 0) + 1
  }

  return (
    <div className="page-layout">
      <section className="masthead-strap">
        <Eyebrow>Agents · {uniqueNames} unique · {agents.length} app assignments · {rangeLabel(range)}</Eyebrow>
        <div className="strap-right">
          <RangeFilter current={range} />
          <span className="strap-pill is-muted">{fmt.usd(totalCost)} aggregate</span>
        </div>
      </section>

      <section className="page-head">
        <Eyebrow>The roster</Eyebrow>
        <h1 className="display display-sm">
          {uniqueNames} agent{uniqueNames !== 1 ? 's' : ''}, <em>across all apps.</em>
        </h1>
        <p className="hero-lede">
          The same agent name can run in multiple apps and projects. Each row below is one agent in one app.
        </p>
        <p className="muted" style={{ fontSize: 12, marginTop: 8, maxWidth: 720 }}>
          <strong>Note on attribution:</strong> Only subagents dispatched via the Task tool (with a{' '}
          <span className="mono">subagent_type</span> argument) are resolved by name. Sessions launched
          directly with <span className="mono">claude --agent &lt;name&gt;</span> appear as{' '}
          <span className="mono">main</span> — the agent identity for top-level CLI launches lives in the
          system prompt rather than in any structured JSONL field, so it can&rsquo;t be recovered after
          the fact.
        </p>
      </section>

      <Rule weight="thick" />

      <section className="strip">
        <StatBlock label="Agents" value={fmt.n(uniqueNames)} footnote="unique names" />
        <StatBlock label="App assignments" value={fmt.n(agents.length)} footnote="agent × app rows" />
        <StatBlock label="Total cost" value={fmt.usd(totalCost)} footnote="aggregate" accent />
      </section>

      <Rule weight="thick" />

      {agents.length === 0 ? (
        <div className="empty-block">No agent data — dim_agents will populate after dbt runs.</div>
      ) : (
        <table className="ledger">
          <thead>
            <tr>
              <th>#</th>
              <th>Agent</th>
              <th>App</th>
              <th>Project</th>
              <th className="num">Sessions</th>
              <th className="num">Turns</th>
              <th className="num">Tools</th>
              <th className="num">Cost</th>
              <th>Share</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((ag: any, i: number) => (
              <ClickableRow key={`${ag.agent}-${ag.app_id}`} href={`/agents/${encodeURIComponent(ag.agent)}`}>
                <td className="muted">{String(i + 1).padStart(2, '0')}</td>
                <td>
                  <AgentLink name={ag.agent} />
                  {(appCountByAgent[ag.agent] ?? 0) > 1 && (
                    <span className="muted tiny" style={{ marginLeft: 6 }}>
                      · {appCountByAgent[ag.agent]} apps
                    </span>
                  )}
                </td>
                <td>
                  {ag.app_id
                    ? <InlineLink href={`/apps/${encodeURIComponent(ag.app_id)}`} style={{ fontSize: 12 }}>{ag.app_id}</InlineLink>
                    : <span className="muted">—</span>}
                </td>
                <td className="muted" style={{ fontSize: 12 }}>{ag.project_id ?? '—'}</td>
                <td className="num">{fmt.n(ag.session_count)}</td>
                <td className="num">{fmt.n(ag.total_turns)}</td>
                <td className="num">{fmt.n(ag.total_tool_calls)}</td>
                <td className="num strong">{fmt.usd(ag.total_cost)}</td>
                <td><TBar pct={((ag.total_cost ?? 0) / Math.max(0.001, maxCost)) * 100} /></td>
              </ClickableRow>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
