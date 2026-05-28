import { NextRequest, NextResponse } from 'next/server'
import { getSession, getSessionTurns, getSessionErrors, getSessionFiles, getSessionToolMix, getSessionGitCommands } from '../../../../lib/queries/sessions'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const [session, turns, errors, files, toolMix, gitCommands] = await Promise.all([
      getSession(params.id),
      getSessionTurns(params.id),
      getSessionErrors(params.id),
      getSessionFiles(params.id),
      getSessionToolMix(params.id),
      getSessionGitCommands(params.id)
    ])
    if (!session) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ session, turns, errors, files, toolMix, gitCommands })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
