import { NextResponse } from 'next/server'
import { getApps } from '../../../lib/queries/apps'

export async function GET() {
  try {
    const apps = await getApps()
    return NextResponse.json({ apps })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
