'use client'

import React from 'react'
import { useRouter } from 'next/navigation'

interface ClickableRowProps {
  href: string
  children: React.ReactNode
  className?: string
}

export function ClickableRow({ href, children, className = '' }: ClickableRowProps) {
  const router = useRouter()
  return (
    <tr
      className={`clickable ${className}`}
      onClick={() => router.push(href)}
      style={{ cursor: 'pointer' }}
    >
      {children}
    </tr>
  )
}
