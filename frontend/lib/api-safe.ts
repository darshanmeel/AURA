/**
 * Per-query error isolation wrapper for API route handlers.
 *
 * A single missing mart or transient DuckDB error must not 500 the entire
 * endpoint. Wrap each query call with `safe(label, fn, fallback)`:
 *   - On success: returns the resolved value of `fn()`.
 *   - On failure: logs to `console.error` using the caller-supplied `label`
 *     and returns `fallback`.
 *
 * The label string is intentionally passed by the call site (e.g.
 * `[api/dashboard]` vs `[api/observability]`) so error log lines are
 * unambiguous across routes.
 */
export async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn() } catch (e) {
    console.error(`${label} failed:`, e instanceof Error ? e.message : e)
    return fallback
  }
}
