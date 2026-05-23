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
  const sev = (severity || 'info').toLowerCase()
  return <span className={`severity-tag severity-${sev}`}>{severity}</span>
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
        <div style={{ display: 'grid', gridTemplateColumns: 'auto auto auto', gap: '4px 24px', textAlign: 'left', opacity: 0.8 }}>
          <div className="strong" style={{ gridColumn: '1 / -1', color: 'var(--ink)' }}>Anthropic Pricing (per 1M tokens)</div>
          <div>Opus: <span className="mono">$15.00 in / $75.00 out</span></div>
          <div>Sonnet: <span className="mono">$3.00 in / $15.00 out</span></div>
          <div>Haiku: <span className="mono">$1.00 in / $5.00 out</span></div>

          <div className="strong" style={{ gridColumn: '1 / -1', marginTop: 12, color: 'var(--ink)' }}>Google Pricing (per 1M tokens)</div>
          <div>Gemini 1.5 Pro: <span className="mono">$1.25 in / $10.00 out</span></div>
          <div>Gemini 1.5 Flash: <span className="mono">$0.30 in / $2.50 out</span></div>
          <div />

          <div className="strong" style={{ gridColumn: '1 / -1', marginTop: 12, color: 'var(--ink)' }}>Cache Multipliers</div>
          <div>Write: <span className="mono">1.25× input</span></div>
          <div>Read: <span className="mono">0.10× input</span></div>
          <div>1-Hour: <span className="mono">2× 5-min cost</span></div>
        </div>
      </div>
    </footer>
  )
}
