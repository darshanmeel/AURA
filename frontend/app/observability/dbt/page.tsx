// Server component: initial fetch at request time.
// Client subcomponent: polls every 30 s.
export const dynamic = 'force-dynamic'

import React, { Suspense } from 'react'
import { DbtPageClient } from './DbtPageClient'

export default function DbtPage() {
  return (
    <Suspense fallback={<div className="muted eyebrow" style={{ padding: '24px 0' }}>Loading…</div>}>
      <DbtPageClient />
    </Suspense>
  )
}
