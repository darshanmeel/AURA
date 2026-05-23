import { query } from '../db'

export async function getSessionFilesWithAttribution(sessionId: string) {
  return query(`
    SELECT file_path, file_ext, edit_count, write_count,
           tokens_attributed, duration_attributed_seconds, cost_attributed
    FROM fact_session_files
    WHERE session_id = ?
    ORDER BY tokens_attributed DESC NULLS LAST
  `, [sessionId])
}

export async function getTopFilesByCost(limit = 10) {
  return query(`
    SELECT file_path, file_ext,
           SUM(edit_count)                  AS edits,
           SUM(tokens_attributed)           AS tokens,
           SUM(cost_attributed)             AS cost,
           SUM(duration_attributed_seconds) AS duration_s,
           COUNT(DISTINCT session_id)       AS sessions
    FROM fact_session_files
    GROUP BY file_path, file_ext
    ORDER BY cost DESC NULLS LAST
    LIMIT ?
  `, [limit])
}
