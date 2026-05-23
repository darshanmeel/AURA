import { NextRequest, NextResponse } from 'next/server'
import { getSessions } from '../../../lib/queries/sessions'

export async function GET(req: NextRequest) {
  try {
    const { searchParams: p } = new URL(req.url)
    const sessions = await getSessions({
      provider: p.get('provider') ?? undefined,
      agent: p.get('agent') ?? undefined,
      status: p.get('status') ?? undefined,
      sort: p.get('sort') ?? undefined,
      q: p.get('q') ?? undefined,
    })
    return NextResponse.json({ sessions })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
