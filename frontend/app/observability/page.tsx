// Server component: fetches initial snapshot for instant paint by calling the
// query function directly (no HTTP round-trip to self), then hands off to
// PipelineLive (client) for 10s polling against /api/observability.

export const dynamic = 'force-dynamic'

import React from 'react'
import { PipelineLive } from './PipelineLive'
import { getPipelineSnapshot } from '../../lib/queries/observability'
import './observability.css'

export default async function ObservabilityPage() {
  let initial: any = null
  try {
    initial = await getPipelineSnapshot()
  } catch {
    initial = null
  }
  return (
    <div className="page page-layout">
      <PipelineLive initialData={initial} />
    </div>
  )
}
