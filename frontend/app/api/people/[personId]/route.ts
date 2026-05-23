import { NextRequest, NextResponse } from 'next/server'
import { getPerson, getPersonSessions } from '../../../../lib/queries/people'

export async function GET(_req: NextRequest, { params }: { params: { personId: string } }) {
  try {
    const id = decodeURIComponent(params.personId)
    const [person, sessions] = await Promise.all([getPerson(id), getPersonSessions(id)])
    if (!person) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ person, sessions })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
