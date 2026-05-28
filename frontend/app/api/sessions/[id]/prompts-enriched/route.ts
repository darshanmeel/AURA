import { NextRequest, NextResponse } from 'next/server'
import { getSessionPrompts as getSessionPromptsWithTools } from '../../../../../lib/queries/sessions'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  try {
    const rows = await getSessionPromptsWithTools(params.id)
    return NextResponse.json(
      { prompts: rows },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return NextResponse.json({ error: String(err), prompts: [] }, { status: 500 })
  }
}
