/**
 * PromptText.tsx
 *
 * Renders a raw Claude Code prompt string as clean React nodes.
 * Slash-command tag blocks become inline "⌘ /command" chips.
 * JSON content-block arrays are unwrapped to their text.
 * Never uses dangerouslySetInnerHTML.
 *
 * Usage:
 *   <PromptText text={p.prompt_text_200} maxLen={200} />
 *   <PromptText text={p.prompt_text_200} block />   ← preserves whitespace (pre-wrap)
 */

import React from 'react'
import { parsePrompt, isSlashCommandOnly, DisplayToken } from '../lib/prompt-display'

function SlashChip({ name }: { name: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: '1px 6px',
        border: '1px solid var(--rule)',
        borderRadius: 3,
        fontSize: '0.85em',
        color: 'var(--ink-2)',
        fontFamily: 'var(--mono)',
        lineHeight: 1.5,
        background: 'rgba(255,255,255,0.03)',
        verticalAlign: 'middle',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ opacity: 0.7, marginRight: 2 }}>⌘</span>
      {name}
    </span>
  )
}

interface PromptTextProps {
  /** Raw prompt string from the database (may contain command tags or JSON blocks). */
  text: string | null | undefined
  /** Maximum character count before truncation (applied to plain-text portions). */
  maxLen?: number
  /** If true, render in a block that preserves whitespace (pre-wrap). Default false. */
  block?: boolean
  /** Extra class applied to the outer element. */
  className?: string
  /** Extra inline style. */
  style?: React.CSSProperties
}

export function PromptText({ text, maxLen, block = false, className, style }: PromptTextProps) {
  if (!text) return null

  const tokens = parsePrompt(text)

  // Nothing at all after parsing
  if (tokens.length === 0) return null

  // All slash, no real user content
  if (isSlashCommandOnly(text)) {
    const slashTokens = tokens.filter(t => t.kind === 'slash') as Extract<DisplayToken, { kind: 'slash' }>[]
    return (
      <span className={className} style={style}>
        {slashTokens.map((t, i) => (
          <React.Fragment key={i}>
            {i > 0 && ' '}
            <SlashChip name={t.name} />
          </React.Fragment>
        ))}
        <span style={{ color: 'var(--muted)', fontStyle: 'italic', marginLeft: 4 }}>
          slash command only
        </span>
      </span>
    )
  }

  // Mixed content — track remaining budget across text tokens
  let remaining = maxLen ?? Infinity
  const nodes: React.ReactNode[] = []

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.kind === 'slash') {
      nodes.push(<SlashChip key={i} name={t.name} />)
    } else {
      // text token — apply budget
      if (remaining <= 0) break
      const value = t.value.length > remaining
        ? t.value.slice(0, remaining) + '…'
        : t.value
      remaining -= t.value.length
      if (value) nodes.push(<React.Fragment key={i}>{value}</React.Fragment>)
    }
  }

  const Tag = block ? 'p' : 'span'
  return (
    <Tag
      className={className}
      style={{
        whiteSpace: block ? 'pre-wrap' : undefined,
        wordBreak: 'break-word',
        ...style,
      }}
    >
      {nodes}
    </Tag>
  )
}
