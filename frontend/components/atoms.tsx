import React from 'react'

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <span className="eyebrow">{children}</span>
}

export function Rule() {
  return <hr className="rule" />
}

export function StatBlock({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="stat-block">
      <div className="stat-label eyebrow">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub muted">{sub}</div>}
    </div>
  )
}

export function ModelPill({ model }: { model: string }) {
  const short = model.replace('claude-', '').replace('-20', ' \'').slice(0, 20)
  return <span className="model-pill mono">{short}</span>
}

export function AgentLink({ name }: { name: string }) {
  return <a href={`/agents/${encodeURIComponent(name)}`} className="agent-link mono">{name}</a>
}

export function AppLink({ appId, appName }: { appId: string; appName: string }) {
  return <a href={`/apps/${encodeURIComponent(appId)}`} className="app-link">{appName}</a>
}

export function PersonLink({ personId, personName }: { personId: string; personName: string }) {
  return <a href={`/people/${encodeURIComponent(personId)}`} className="person-link">{personName}</a>
}

export function ProviderTag({ provider }: { provider: string }) {
  return <span className={`provider-tag provider-${provider?.toLowerCase()}`}>{provider}</span>
}

export function SeverityTag({ severity }: { severity: string }) {
  return <span className={`severity-tag severity-${severity}`}>{severity}</span>
}

export function BarRow({ label, value, max, fmt }: { label: string; value: number; max: number; fmt: (v: number) => string }) {
  const pct = max > 0 ? (value / max) * 100 : 0
  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <div className="bar-track">
        <div className="bar-fill" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <span className="bar-value">{fmt(value)}</span>
    </div>
  )
}

export function Avatar({ name, id }: { name: string; id?: string }) {
  const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  return <span className="avatar">{initials}</span>
}

export function SessionLink({ id, title }: { id: string; title?: string }) {
  return (
    <a href={`/sessions/${id}`} className="session-link">
      {title ?? id.slice(0, 8)}
    </a>
  )
}
