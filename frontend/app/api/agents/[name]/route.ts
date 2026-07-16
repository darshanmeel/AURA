import { NextRequest, NextResponse } from 'next/server'
import { getAgent, getAgentSessions, getAgentFiles } from '../../../../lib/queries/agents'

export async function GET(_req: NextRequest, { params }: { params: { name: string } }) {
  try {
    const name = decodeURIComponent(params.name)
    const [agent, sessions, files] = await Promise.all([getAgent(name), getAgentSessions(name), getAgentFiles(name)])
    if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ agent, sessions, files })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
