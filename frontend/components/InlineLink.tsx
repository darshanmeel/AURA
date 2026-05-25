'use client'

import React from 'react'

interface InlineLinkProps {
  href: string
  children: React.ReactNode
  className?: string
  style?: React.CSSProperties
  stopPropagation?: boolean
}

export function InlineLink({ href, children, className = 'inline-link', style, stopPropagation = true }: InlineLinkProps) {
  return (
    <a
      href={href}
      className={className}
      style={style}
      onClick={stopPropagation ? (e => e.stopPropagation()) : undefined}
    >
      {children}
    </a>
  )
}
