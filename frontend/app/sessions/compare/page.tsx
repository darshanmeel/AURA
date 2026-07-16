export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getSession } from '../../../lib/queries/sessions'
import { fmt } from '../../../lib/fmt'
import { ModelPill, StatusPill, Rule } from '../../../components/atoms'
import { promptToPlain } from '../../../lib/prompt-display'

function delta(a: number | null | undefined, b: number | null | undefined): string {
  const na = Number(a ?? 0)
  const nb = Number(b ?? 0)
  if (na === 0 && nb === 0) return ''
  const d = na - nb
  const pct = nb !== 0 ? (d / nb) * 100 : null
  const sign = d > 0 ? '+' : ''
  if (pct != null) return `${sign}${pct.toFixed(1)}%`
  return d > 0 ? `+∞` : d < 0 ? `-∞` : ''
}

function winner(a: number | null | undefined, b: number | null | undefined, lowerIsBetter = true): 'a' | 'b' | null {
  const na = Number(a ?? 0)
  const nb = Number(b ?? 0)
  if (na === nb) return null
  return lowerIsBetter ? (na < nb ? 'a' : 'b') : (na > nb ? 'a' : 'b')
}

interface RowProps {
  label: string
  va: string
  vb: string
  win?: 'a' | 'b' | null
  hint?: string
}
function CompareRow({ label, va, vb, win, hint }: RowProps) {
  const aStyle = win === 'a' ? { color: '#7fcf8e', fontWeight: 700 } : {}
  const bStyle = win === 'b' ? { color: '#7fcf8e', fontWeight: 700 } : {}
  return (
    <tr>
      <td className="meta-label" style={{ paddingRight: 16, whiteSpace: 'nowrap' }}>
        {label}{hint && <span className="muted" style={{ fontSize: 10, marginLeft: 4 }}>{hint}</span>}
      </td>
      <td className="num" style={aStyle}>{va}</td>
      <td className="num" style={bStyle}>{vb}</td>
    </tr>
  )
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams?: { a?: string; b?: string }
}) {
  const idA = searchParams?.a?.trim() ?? ''
  const idB = searchParams?.b?.trim() ?? ''

  if (!idA || !idB || idA === idB) {
    redirect('/sessions')
  }

  const [a, b] = await Promise.all([getSession(idA), getSession(idB)]) as [any, any]

  if (!a || !b) {
    redirect('/sessions')
  }

  const titleA = promptToPlain(a.session_title ?? a.session_id, 80)
  const titleB = promptToPlain(b.session_title ?? b.session_id, 80)

  const costWin     = winner(a.total_cost, b.total_cost, true)
  const turnsWin    = winner(a.turn_count, b.turn_count, true)
  const tokensWin   = winner(
    Number(a.total_input_tokens ?? 0) + Number(a.total_output_tokens ?? 0),
    Number(b.total_input_tokens ?? 0) + Number(b.total_output_tokens ?? 0),
    true
  )
  const cacheWin    = winner(a.cache_read_total, b.cache_read_total, false)
  const filesWin    = winner(a.files_touched, b.files_touched, false)
  const commitsWin  = winner(a.commits, b.commits, false)
  const toolsWin    = winner(a.tools_used, b.tools_used, false)

  const cacheRateA = (() => {
    const read = Number(a.cache_read_total ?? 0)
    const total = read + Number(a.ephemeral_5m_total ?? 0) + Number(a.ephemeral_1h_total ?? 0)
    return total > 0 ? read / total : null
  })()
  const cacheRateB = (() => {
    const read = Number(b.cache_read_total ?? 0)
    const total = read + Number(b.ephemeral_5m_total ?? 0) + Number(b.ephemeral_1h_total ?? 0)
    return total > 0 ? read / total : null
  })()
  const cacheRateWin = winner(cacheRateA, cacheRateB, false)

  return (
    <div className="page-layout">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <Link href="/sessions" className="back-link" style={{ fontSize: 12, color: 'var(--ink-2)' }}>
          ← Sessions
        </Link>
        <span className="eyebrow">Compare sessions</span>
      </div>

      {/* Column headers */}
      <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr 1fr', gap: 16, marginBottom: 8 }}>
        <div />
        <div>
          <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>Session A</div>
          <div className="sess-title">
            <a href={`/sessions/${a.session_id}`}>{titleA || a.session_id.slice(0, 12)}</a>
          </div>
          <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
            {a.session_id.slice(0, 12)}
          </div>
        </div>
        <div>
          <div className="eyebrow" style={{ fontSize: 10, marginBottom: 4 }}>Session B</div>
          <div className="sess-title">
            <a href={`/sessions/${b.session_id}`}>{titleB || b.session_id.slice(0, 12)}</a>
          </div>
          <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>
            {b.session_id.slice(0, 12)}
          </div>
        </div>
      </div>

      <Rule weight="thick" />

      {/* Compare table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <colgroup>
          <col style={{ width: 160 }} />
          <col />
          <col />
        </colgroup>
        <tbody>
          <CompareRow label="Model"  va={a.model ?? '—'} vb={b.model ?? '—'} />
          <CompareRow label="Status" va={a.session_status ?? '—'} vb={b.session_status ?? '—'} />
          <CompareRow label="Started" va={`${fmt.date(a.start_ts)} ${fmt.time(a.start_ts)}`} vb={`${fmt.date(b.start_ts)} ${fmt.time(b.start_ts)}`} />
          <CompareRow
            label="Duration"
            va={fmt.duration(a.start_ts, a.end_ts)}
            vb={fmt.duration(b.start_ts, b.end_ts)}
          />
          <tr><td colSpan={3}><hr style={{ borderColor: 'var(--rule)', margin: '8px 0' }} /></td></tr>

          <CompareRow
            label="Total cost"
            va={fmt.usd(a.total_cost)}
            vb={`${fmt.usd(b.total_cost)} ${delta(b.total_cost, a.total_cost)}`}
            win={costWin}
            hint="lower wins"
          />
          <CompareRow
            label="Turns"
            va={fmt.n(a.turn_count)}
            vb={`${fmt.n(b.turn_count)} ${delta(b.turn_count, a.turn_count)}`}
            win={turnsWin}
            hint="lower wins"
          />
          <CompareRow
            label="Tools used"
            va={fmt.n(a.tools_used ?? 0)}
            vb={`${fmt.n(b.tools_used ?? 0)} ${delta(b.tools_used, a.tools_used)}`}
            win={toolsWin}
            hint="higher wins"
          />
          <tr><td colSpan={3}><hr style={{ borderColor: 'var(--rule)', margin: '8px 0' }} /></td></tr>

          <CompareRow
            label="Input tokens"
            va={fmt.k(a.total_input_tokens ?? 0)}
            vb={`${fmt.k(b.total_input_tokens ?? 0)} ${delta(b.total_input_tokens, a.total_input_tokens)}`}
          />
          <CompareRow
            label="Output tokens"
            va={fmt.k(a.total_output_tokens ?? 0)}
            vb={`${fmt.k(b.total_output_tokens ?? 0)} ${delta(b.total_output_tokens, a.total_output_tokens)}`}
            win={tokensWin}
          />
          <CompareRow
            label="Cache read"
            va={fmt.k(a.cache_read_total ?? 0)}
            vb={`${fmt.k(b.cache_read_total ?? 0)} ${delta(b.cache_read_total, a.cache_read_total)}`}
            win={cacheWin}
            hint="higher wins"
          />
          <CompareRow
            label="Cache hit rate"
            va={fmt.pct(cacheRateA)}
            vb={fmt.pct(cacheRateB)}
            win={cacheRateWin}
            hint="higher wins"
          />
          <tr><td colSpan={3}><hr style={{ borderColor: 'var(--rule)', margin: '8px 0' }} /></td></tr>

          <CompareRow
            label="Files touched"
            va={fmt.n(a.files_touched ?? 0)}
            vb={`${fmt.n(b.files_touched ?? 0)} ${delta(b.files_touched, a.files_touched)}`}
            win={filesWin}
            hint="higher wins"
          />
          <CompareRow
            label="Commits"
            va={fmt.n(a.commits ?? 0)}
            vb={`${fmt.n(b.commits ?? 0)} ${delta(b.commits, a.commits)}`}
            win={commitsWin}
            hint="higher wins"
          />
          <CompareRow
            label="$ / turn"
            va={fmt.usd(a.turn_count > 0 ? Number(a.total_cost) / Number(a.turn_count) : null)}
            vb={fmt.usd(b.turn_count > 0 ? Number(b.total_cost) / Number(b.turn_count) : null)}
            win={winner(
              a.turn_count > 0 ? Number(a.total_cost) / Number(a.turn_count) : null,
              b.turn_count > 0 ? Number(b.total_cost) / Number(b.turn_count) : null,
              true
            )}
            hint="lower wins"
          />
          {(a.max_turns != null || b.max_turns != null) && (
            <CompareRow
              label="Budget used"
              va={fmt.pct(a.budget_utilization)}
              vb={fmt.pct(b.budget_utilization)}
              win={winner(a.budget_utilization, b.budget_utilization, true)}
              hint="lower wins"
            />
          )}
          {(a.verdict || b.verdict) && (
            <CompareRow
              label="Verdict"
              va={a.verdict ?? '—'}
              vb={b.verdict ?? '—'}
            />
          )}
        </tbody>
      </table>

      <div style={{ marginTop: 24 }}><Rule /></div>
      <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
        <a href={`/sessions/${a.session_id}`} className="btn-outline" style={{ fontSize: 12, padding: '4px 12px' }}>
          Open session A →
        </a>
        <a href={`/sessions/${b.session_id}`} className="btn-outline" style={{ fontSize: 12, padding: '4px 12px' }}>
          Open session B →
        </a>
      </div>
    </div>
  )
}
