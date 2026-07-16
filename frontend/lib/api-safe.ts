/**
 * Per-query error isolation wrapper for API route handlers.
 *
 * A single missing mart or transient DuckDB error must not 500 the entire
 * endpoint. Wrap each query call with `safe(label, fn, fallback)`:
 *   - On success: returns the resolved value of `fn()`.
 *   - On failure: logs a structured, greppable error with the marker
 *     `[aura:safe]` then returns `fallback` so the page still renders.
 *
 * The label string is intentionally passed by the call site (e.g.
 * `[api/dashboard] kpis` vs `[api/observability] topFiles`) so error log
 * lines are unambiguous across routes. The structured object form lets an
 * operator grep for `[aura:safe]` to find ALL query failures in server logs,
 * as opposed to a successful query that returned empty data — those two states
 * are now structurally distinguishable.
 */
export async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    // [aura:safe] is the canonical grep marker for query failures in server logs.
    // A genuine DB/mart failure MUST produce this line; a legitimately empty
    // result produces no log at all. Do not change the marker string.
    console.error('[aura:safe] query failed', {
      label,
      error: err.message,
      stack: err.stack,
    })
    return fallback
  }
}
