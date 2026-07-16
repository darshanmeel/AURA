import { NextResponse } from 'next/server'
import { getPeople } from '../../../lib/queries/people'

export async function GET() {
  try {
    return NextResponse.json({ people: await getPeople() })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
