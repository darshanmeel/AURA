export const dynamic = 'force-dynamic'

import { notFound } from 'next/navigation'
import { Rule, StatBlock, ModelPill, ProviderTag, AgentLink } from '../../../components/atoms'
import { ProfileBackRail } from '../../../components/panels'
import { SessionTabs } from '../../../components/SessionTabs'
import { fmt } from '../../../lib/fmt'
import {
  getSession, getSessionTurns, getSessionErrors,
  getSessionFiles, getSessionToolMix, getSessionGitCommands,
  getSessionToolExecutions
} from '../../../lib/queries/sessions'
import { getSessionPrompts } from '../../../lib/queries/prompts'
import { getSessionFilesWithAttribution } from '../../../lib/queries/files'

/**
 * Defensively unwrap a session_title that may contain raw JSON content-block arrays.
 * Pattern: '[{"type":"text","text":"..."}]'
 */
function unwrapTitle(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = raw.trim()
  if (s.startsWith('[{') && s.includes('"type"')) {
    try {
      const blocks = JSON.parse(s)
      if (Array.isArray(blocks)) {
        const text = blocks
          .filter((b: any) => b.type === 'text' && b.text)
          .map((b: any) => b.text as string)
          .join(' ')
          .trim()
        if (text) return text.length > 120 ? text.slice(0, 120) + '…' : text
      }
    } catch { /* fall through */ }
  }
  return s.length > 120 ? s.slice(0, 120) + '…' : s
}

export default async function SessionDetailPage({ params }: { params: { sessionId: string } }) {
  const id = params.sessionId
  let s: any = null, turns: any[] = [], errors: any[] = [], files: any[] = [], toolMix: any[] = [], gitCommands: any[] = [], toolExecutions: any[] = [], prompts: any[] = [], filesWithAttribution: any[] = []
  try {
    const [sess, t, e, f, tm, gc, te, pr, fa] = await Promise.all([
      getSession(id), getSessionTurns(id), getSessionErrors(id),
      getSessionFiles(id), getSessionToolMix(id), getSessionGitCommands(id),
      getSessionToolExecutions(id), getSessionPrompts(id),
      getSessionFilesWithAttribution(id)
    ])
    s = sess; turns = t as any[]; errors = e as any[]
    files = f as any[]; toolMix = tm as any[]; gitCommands = gc as any[]
    toolExecutions = te as any[]; prompts = pr as any[]
    filesWithAttribution = fa as any[]
  } catch {}
  if (!s) notFound()

  const cacheHitTot = (s.cache_read_total ?? 0) + (s.ephemeral_5m_total ?? 0) + (s.ephemeral_1h_total ?? 0)
  const cacheHitRate = cacheHitTot > 0 ? (s.cache_read_total ?? 0) / cacheHitTot : null

  const displayTitle = unwrapTitle(s.session_title ?? s.session_id)
  // Split title on · for italic second part, matching design pattern
  const [titlePart, ...restParts] = displayTitle.split('·')
  const titleMain = titlePart.trim()
  const titleSub = restParts.length > 0 ? ' · ' + restParts.join('·').trim() : ''

  return (
    <div className="page-layout">
      <ProfileBackRail href="/sessions" label="Sessions" />

      {/* SESSION HEAD — 2-col: left=title+meta, right=cost hero-stat (matches design session.jsx) */}
      <section className="session-head">
        <div className="session-head-left">
          {/* Eyebrow chips */}
          <div className="session-meta-chips">
            <ProviderTag provider={s.provider} />
            {s.person_name && <span className="muted">{s.person_name}</span>}
            {s.cwd && <span className="mono muted">{s.cwd?.split(/[/\\]/).pop()}</span>}
            {s.agent && <AgentLink name={s.agent} />}
            {s.git_branch && <span className="mono muted">{s.git_branch}</span>}
          </div>

          {/* Title — large serif, italic sub-part */}
          <h1 className="display display-sm" style={{ marginTop: 16, marginBottom: 0 }}>
            {titleMain}
            {titleSub && <em>{titleSub}</em>}
          </h1>

          {/* Meta grid — 3-col, 2 rows */}
          <div className="session-meta-grid">
            <div>
              <div className="meta-label">Session</div>
              <div className="meta-val mono">{s.session_id}</div>
            </div>
            <div>
              <div className="meta-label">Working dir</div>
              <div className="meta-val mono">{s.cwd ?? '—'}</div>
            </div>
            <div>
              <div className="meta-label">Branch · Commits</div>
              <div className="meta-val mono">
                {s.git_branch ?? '—'} · <span style={{ color: 'var(--accent)' }}>{s.commits ?? 0} commits</span>
              </div>
            </div>
            <div>
              <div className="meta-label">Model</div>
              <div className="meta-val"><ModelPill model={s.model} /></div>
            </div>
            <div>
              <div className="meta-label">Started</div>
              <div className="meta-val">{fmt.date(s.start_ts)}, {fmt.time(s.start_ts)}</div>
            </div>
            <div>
              <div className="meta-label">Duration · Status</div>
              <div className="meta-val">{fmt.duration(s.start_ts, s.end_ts)} · {s.status ?? '—'}</div>
            </div>
          </div>
        </div>

        {/* Right: SESSION COST hero-stat */}
        <div className="session-head-right">
          <div className="hero-stat hero-stat-detail">
            <div className="hero-stat-eyebrow">SESSION COST</div>
            <div className="hero-stat-value">{fmt.usd(s.total_cost)}</div>
            <div className="hero-stat-foot">
              <em>across</em>{' '}
              {fmt.k((s.total_input_tokens ?? 0) + (s.total_output_tokens ?? 0))} tokens ·{' '}
              {fmt.n(s.turn_count)} turns ·{' '}
              {fmt.n(s.files_touched ?? 0)} files
            </div>
          </div>
        </div>
      </section>

      <Rule weight="thick" />

      {/* KPI strip — 6 stats */}
      <section className="strip">
        <StatBlock label="Turns" value={fmt.n(s.turn_count)} footnote={`${fmt.n(s.tools_used ?? 0)} tool calls`} />
        <StatBlock label="Output tokens" value={fmt.k(s.total_output_tokens)} footnote={s.turn_count > 0 ? `avg ${Math.round((s.total_output_tokens ?? 0) / s.turn_count)} / turn` : undefined} />
        <StatBlock label="Cache 1h" value={fmt.k(s.ephemeral_1h_total)} footnote="paid 2.5× input" accent />
        <StatBlock label="Cache 5m" value={fmt.k(s.ephemeral_5m_total)} footnote="paid 1.25× input" />
        <StatBlock label="Cache hit" value={fmt.pct(cacheHitRate)} footnote="read / (read + write)" />
        <StatBlock label="$ / turn" value={fmt.usd(s.turn_count > 0 ? s.total_cost / s.turn_count : null)} footnote="amortized" />
      </section>

      <Rule weight="thick" />

      <SessionTabs
        s={s}
        turns={turns}
        errors={errors}
        toolExecutions={toolExecutions}
        gitCommands={gitCommands}
        files={files}
        toolMix={toolMix}
        prompts={prompts}
        filesWithAttribution={filesWithAttribution}
      />
    </div>
  )
}
