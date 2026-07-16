import { NextRequest, NextResponse } from 'next/server'
import { getApp, getAppSessions } from '../../../../lib/queries/apps'

export async function GET(_req: NextRequest, { params }: { params: { appId: string } }) {
  try {
    const appId = decodeURIComponent(params.appId)
    const [app, sessions] = await Promise.all([getApp(appId), getAppSessions(appId)])
    if (!app) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ app, sessions })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
