// Server component: fetches initial snapshot for instant paint, then hands off
// to PipelineLive (client) for 10s polling.

export const dynamic = 'force-dynamic'

import React from 'react'
import { PipelineLive } from './PipelineLive'
import './observability.css'

async function fetchInitial() {
  try {
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ??
      (process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:3000')
    const res = await fetch(`${baseUrl}/api/observability`, { cache: 'no-store' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export default async function ObservabilityPage() {
  const initial = await fetchInitial()
  return (
    <div className="page page-layout">
      <PipelineLive initialData={initial} />
    </div>
  )
}
