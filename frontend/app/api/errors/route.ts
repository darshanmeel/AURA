import { NextRequest, NextResponse } from 'next/server'
import { getErrors } from '../../../lib/queries/errors'
import { assertTs } from '../../../lib/queries/_helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get('since')
  let since: string | null = null
  if (raw) {
    try { since = assertTs(raw) } catch {
      return NextResponse.json({ error: 'Invalid since' }, { status: 400 })
    }
  }
  try {
    return NextResponse.json({ errors: await getErrors(since) })
  } catch (e) {
    console.error('[api/errors] GET failed:', e)
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }
}
