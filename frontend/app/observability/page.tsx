// Server component: fetches initial data, hands off to LiveOverview (client) for polling.
// This file must NOT import server-only modules — the only server-only call here is the
// fetch to our own API route on the same host. The client component polls that same route.

export const dynamic = 'force-dynamic'

import React from 'react'
import { Eyebrow, Rule } from '../../components/atoms'
import { LiveOverview } from './LiveOverview'

// Initial data fetch: runs once on the server, seeded into LiveOverview for instant paint.
async function fetchInitial() {
  try {
    // Use absolute URL for server-side fetch inside Next.js
    const baseUrl =
      process.env.NEXT_PUBLIC_APP_URL ??
      (process.env.PORT ? `http://localhost:${process.env.PORT}` : 'http://localhost:3000')
    const res = await fetch(`${baseUrl}/api/observability?view=overview`, {
      cache: 'no-store',
    })
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
      {/* Masthead strap */}
      <section className="masthead-strap">
        <Eyebrow>Observability · pipeline health</Eyebrow>
        <div className="strap-right">
          <span className="strap-pill">
            <a href="/observability" className="obs-tab obs-tab-active">Overview</a>
          </span>
          <span className="strap-pill is-muted">
            <a href="/observability/watcher" className="obs-tab">Watcher</a>
          </span>
          <span className="strap-pill is-muted">
            <a href="/observability/dbt" className="obs-tab">dbt</a>
          </span>
        </div>
      </section>

      <Rule weight="thick" />

      {/* Page header */}
      <section className="page-head" style={{ padding: '32px 0 24px' }}>
        <h1 className="display display-sm">
          Pipeline <em>health.</em>
        </h1>
        <p className="hero-lede" style={{ fontSize: 16, margin: 0 }}>
          Real-time view of ingestion freshness, dbt run status, and error rates.
          Auto-refreshes every 10 seconds.
        </p>
      </section>

      <Rule />

      {/* Client component handles all live state */}
      <LiveOverview initialData={initial} />
    </div>
  )
}
