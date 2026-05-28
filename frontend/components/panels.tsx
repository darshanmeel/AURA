import React from 'react'
import { Eyebrow, Rule } from './atoms'

export function ProfileBackRail({ href, label }: { href: string; label: string }) {
  return (
    <div className="back-rail">
      <a href={href} className="back-link muted">← {label}</a>
    </div>
  )
}

export function SideRail({ children }: { children: React.ReactNode }) {
  return <aside className="side-rail">{children}</aside>
}

export function SideSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="side-section">
      <Eyebrow>{title}</Eyebrow>
      <Rule />
      {children}
    </section>
  )
}
