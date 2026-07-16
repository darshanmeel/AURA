/**
 * Shared SQL fragment helpers for the queries layer.
 *
 * Rules:
 *  - Import these; do NOT re-declare them locally.
 *  - tsFilter   → standalone WHERE clause (use when no prior WHERE exists)
 *  - andTsFilter → AND clause (use when a WHERE clause is already present)
 *  - Both return '' when `since` is null, so the caller's SQL is valid in
 *    either case.
 *  - assertTs   → validates a timestamp string before SQL interpolation.
 *    Throws on anything that is not a plain ISO date / timestamp so that
 *    injection is impossible even if a raw param ever reaches tsFilter or
 *    andTsFilter.
 */

/**
 * Accepts strings of the forms:
 *   YYYY-MM-DD
 *   YYYY-MM-DD HH:MM:SS
 *   YYYY-MM-DD HH:MM:SS.sss
 *   YYYY-MM-DDTHH:MM:SS          (T separator)
 *   YYYY-MM-DDTHH:MM:SS.sssZ     (UTC)
 *   YYYY-MM-DDTHH:MM:SS.sss±HH:MM  (offset)
 *
 * Rejects anything else (quotes, semicolons, comments, …).
 * Returns the original string unchanged so callers can use it as-is.
 */
export function assertTs(value: string): string {
  // Anchored pattern — must match the ENTIRE string.
  const ISO_TS =
    /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/

  if (!ISO_TS.test(value)) {
    throw new Error(
      `[assertTs] Rejected timestamp value that does not match ISO date/datetime: ${JSON.stringify(value)}`
    )
  }
  return value
}

export function tsFilter(col: string, since: string | null): string {
  if (!since) return ''
  return `WHERE ${col} >= '${assertTs(since)}'`
}

export function andTsFilter(col: string, since: string | null): string {
  if (!since) return ''
  return `AND ${col} >= '${assertTs(since)}'`
}
