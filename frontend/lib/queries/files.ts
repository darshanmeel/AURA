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
