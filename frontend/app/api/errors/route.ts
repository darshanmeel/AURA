import { NextRequest, NextResponse } from 'next/server'
import { getErrors } from '../../../lib/queries/errors'
import { parseRange, rangeSince } from '../../../lib/range'
import { getDataAsOf } from '../../../lib/asof'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const since = rangeSince(parseRange(new URL(req.url).searchParams.get('range') ?? undefined), await getDataAsOf())
    return NextResponse.json({ errors: await getErrors(since) })
  } catch (e) {
    console.error('[api/errors] GET failed:', e)
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }
}
