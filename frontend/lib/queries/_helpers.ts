/**
 * Shared SQL fragment helpers for the queries layer.
 *
 * Rules:
 *  - Import these; do NOT re-declare them locally.
 *  - tsFilter   → standalone WHERE clause (use when no prior WHERE exists)
 *  - andTsFilter → AND clause (use when a WHERE clause is already present)
 *  - Both return '' when `since` is null, so the caller's SQL is valid in
 *    either case.
 */

export function tsFilter(col: string, since: string | null): string {
  if (!since) return ''
  return `WHERE ${col} >= '${since}'`
}

export function andTsFilter(col: string, since: string | null): string {
  if (!since) return ''
  return `AND ${col} >= '${since}'`
}
