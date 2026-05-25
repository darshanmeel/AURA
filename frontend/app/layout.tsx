import type { Metadata } from 'next'
import './globals.css'
import { Colophon, Rule } from '@/components/atoms'

export const metadata: Metadata = {
  title: 'AURA — Spend, with receipts.',
  description: 'Local analytics for Claude Code agent transcripts',
}

const NAV_LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/apps', label: 'Apps' },
  { href: '/agents', label: 'Agents' },
  { href: '/people', label: 'People' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/errors', label: 'Errors' },
]

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const now = new Date()
  const dateStr = now.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase()
  
  return (
    <html lang="en">
      <body>
        <div className="masthead-wrap">
          <header className="masthead">
            <div className="masthead-row">
              <div className="brand" style={{ cursor: 'pointer' }}>
                <a href="/" style={{ textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'baseline' }}>
                  <span className="brand-mark">✦</span>
                  <span className="brand-name" style={{ marginLeft: '8px' }}>AURA</span>
                  <span className="brand-sub" style={{ marginLeft: '8px' }}><em>Agent Usage & Resource Analytics</em></span>
                </a>
              </div>
              <nav className="topnav">
                {NAV_LINKS.map(({ href, label }) => (
                  <a key={href} href={href} className="topnav-link">{label}</a>
                ))}
              </nav>
              <div className="masthead-meta">
                <span className="meta-key">VOL. I</span>
                <span className="meta-dot">·</span>
                <span className="meta-key">NO. 14</span>
                <span className="meta-dot">·</span>
                <span className="meta-key" suppressHydrationWarning>{dateStr}</span>
              </div>
            </div>
            <Rule weight="thick" />
          </header>
        </div>
        <main>{children}</main>
        <div className="footer-wrap" style={{ marginTop: '48px' }}>
          <Colophon />
        </div>
      </body>
    </html>
  )
}
