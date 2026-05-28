import { NextRequest, NextResponse } from 'next/server'
import { getPipelineSnapshot } from '../../../lib/queries/observability'

// Force dynamic: at build time /data is not mounted, so the DB cannot be
// opened. Without this, Next.js statically prerenders the empty-fallback
// response and serves it forever. Every request must re-query the DB.
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(_request: NextRequest) {
  try {
    const snapshot = await getPipelineSnapshot()
    return NextResponse.json(snapshot, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
