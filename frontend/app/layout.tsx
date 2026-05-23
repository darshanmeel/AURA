import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'AURA — Spend, with receipts.',
  description: 'Local analytics for Claude Code agent transcripts',
}

const NAV_LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/apps', label: 'Apps' },
  { href: '/people', label: 'People' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/errors', label: 'Errors' },
]

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav className="masthead">
          <div className="masthead-inner">
            <span className="masthead-logo serif">AURA</span>
            <ul className="masthead-nav">
              {NAV_LINKS.map(({ href, label }) => (
                <li key={href}>
                  <a href={href}>{label}</a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
        <main>{children}</main>
        <footer className="site-footer">
          <span className="muted eyebrow">AURA · local AI spend analytics</span>
        </footer>
      </body>
    </html>
  )
}
