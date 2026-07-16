'use client'

import { useState } from 'react'

const VERDICTS = [
  { value: 'accepted',     label: 'Accepted',     color: '#7fcf8e' },
  { value: 'wrong',        label: 'Wrong',        color: '#d97c5e' },
  { value: 'needs_review', label: 'Needs review', color: '#e8b85c' },
] as const

type VerdictValue = typeof VERDICTS[number]['value']

interface Props {
  sessionId: string
  initialVerdict: VerdictValue | null
  initialNote: string | null
}

export function VerdictSelector({ sessionId, initialVerdict, initialNote }: Props) {
  const [verdict, setVerdict] = useState<VerdictValue | null>(initialVerdict)
  const [note, setNote]       = useState<string>(initialNote ?? '')
  const [saving, setSaving]   = useState(false)
  const [saved, setSaved]     = useState(false)
  const [error, setError]     = useState<string | null>(null)

  async function submit(v: VerdictValue) {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const res = await fetch(`/api/sessions/${sessionId}/verdict`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict: v, note: note || undefined }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error((j as Record<string, string>).error ?? `HTTP ${res.status}`)
      }
      setVerdict(v)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span className="eyebrow" style={{ marginRight: 2, fontSize: 10 }}>Verdict</span>
      {VERDICTS.map(v => (
        <button
          key={v.value}
          disabled={saving}
          onClick={() => submit(v.value)}
          style={{
            padding: '2px 10px',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            border: `1px solid ${verdict === v.value ? v.color : 'var(--ink-3)'}`,
            borderRadius: 4,
            background: verdict === v.value ? v.color + '22' : 'transparent',
            color: verdict === v.value ? v.color : 'var(--ink-2)',
            cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.6 : 1,
            transition: 'all 0.15s',
          }}
        >
          {v.label}
        </button>
      ))}
      <input
        type="text"
        value={note}
        onChange={e => setNote(e.target.value)}
        maxLength={500}
        placeholder="Note (optional)"
        style={{
          fontSize: 11,
          fontFamily: 'var(--font-mono)',
          padding: '2px 8px',
          border: '1px solid var(--ink-3)',
          borderRadius: 4,
          background: 'transparent',
          color: 'var(--ink-1)',
          width: 160,
        }}
      />
      {saved && <span style={{ fontSize: 11, color: '#7fcf8e' }}>Saved</span>}
      {error && <span style={{ fontSize: 11, color: '#d97c5e' }}>{error}</span>}
    </div>
  )
}
