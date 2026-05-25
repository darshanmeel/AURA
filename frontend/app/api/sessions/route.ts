import { NextRequest, NextResponse } from 'next/server'
import { getSessions, getSessionsStats } from '../../../lib/queries/sessions'
import { parseRange, rangeSince } from '../../../lib/range'

export async function GET(req: NextRequest) {
  try {
    const { searchParams: p } = new URL(req.url)
    const filters = {
      provider: p.get('provider') ?? undefined,
      agent: p.get('agent') ?? undefined,
      status: p.get('status') ?? undefined,
      sort: p.get('sort') ?? undefined,
      q: p.get('q') ?? undefined,
    }
    const range = parseRange(p.get('range') ?? undefined)
    const since = rangeSince(range)
    const [sessions, stats] = await Promise.all([
      getSessions(filters, since),
      getSessionsStats(filters, since),
    ])
    return NextResponse.json({ sessions, stats })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
