import { query, queryOne } from '../db'

export interface SessionFilters {
  provider?: string
  agent?: string
  status?: string
  sort?: string
  q?: string
}

export async function getSessions(filters: SessionFilters = {}) {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filters.provider) { conditions.push('provider = ?'); params.push(filters.provider) }
  if (filters.agent)    { conditions.push('agent = ?');    params.push(filters.agent) }
  if (filters.status)   { conditions.push('status = ?');   params.push(filters.status) }
  if (filters.q) {
    conditions.push("(session_title ILIKE ? OR session_id ILIKE ? OR cwd ILIKE ?)")
    params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const sortMap: Record<string, string> = {
    cost: 'total_cost DESC', turns: 'turn_count DESC',
    tokens: 'total_output_tokens DESC', started: 'start_ts DESC'
  }
  const orderBy = sortMap[filters.sort ?? ''] ?? 'start_ts DESC'

  return query(`
    SELECT session_id, start_ts, end_ts, model, cwd, git_branch, agent,
           person_id, person_name, session_title, status, provider,
           turn_count, total_cost, total_input_tokens, total_output_tokens,
           commits, tools_used, files_touched
    FROM dim_sessions
    ${where}
    ORDER BY ${orderBy}
    LIMIT 200
  `, params)
}

export async function getSession(id: string) {
  return queryOne(`
    SELECT * FROM dim_sessions WHERE session_id = ?
  `, [id])
}

export async function getSessionTurns(id: string) {
  return query(`
    SELECT turn_number, user_ts, assistant_ts, model,
           input_tokens, output_tokens, calculated_cost,
           cache_read_input_tokens, ephemeral_5m_input_tokens, ephemeral_1h_input_tokens,
           context_pct
    FROM fact_turns
    WHERE session_id = ?
    ORDER BY turn_number
    LIMIT 60
  `, [id])
}

export async function getSessionErrors(id: string) {
  return query(`
    SELECT ts, kind, tool, message, severity, turn_number
    FROM fact_errors
    WHERE session_id = ?
    ORDER BY ts
  `, [id])
}

export async function getSessionFiles(id: string) {
  return query(`
    SELECT file_path, file_ext, edit_count, write_count
    FROM fact_session_files
    WHERE session_id = ?
    ORDER BY edit_count DESC
  `, [id])
}

export async function getSessionToolMix(id: string) {
  return query(`
    SELECT tool_name, COUNT(*) AS calls, SUM(CASE WHEN is_error THEN 1 ELSE 0 END) AS errors
    FROM fact_tool_executions
    WHERE session_id = ?
    GROUP BY tool_name
    ORDER BY calls DESC
  `, [id])
}

export async function getSessionGitCommands(id: string) {
  return query(`
    SELECT ts, raw_command, output_text, git_op, is_error
    FROM fact_git_commands
    WHERE session_id = ?
    ORDER BY ts
  `, [id])
}
