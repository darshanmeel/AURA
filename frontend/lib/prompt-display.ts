/**
 * prompt-display.ts
 *
 * Pure utility for parsing raw Claude Code prompt strings into display tokens.
 *
 * Two sources of "dirty" input:
 *  1. JSON content-block arrays: '[{"type":"text","text":"..."}]'
 *     — produced when Claude Code stores a structured content array as the
 *       session_title / prompt_text field.
 *  2. Command-tag blocks: '<command-name>/foo</command-name> <command-message>...</command-message>
 *       <command-args>...</command-args> <local-command-stdout>...</local-command-stdout>'
 *     — produced when a slash-command invocation is logged as a human turn.
 *
 * Output: an array of DisplayToken that React can render without
 * dangerouslySetInnerHTML.
 */

export type DisplayToken =
  | { kind: 'text'; value: string }
  | { kind: 'slash'; name: string }

// ── Step 1: Unwrap JSON content-block arrays ─────────────────────────────────
function unwrapJsonBlocks(raw: string): string {
  const s = raw.trim()
  if (s.startsWith('[{') && s.includes('"type"')) {
    try {
      const blocks = JSON.parse(s)
      if (Array.isArray(blocks)) {
        const text = blocks
          .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
          .map((b: any) => b.text as string)
          .join(' ')
          .trim()
        if (text) return text
      }
    } catch {
      // fall through to original
    }
  }
  return s
}

// ── Step 2: Parse command-tag blocks into tokens ─────────────────────────────
// The full pattern, any subset of the four tags in any order, any whitespace
// between them. We capture all four optional tags and emit a 'slash' token.
const COMMAND_BLOCK_RE =
  /(?:<command-name>([^<]*)<\/command-name>|<command-message>[^<]*<\/command-message>|<command-args>[^<]*<\/command-args>|<local-command-stdout>[^<]*<\/local-command-stdout>|\s)*/g

// Simpler targeted regex: match an entire command-tag "block" (starts with
// <command-name> and includes any trailing sibling tags on the same stretch).
// We scan for ANY occurrence of the four known tags and consume the whole run.
const TAG_PATTERN =
  /(<command-name>[^<]*<\/command-name>|<command-message>[^<]*<\/command-message>|<command-args>[^<]*<\/command-args>|<local-command-stdout>[^<]*<\/local-command-stdout>|\s)+/g

function parseCommandTags(text: string): DisplayToken[] {
  const tokens: DisplayToken[] = []

  // We walk through the string looking for contiguous runs of command tags.
  // Each contiguous run becomes one 'slash' token; text outside is 'text'.
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Reset before use
  const re = new RegExp(
    '(' +
      '(?:' +
        '<command-name>[^<]*</command-name>' +
        '|<command-message>[^<]*</command-message>' +
        '|<command-args>[^<]*</command-args>' +
        '|<local-command-stdout>[^<]*</local-command-stdout>' +
        '|\\s' +
      ')+' +
    ')',
    'g'
  )

  // But we only want to treat it as a slash token if the run actually contains
  // a <command-name> tag. Otherwise it's just whitespace — skip as text.
  const fullRe = /(<command-name>([^<]*)<\/command-name>(?:\s*(?:<command-message>[^<]*<\/command-message>|<command-args>[^<]*<\/command-args>|<local-command-stdout>[^<]*<\/local-command-stdout>))*)/g

  while ((match = fullRe.exec(text)) !== null) {
    // Text before this match
    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index)
      if (before) tokens.push({ kind: 'text', value: before })
    }

    const commandName = match[2].trim() || '/command'
    tokens.push({ kind: 'slash', name: commandName })
    lastIndex = fullRe.lastIndex
  }

  // Trailing text
  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex)
    if (tail) tokens.push({ kind: 'text', value: tail })
  }

  return tokens.length > 0 ? tokens : [{ kind: 'text', value: text }]
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse a raw prompt string into display tokens.
 * Returns an empty array for null/undefined/empty input.
 */
export function parsePrompt(raw: string | null | undefined): DisplayToken[] {
  if (!raw) return []
  const unwrapped = unwrapJsonBlocks(raw)
  if (!unwrapped) return []
  return parseCommandTags(unwrapped)
}

/**
 * Convenience: collapse all tokens to a plain string (for title attributes,
 * search, or contexts that can't render React nodes).
 * Slash tokens become "/command-name" text.
 */
export function promptToPlain(raw: string | null | undefined, maxLen?: number): string {
  const tokens = parsePrompt(raw)
  const result = tokens
    .map(t => (t.kind === 'slash' ? t.name : t.value))
    .join('')
    .trim()
  if (maxLen != null && result.length > maxLen) return result.slice(0, maxLen) + '…'
  return result
}

/**
 * True if the raw string contains nothing but command-tag markup
 * (after unwrapping JSON blocks). Used to show the "slash command only"
 * muted label instead of empty quotes.
 */
export function isSlashCommandOnly(raw: string | null | undefined): boolean {
  const tokens = parsePrompt(raw)
  if (tokens.length === 0) return false
  return tokens.every(
    t => t.kind === 'slash' || (t.kind === 'text' && t.value.trim() === '')
  )
}
