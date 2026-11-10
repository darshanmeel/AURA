import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const VALID_VERDICTS = new Set(['accepted', 'wrong', 'needs_review'])
const INBOX_PATH = process.env.AURA_VERDICTS_INBOX
  ?? `${process.env.AURA_DATA_DIR ?? '/data'}/inbox/verdicts-inbox.jsonl`

// On Windows dbt may hold the inbox open while it reads it; retry briefly.
async function appendWithRetry(file: string, text: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.appendFileSync(file, text, 'utf8')
      return
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 3 || (code !== 'EBUSY' && code !== 'EPERM')) throw e
      await new Promise(r => setTimeout(r, 100))
    }
  }
}

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

    const line = {
      tenant_id: 'local',
      session_id: sessionId,
      verdict,
      note: typeof note === 'string' ? note.slice(0, 500) : null,
      created_at: new Date().toISOString(),
    }

    fs.mkdirSync(path.dirname(INBOX_PATH), { recursive: true })

    // Append one newline-terminated JSON line. O_APPEND is atomic for
    // single-line writes; no lock needed — Next.js is the only inbox writer.
    await appendWithRetry(INBOX_PATH, JSON.stringify(line) + '\n')

    return NextResponse.json({ ok: true, session_id: sessionId, verdict })
  } catch (e) {
    console.error('[verdict] POST failed:', e)
    return NextResponse.json({ error: 'Could not record verdict' }, { status: 500 })
  }
}
