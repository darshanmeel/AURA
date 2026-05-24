export const dynamic = 'force-dynamic'

import {
  Eyebrow, Rule, StatBlock,
  AppLink, ModelPill, ProviderTag,
} from '../../../components/atoms'
import { ProfileBackRail } from '../../../components/panels'
import { fmt } from '../../../lib/fmt'
import {
  getAgent, getAgentApps, getAgentModels, getAgentSessions, getAgentFiles,
} from '../../../lib/queries/agents'
import { getAgentPrompts } from '../../../lib/queries/prompts'

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

function fileKindClass(ext: string | null | undefined): string {
  const e = (ext ?? '').toLowerCase()
  if (e === 'md') return 'file-kind-md'
  if (e === 'py') return 'file-kind-py'
  if (e === 'ts' || e === 'tsx') return 'file-kind-ts'
  return ''
}

export default async function AgentProfilePage({ params }: { params: { name: string } }) {
  const name = decodeURIComponent(params.name)

  let agent: any = null
  let apps: any[] = []
  let models: any[] = []
  let sessions: any[] = []
  let files: any[] = []
  let prompts: any[] = []

  try {
    const [ag, ap, mo, se, fi, pr] = await Promise.all([
      getAgent(name),
      getAgentApps(name),
      getAgentModels(name),
      getAgentSessions(name, 12),
      getAgentFiles(name, 8),
      getAgentPrompts(name, 6),
    ])
    agent = ag
    apps = ap as any[]
    models = mo as any[]
    sessions = se as any[]
    files = fi as any[]
    prompts = pr as any[]
  } catch {}

  // Show empty state rather than hard 404 when no data yet
  if (!agent) {
    return (
      <div className="page-layout">
        <ProfileBackRail href="/sessions" label="Back" />
        <div className="empty-block" style={{ margin: '60px 0' }}>
          No sessions recorded for <strong>{name}</strong>.
        </div>
      </div>
    )
  }

  const totalCost: number = Number(agent.total_cost ?? 0)
  const sessionCount: number = Number(agent.session_count ?? 0)
  const totalTurns: number = Number(agent.total_turns ?? 0)
  const totalTools: number = Number(agent.total_tool_calls ?? 0)
  const totalTokens: number = Number(agent.total_output_tokens ?? 0)
  const appCount: number = Number(agent.app_count ?? 0)
  const modelsCount: number = models.length

  const maxAppCost = apps.length > 0 ? Math.max(Number(apps[0].total_cost ?? 0), 0.0001) : 1
  const maxModelCost = models.length > 0 ? Math.max(Number(models[0].cost ?? 0), 0.0001) : 1

  const inferProvider = (model: string) =>
    model?.startsWith('claude') ? 'Anthropic'
    : model?.startsWith('gemini') ? 'Google'
    : 'Unknown'

  return (
    <div className="page-layout">
      <ProfileBackRail href="/sessions" label="Back" />

      {/* Profile head */}
      <section className="profile-head">
        <div className="profile-head-left">
          <span className="agent-glyph" aria-hidden="true">⌬</span>
          <div>
            <Eyebrow dot={false}>
              agent · serving — people in {fmt.n(appCount)} apps
            </Eyebrow>
            <h1
              className="display display-sm"
              style={{ fontFamily: 'var(--mono)', letterSpacing: '-0.01em', margin: '8px 0 12px' }}
            >
              {name}
            </h1>
            <div className="profile-meta">
              <span><b>{fmt.n(sessionCount)}</b> sessions</span>
              <span className="meta-dot">·</span>
              <span><b>{fmt.n(totalTurns)}</b> turns</span>
              <span className="meta-dot">·</span>
              <span><b>{fmt.n(totalTools)}</b> tool calls</span>
              <span className="meta-dot">·</span>
              <span><b>{agent.commits != null ? fmt.n(agent.commits) : '—'}</b> commits</span>
            </div>
          </div>
        </div>
        <div className="profile-head-right">
          <div className="hero-stat hero-stat-detail">
            <div className="hero-stat-eyebrow">14-DAY SPEND</div>
            <div className="hero-stat-value">{fmt.usd(totalCost)}</div>
            <div className="hero-stat-foot">
              <em>across</em> {fmt.k(totalTokens)} tokens
            </div>
          </div>
        </div>
      </section>

      <Rule weight="thick" />

      {/* 6-stat strip */}
      <section className="strip">
        <StatBlock label="Sessions" value={fmt.n(sessionCount)} footnote="14 days" />
        <StatBlock label="Apps" value={fmt.n(appCount)} footnote="serving" />
        <StatBlock label="People" value="—" footnote="delegating" accent />
        <StatBlock label="Tool calls" value={fmt.n(totalTools)} footnote="total" />
        <StatBlock label="Models" value={fmt.n(modelsCount)} footnote="routed to" />
        <StatBlock
          label="Errors"
          value={agent.errors != null ? fmt.n(agent.errors) : '—'}
          footnote="across sessions"
        />
      </section>

      <Rule weight="thick" />

      {/* Two-col layout */}
      <section className="cols">
        {/* ── Main column ── */}
        <div className="col-main">

          {/* Apps served */}
          <div className="section-head">
            <h2 className="h-section">Apps — served</h2>
            <span className="section-meta">where this agent works</span>
          </div>
          {apps.length > 0 ? (
            <table className="ledger">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Project</th>
                  <th className="num">Sessions</th>
                  <th className="num">Turns</th>
                  <th className="num">Cost</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((ap: any) => (
                  <tr key={`${ap.app_id}-${ap.project_id}`}>
                    <td>
                      <AppLink
                        appId={ap.app_id ?? ''}
                        appName={ap.app_id ?? '—'}
                      />
                    </td>
                    <td className="mono muted" style={{ fontSize: 12 }}>
                      {ap.project_id ?? '—'}
                    </td>
                    <td className="num">{fmt.n(ap.session_count)}</td>
                    <td className="num">{fmt.n(ap.total_turns)}</td>
                    <td className="num strong">{fmt.usd(ap.total_cost)}</td>
                    <td>
                      <div className="tbar">
                        <div
                          className="tbar-fill"
                          style={{
                            width: `${(Number(ap.total_cost ?? 0) / maxAppCost) * 100}%`,
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-block">
              No app data yet — dim_agents will populate after dbt runs.
            </div>
          )}

          <Rule />

          {/* Models routed to */}
          <div className="section-head" style={{ marginTop: 28 }}>
            <h2 className="h-section">Models — routed to</h2>
            <span className="section-meta">cost by model</span>
          </div>
          {models.length > 0 ? (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Provider</th>
                  <th className="num">Sessions</th>
                  <th className="num">Cost</th>
                  <th>Share</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m: any) => (
                  <tr key={m.model}>
                    <td><ModelPill model={m.model} /></td>
                    <td><ProviderTag provider={inferProvider(m.model)} /></td>
                    <td className="num">{fmt.n(m.sessions)}</td>
                    <td className="num strong">{fmt.usd(m.cost)}</td>
                    <td>
                      <div className="tbar">
                        <div
                          className="tbar-fill"
                          style={{
                            width: `${(Number(m.cost ?? 0) / maxModelCost) * 100}%`,
                          }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-block">
              No model data yet — int_event_agent / fact_turns will populate after dbt runs.
            </div>
          )}

          <Rule />

          {/* Sessions — recent */}
          <div className="section-head" style={{ marginTop: 28 }}>
            <h2 className="h-section">Sessions — recent</h2>
            <span className="section-meta">all {fmt.n(sessionCount)} sessions for {name}</span>
          </div>
          {sessions.length > 0 ? (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>App</th>
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
                    <td>
                      {s.app_id
                        ? <AppLink appId={s.app_id} appName={s.app_id} />
                        : <span className="muted mono" style={{ fontSize: 11 }}>
                            {s.cwd?.split(/[/\\]/).pop() ?? '—'}
                          </span>
                      }
                    </td>
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
            <div className="empty-block">No sessions recorded for {name} yet.</div>
          )}
        </div>

        {/* ── Side panels ── */}
        <aside className="col-side">
          {/* Top files */}
          {files.length > 0 && (
            <div className="panel">
              <Eyebrow>Files · top</Eyebrow>
              <h3 className="h-panel">What {name} <em>touches.</em></h3>
              <ul className="files-list files-list-tight">
                {files.map((f: any) => {
                  const ext = f.file_ext ?? f.file_path?.split('.').pop() ?? ''
                  return (
                    <li key={f.file_path} className="file-row">
                      <span className={`file-kind ${fileKindClass(ext)}`}>
                        {ext || '?'}
                      </span>
                      <span
                        className="mono file-path"
                        title={f.file_path}
                      >
                        {f.file_path?.split(/[/\\]/).slice(-3).join('/') ?? f.file_path}
                      </span>
                      <span className="mono file-edits">{fmt.n(f.edits ?? 0)}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {/* Prompts directed at this agent */}
          <div className="panel panel-prompts">
            <Eyebrow>Prompts · directed at {name}</Eyebrow>
            <h3 className="h-panel">What operators <em>ask for.</em></h3>
            {prompts.length > 0 ? (
              <ol className="prompts">
                {prompts.map((p: any, i: number) => (
                  <li key={i} className="prompt">
                    <div className="prompt-meta">
                      <span className="mono tiny muted">
                        {fmt.date(p.prompt_ts)} · {fmt.time(p.prompt_ts)}
                      </span>
                      {p.app_id && (
                        <AppLink appId={p.app_id} appName={p.app_id} />
                      )}
                    </div>
                    <p className="prompt-text">
                      &ldquo;{trunc200(p.prompt_text_200)}&rdquo;
                    </p>
                    <div className="prompt-mini-stats">
                      {p.turn_count != null && <span>{p.turn_count} turns</span>}
                      {p.files_edited != null && <span>{p.files_edited} files</span>}
                      {p.cost_total != null && <span>{fmt.usd(p.cost_total)}</span>}
                      {p.is_overkill && (
                        <span style={{ color: 'var(--warn)' }}>overkill</span>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p
                className="muted"
                style={{ fontFamily: 'var(--serif)', fontStyle: 'italic', fontSize: 14 }}
              >
                No prompts recorded yet — fact_prompts will populate after dbt runs.
              </p>
            )}
          </div>
        </aside>
      </section>
    </div>
  )
}
