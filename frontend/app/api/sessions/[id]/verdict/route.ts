import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const VALID_VERDICTS = new Set(['accepted', 'wrong', 'needs_review'])
const INBOX_PATH = process.env.AURA_VERDICTS_INBOX ?? '/data/verdicts-inbox.jsonl'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const sessionId = params.id
    if (!sessionId) {
      return NextResponse.json({ error: 'Missing session id' }, { status: 400 })
    }

    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'Body must be a JSON object' }, { status: 400 })
    }

    const { verdict, note } = body as Record<string, unknown>

    if (typeof verdict !== 'string' || !VALID_VERDICTS.has(verdict)) {
      return NextResponse.json(
        { error: `verdict must be one of: ${Array.from(VALID_VERDICTS).join(', ')}` },
        { status: 422 }
      )
    }

    const noteStr = typeof note === 'string' ? note.slice(0, 500) : null

    const line: Record<string, unknown> = {
      session_id: sessionId,
      tenant_id: 'local',
      verdict,
    }
    if (noteStr !== null) line.note = noteStr

    fs.mkdirSync(path.dirname(INBOX_PATH), { recursive: true })

    // Append one newline-terminated JSON line. POSIX O_APPEND is atomic for
    // single-line writes; no lock needed — Next.js is the only inbox writer.
    fs.appendFileSync(INBOX_PATH, JSON.stringify(line) + '\n', 'utf8')

    return NextResponse.json({ ok: true, session_id: sessionId, verdict })
  } catch (e) {
    console.error('[verdict] POST failed:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
