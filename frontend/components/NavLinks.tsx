'use client'

import { usePathname } from 'next/navigation'

const NAV_LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/apps', label: 'Apps' },
  { href: '/agents', label: 'Agents' },
  { href: '/people', label: 'People' },
  { href: '/sessions', label: 'Sessions' },
  { href: '/errors', label: 'Errors' },
  { href: '/observability', label: 'Observability' },
]

export default function NavLinks() {
  const pathname = usePathname()

  return (
    <nav className="topnav">
      {NAV_LINKS.map(({ href, label }) => {
        const isActive =
          href === '/observability'
            ? pathname.startsWith('/observability')
            : pathname === href
        return (
          <a
            key={href}
            href={href}
            className={`topnav-link${isActive ? ' is-active' : ''}`}
          >
            {label}
          </a>
        )
      })}
    </nav>
  )
}
