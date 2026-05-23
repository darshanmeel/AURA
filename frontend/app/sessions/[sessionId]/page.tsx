export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { Eyebrow, Rule, StatBlock, ModelPill, ProviderTag, SeverityTag, BarRow, AgentLink } from '../../../components/atoms'
import { TurnChart } from '../../../components/charts'
import { ProfileBackRail, SideRail, SideSection } from '../../../components/panels'
import { fmt } from '../../../lib/fmt'
import {
  getSession, getSessionTurns, getSessionErrors,
  getSessionFiles, getSessionToolMix, getSessionGitCommands
} from '../../../lib/queries/sessions'

export default async function SessionDetailPage({ params }: { params: { sessionId: string } }) {
  const id = params.sessionId
  let s: any = null, turns: any[] = [], errors: any[] = [], files: any[] = [], toolMix: any[] = [], gitCommands: any[] = []
  try {
    const [sess, t, e, f, tm, gc] = await Promise.all([
      getSession(id), getSessionTurns(id), getSessionErrors(id),
      getSessionFiles(id), getSessionToolMix(id), getSessionGitCommands(id)
    ])
    s = sess; turns = t as any[]; errors = e as any[]
    files = f as any[]; toolMix = tm as any[]; gitCommands = gc as any[]
  } catch {}
  if (!s) notFound()
  const maxToolCalls = Math.max(...(toolMix ?? []).map((t: any) => t.calls ?? 0), 1)
  const maxEdits = Math.max(...(files ?? []).map((f: any) => f.edit_count ?? 0), 1)

  return (
    <div className="page-layout">
      <ProfileBackRail href="/sessions" label="Sessions" />

      {/* Header */}
      <div className="session-header">
        <div className="session-meta-chips">
          <ProviderTag provider={s.provider} />
          {s.person_name && <span className="muted">{s.person_name}</span>}
          {s.cwd && <span className="mono muted">{s.cwd?.split(/[/\\]/).pop()}</span>}
          {s.agent && <AgentLink name={s.agent} />}
        </div>
        <h2 className="serif">{s.session_title ?? s.session_id?.slice(0, 24)}</h2>
      </div>

      {/* Meta grid */}
      <div className="meta-grid">
        <div><span className="eyebrow">Session ID</span><span className="mono">{s.session_id}</span></div>
        <div><span className="eyebrow">CWD</span><span className="mono">{s.cwd}</span></div>
        <div><span className="eyebrow">Branch · Commits</span><span className="mono">{s.git_branch ?? '—'} · {s.commits ?? 0}</span></div>
        <div><span className="eyebrow">Model</span><ModelPill model={s.model} /></div>
        <div><span className="eyebrow">Started</span><span>{fmt.date(s.start_ts)} {fmt.time(s.start_ts)}</span></div>
        <div><span className="eyebrow">Duration · Status</span><span>{fmt.duration(s.start_ts, s.end_ts)} · {s.status}</span></div>
      </div>

      <Rule />

      {/* KPI strip */}
      <div className="kpi-strip">
        <StatBlock label="Turns" value={fmt.n(s.turn_count)} />
        <StatBlock label="Output tokens" value={fmt.k(s.total_output_tokens)} />
        <StatBlock label="Cache 1h" value={fmt.k(s.ephemeral_1h_total)} />
        <StatBlock label="Cache 5m" value={fmt.k(s.ephemeral_5m_total)} />
        <StatBlock label="Cache hit" value={fmt.pct(s.total_input_tokens > 0 ? s.cache_read_total / s.total_input_tokens : null)} />
        <StatBlock label="$/turn" value={fmt.usd(s.turn_count > 0 ? s.total_cost / s.turn_count : null)} />
      </div>

      <Rule />

      {/* Per-turn chart */}
      <section>
        <Eyebrow>Per-turn tokens ({Math.min(turns?.length ?? 0, 60)} sampled)</Eyebrow>
        <TurnChart data={turns ?? []} />
      </section>

      <Rule />

      {/* Turn table */}
      <section>
        <Eyebrow>Turns (first 20)</Eyebrow>
        <table className="ledger-table">
          <thead><tr><th>#</th><th>Time</th><th>Model</th><th>Input</th><th>Output</th><th>Cost</th><th>Ctx%</th></tr></thead>
          <tbody>
            {(turns ?? []).slice(0, 20).map((t: any) => (
              <tr key={t.turn_number}>
                <td className="num muted">{t.turn_number}</td>
                <td className="mono muted">{fmt.time(t.assistant_ts)}</td>
                <td><ModelPill model={t.model} /></td>
                <td className="num">{fmt.k(t.input_tokens)}</td>
                <td className="num">{fmt.k(t.output_tokens)}</td>
                <td className="num accent">{fmt.usd(t.calculated_cost)}</td>
                <td className="num muted">{fmt.pct(t.context_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <Rule />

      {/* Errors */}
      {errors?.length > 0 && (
        <>
          <section>
            <Eyebrow>Errors ({errors.length})</Eyebrow>
            <table className="ledger-table">
              <thead><tr><th>Time</th><th>Severity</th><th>Kind</th><th>Tool</th><th>Message</th></tr></thead>
              <tbody>
                {errors.map((e: any, i: number) => (
                  <tr key={i}>
                    <td className="mono muted">{fmt.time(e.ts)}</td>
                    <td><SeverityTag severity={e.severity} /></td>
                    <td className="mono">{e.kind}</td>
                    <td className="mono muted">{e.tool ?? '—'}</td>
                    <td className="muted">{e.message?.slice(0, 80) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <Rule />
        </>
      )}

      {/* Git commands log */}
      {gitCommands?.length > 0 && (
        <>
          <section>
            <Eyebrow>Git commands ({gitCommands.length})</Eyebrow>
            <table className="ledger-table">
              <thead><tr><th>Time</th><th>Op</th><th>Command</th><th>Output</th><th>Status</th></tr></thead>
              <tbody>
                {gitCommands.map((g: any, i: number) => (
                  <tr key={i}>
                    <td className="mono muted">{fmt.time(g.ts)}</td>
                    <td className="mono">{g.git_op}</td>
                    <td className="mono">{g.raw_command?.slice(0, 60)}</td>
                    <td className="muted">{g.output_text?.slice(0, 80)}</td>
                    <td>{g.is_error ? '✗' : '✓'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <Rule />
        </>
      )}

      <div className="main-with-rail">
        <div className="main-col" />
        <SideRail>
          <SideSection title="Token breakdown">
            <StatBlock label="Input" value={fmt.k(s.total_input_tokens)} />
            <StatBlock label="Output" value={fmt.k(s.total_output_tokens)} />
            <StatBlock label="Cache read" value={fmt.k(s.cache_read_total)} />
            <StatBlock label="Cache 5m" value={fmt.k(s.ephemeral_5m_total)} />
            <StatBlock label="Cache 1h" value={fmt.k(s.ephemeral_1h_total)} />
          </SideSection>
          <SideSection title="Files touched">
            {(files ?? []).map((f: any) => (
              <BarRow key={f.file_path} label={f.file_path?.split(/[/\\]/).pop()} value={f.edit_count} max={maxEdits} fmt={fmt.n} />
            ))}
          </SideSection>
          <SideSection title="Tool mix">
            {(toolMix ?? []).map((t: any) => (
              <BarRow key={t.tool_name} label={t.tool_name} value={t.calls} max={maxToolCalls} fmt={fmt.n} />
            ))}
          </SideSection>
        </SideRail>
      </div>
    </div>
  )
}
