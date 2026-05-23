import React from 'react'

export function Eyebrow({ children, dot = true }: { children: React.ReactNode; dot?: boolean }) {
  return (
    <div className="eyebrow">
      {dot && <span className="eyebrow-dot" />}
      {children}
    </div>
  )
}

export function Rule({ weight = 'hair' }: { weight?: 'hair' | 'thick' }) {
  return <div className={`rule rule-${weight}`} />
}

export function StatBlock({ label, value, footnote, large = false, accent = false }: { label: string; value: React.ReactNode; footnote?: string; large?: boolean; accent?: boolean }) {
  return (
    <div className={`stat ${large ? 'stat-l' : ''} ${accent ? 'stat-accent' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {footnote && <div className="stat-foot">{footnote}</div>}
    </div>
  )
}

export function ModelPill({ model }: { model: string }) {
  const short = (model || "").replace("claude-", "").replace("gemini-", "g·").replace('-20', ' \'').slice(0, 20)
  const cls = model && model.includes("opus") ? "pill pill-opus"
            : model && model.includes("sonnet") ? "pill pill-sonnet"
            : model && model.includes("gemini-2.5-pro") ? "pill pill-gpro"
            : model && model.includes("gemini") ? "pill pill-gflash"
            : "pill pill-haiku"
  return <span className={cls}>{short}</span>
}

export function AgentLink({ name }: { name: string }) {
  return <a href={`/agents/${encodeURIComponent(name)}`} className="agent-link mono">{name}</a>
}

export function AppLink({ appId, appName }: { appId: string; appName: string }) {
  return <a href={`/apps/${encodeURIComponent(appId)}`} className="app-link">{appName}</a>
}

export function PersonLink({ personId, personName, mini = false }: { personId: string; personName: string; mini?: boolean }) {
  return (
    <a href={`/people/${encodeURIComponent(personId)}`} className={`person-link ${mini ? 'person-link-mini' : ''}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', textDecoration: 'none' }}>
      <Avatar name={personName ?? personId} />
      <span className="person-name">{personName || personId}</span>
    </a>
  )
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
        <div className="bar-fill" style={{ width: `${Math.min(pct, 100)}%`, background: 'var(--ink-2)' }} />
      </div>
      <span className="bar-value">{fmt(value)}</span>
    </div>
  )
}

export function Avatar({ name, id }: { name: string; id?: string }) {
  const initials = (name || id || "?").split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  return (
    <span className="avatar" style={{ 
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: '24px', height: '24px', borderRadius: '4px',
      background: 'var(--rule)', color: 'var(--ink)', fontSize: '11px', fontWeight: 600, fontFamily: 'var(--sans)'
    }}>
      {initials}
    </span>
  )
}

export function SessionLink({ id, title }: { id: string; title?: string }) {
  return (
    <a href={`/sessions/${id}`} className="session-link">
      {title ?? id.slice(0, 8)}
    </a>
  )
}

export function TBar({ pct }: { pct: number }) {
  return (
    <div className="tbar">
      <div className="tbar-fill" style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
    </div>
  )
}

export function StackBar({ segments }: { segments: { pct: number; cls: string; title?: string }[] }) {
  return (
    <div className="stack-bar">
      {segments.map((seg, i) => (
        <div key={i} className={`stack-seg ${seg.cls}`} style={{ width: `${Math.max(seg.pct, 0)}%` }} title={seg.title} />
      ))}
    </div>
  )
}

export function StatusDot({ status, label }: { status: 'active' | 'completed'; label?: string }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {label || (status === 'active' ? 'pipeline live' : 'pipeline idle')}
    </span>
  )
}

export function Colophon() {
  return (
    <footer className="colophon">
      <div>
        <div className="brand">
          <span className="brand-mark">✦</span>
          <span className="brand-name">AURA</span>
        </div>
        <div className="muted tiny" style={{ marginTop: 8, maxWidth: '280px', lineHeight: 1.5 }}>
          A local, Dockerized analytics pipeline for AI agent sessions —
          Claude Code, Gemini, and friends.
        </div>
      </div>
      <div className="colophon-meta">
        <span>Anthropic: Opus $15/$75 · Sonnet $3/$15 · Haiku $1/$5 (per 1M in/out)</span>
        <span>Google: Gemini 2.5 Pro $1.25/$10 · Flash $0.30/$2.50 (per 1M)</span>
        <span>Cache: write 1.25× input · read 0.10× input · 1h cache 2× of 5m</span>
      </div>
    </footer>
  )
}
