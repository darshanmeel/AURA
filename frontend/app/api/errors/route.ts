import { NextResponse } from 'next/server'
import { getErrors } from '../../../lib/queries/errors'

export async function GET() {
  try {
    return NextResponse.json({ errors: await getErrors() })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
