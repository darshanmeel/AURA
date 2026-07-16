import type { Metadata } from 'next'
import './globals.css'
import { Colophon, Rule } from '@/components/atoms'
import NavLinks from '@/components/NavLinks'

export const metadata: Metadata = {
  title: 'AURA — Spend, with receipts.',
  description: 'Local analytics for Claude Code agent transcripts',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const now = new Date()
  const dateStr = now.toLocaleDateString("en-GB", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase()
  
  return (
    <html lang="en">
      <body>
        <div className="masthead-wrap">
          <header className="masthead">
            <div className="masthead-row">
              <div className="brand" style={{ cursor: 'pointer' }}>
                <a href="/" style={{ textDecoration: 'none', color: 'inherit', display: 'flex', alignItems: 'baseline' }}>
                  <span className="brand-mark" style={{ display: 'inline-flex', alignSelf: 'center' }} aria-label="Crosshire">
                    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">
                      <rect width="32" height="32" rx="7" fill="#191b26" />
                      <g fill="none" stroke="#e4a93a" strokeWidth="1.9" strokeLinecap="round">
                        <circle cx="16" cy="16" r="7" />
                        <path d="M16 3v6M16 23v6M3 16h6M23 16h6" />
                      </g>
                      <circle cx="16" cy="16" r="1.7" fill="#e4a93a" />
                    </svg>
                  </span>
                  <span className="brand-name" style={{ marginLeft: '8px' }}>AURA</span>
                  <span className="brand-sub" style={{ marginLeft: '8px' }}><em>Agent Usage & Resource Analytics</em></span>
                </a>
              </div>
              <NavLinks />
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
