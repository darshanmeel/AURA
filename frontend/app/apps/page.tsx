export const dynamic = 'force-dynamic'

import { Eyebrow, Rule, StatBlock } from '../../components/atoms'
import { fmt } from '../../lib/fmt'
import { getApps } from '../../lib/queries/apps'

export default async function AppsPage() {
  let apps: any[] = []
  try { apps = await getApps() as any[] } catch {}
  return (
    <div className="page-layout">
      <div className="page-header">
        <Eyebrow>Apps</Eyebrow>
        <h2 className="serif">All applications</h2>
        <p className="muted">{apps.length} apps by working directory</p>
      </div>
      <Rule />
      <div className="card-grid">
        {apps.map((app: any) => (
          <a key={app.app_id} href={`/apps/${encodeURIComponent(app.app_id)}`} className="card card--link">
            <div className="card-glyph mono">{app.app_name?.[0]?.toUpperCase() ?? '?'}</div>
            <div className="card-body">
              <div className="card-title">{app.app_name}</div>
              <div className="card-sub muted mono">{app.app_id}</div>
              <div className="card-stats">
                <span>{fmt.usd(app.total_cost)}</span>
                <span className="muted">{fmt.n(app.session_count)} sessions</span>
                <span className="muted">{fmt.n(app.total_turns)} turns</span>
              </div>
              <div className="card-agents muted">
                {(app.agents ?? []).slice(0, 3).join(' · ')}
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  )
}
