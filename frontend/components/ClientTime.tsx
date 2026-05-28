'use client'
import { useEffect, useState } from 'react'

type Mode = 'date' | 'time' | 'datetime'

// fmt.date / fmt.time use the runtime's local timezone, so the server (UTC
// container) and the client (user's TZ) format the same Date into different
// strings — React then reports the hydration mismatch as #418. Rendering
// times through this component lets the server emit a stable placeholder
// (`—`) and the client fill in the real local-formatted string after mount.
export function ClientTime({
  ts,
  mode = 'time',
  placeholder = '—',
}: { ts: string | Date | null | undefined; mode?: Mode; placeholder?: string }) {
  const [s, setS] = useState<string>(placeholder)
  useEffect(() => {
    if (!ts) return
    const d = new Date(ts)
    if (mode === 'date') {
      setS(d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))
    } else if (mode === 'datetime') {
      setS(
        d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
          ' ' +
          d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      )
    } else {
      setS(d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }))
    }
  }, [ts, mode])
  // The fragment shape (`<>{s}</>`) causes React to commit text into the
  // parent element. With Next's streamed Client Component boundaries the
  // SSR slot can be empty while the client renders the placeholder first
  // — Next reports that as #418. Wrap in a span with
  // suppressHydrationWarning so the swap from placeholder → formatted
  // time after mount is treated as expected, not a mismatch.
  return <span suppressHydrationWarning>{s}</span>
}
