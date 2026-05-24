import { query, queryOne } from '../db'

const SESSIONS_PAGE_SIZE = 50
const SESSIONS_STATS_CAP = 200
// SESSIONS_PAGE_SIZE is reserved for future paginated endpoints

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

  if (filters.provider) { conditions.push('ds.provider = ?'); params.push(filters.provider) }
  if (filters.agent)    { conditions.push('ds.agent = ?');    params.push(filters.agent) }
  if (filters.status)   { conditions.push('ds.status = ?');   params.push(filters.status) }
  if (filters.q) {
    conditions.push("(ds.session_title ILIKE ? OR ds.session_id ILIKE ? OR ds.cwd ILIKE ?)")
    params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const sortMap: Record<string, string> = {
    cost: 'total_cost DESC', turns: 'turn_count DESC',
    tokens: 'total_output_tokens DESC', started: 'start_ts DESC'
  }
  const orderBy = sortMap[filters.sort ?? ''] ?? 'start_ts DESC'

  return query(`
    SELECT ds.session_id, ds.start_ts, ds.end_ts, ds.model, ds.cwd, ds.git_branch,
           ds.agent, ds.agents, ds.agent_count,
           ds.person_id, ds.person_name,
           COALESCE(ds.session_title, ds.session_id) AS session_title,
           ds.status, ds.provider,
           ds.turn_count, ds.total_cost, ds.total_input_tokens, ds.total_output_tokens,
           ds.commits, ds.tools_used, ds.files_touched,
           da.app_id,
           ds.session_title AS prompt_preview
    FROM dim_sessions ds
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd
    ${where}
    ORDER BY ${orderBy}
    LIMIT ${SESSIONS_STATS_CAP}
  `, params)
}

export async function getSessionsStats(filters: SessionFilters = {}) {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filters.provider) { conditions.push('ds.provider = ?'); params.push(filters.provider) }
  if (filters.agent)    { conditions.push('ds.agent = ?');    params.push(filters.agent) }
  if (filters.status)   { conditions.push('ds.status = ?');   params.push(filters.status) }
  if (filters.q) {
    conditions.push("(ds.session_title ILIKE ? OR ds.session_id ILIKE ? OR ds.cwd ILIKE ?)")
    params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return queryOne(`
    SELECT
      COUNT(*) as total_count,
      SUM(total_cost) as total_cost,
      SUM(turn_count) as total_turns,
      SUM(commits) as total_commits
    FROM dim_sessions ds
    ${where}
  `, params)
}

export async function getSession(id: string) {
  const session = await queryOne(`
    SELECT * FROM dim_sessions WHERE session_id = ?
  `, [id])
  
  if (session) return session

  // Fallback: construct from raw events for real-time active sessions
  const raw = await queryOne(`
    SELECT 
      session_id,
      MIN(ts) as start_ts,
      MAX(ts) as end_ts,
      ANY_VALUE(model) as model,
      ANY_VALUE(cwd) as cwd,
      ANY_VALUE(git_branch) as git_branch,
      ANY_VALUE(claude_version) as claude_version,
      COUNT(DISTINCT CASE WHEN event_type = 'assistant' THEN message_id END) as turn_count,
      SUM(CASE WHEN event_type = 'assistant' THEN COALESCE(input_tokens, 0) ELSE 0 END) as total_input_tokens,
      SUM(CASE WHEN event_type = 'assistant' THEN COALESCE(output_tokens, 0) ELSE 0 END) as total_output_tokens,
      'active' as status,
      'Anthropic' as provider,
      ANY_VALUE(agent) as agent
    FROM raw_events
    WHERE session_id = ?
    GROUP BY session_id
  `, [id])

  if (!raw) return null

  const meta = await queryOne(`
    SELECT person_id, person_name, commits, session_title
    FROM session_meta
    WHERE session_id = ?
  `, [id])

  return {
    ...raw,
    project: raw.cwd,
    person_id: meta?.person_id ?? 'local',
    person_name: meta?.person_name ?? 'local',
    commits: meta?.commits ?? 0,
    session_title: meta?.session_title ?? 'Active Session',
    total_cost: 0.0,
    tools_used: 0,
    files_touched: 0,
    ephemeral_5m_total: 0,
    ephemeral_1h_total: 0,
    cache_read_total: 0
  }
}

export async function getSessionTurns(id: string) {
  const turns = await query(`
    SELECT turn_number, user_ts, assistant_ts, model,
           input_tokens, output_tokens, calculated_cost,
           cache_read_input_tokens, ephemeral_5m_input_tokens, ephemeral_1h_input_tokens,
           context_pct, user_prompt, assistant_response
    FROM fact_turns
    WHERE session_id = ?
    ORDER BY turn_number
    LIMIT 60
  `, [id])

  if (turns.length) return turns

  // Fallback: construct turns directly from raw events for real-time responsiveness
  return query(`
    SELECT 
      ROW_NUMBER() OVER (ORDER BY ts) as turn_number,
      ts as user_ts,
      ts as assistant_ts,
      model,
      COALESCE(input_tokens, 0) as input_tokens,
      COALESCE(output_tokens, 0) as output_tokens,
      0.0 as calculated_cost,
      COALESCE(cache_read_input_tokens, 0) as cache_read_input_tokens,
      COALESCE(ephemeral_5m_input_tokens, 0) as ephemeral_5m_input_tokens,
      COALESCE(ephemeral_1h_input_tokens, 0) as ephemeral_1h_input_tokens,
      COALESCE(context_pct, 0.0) as context_pct,
      input_message as user_prompt,
      output_message as assistant_response
    FROM raw_events
    WHERE session_id = ? AND event_type = 'assistant'
    ORDER BY ts
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

export async function getSessionToolExecutions(id: string) {
  return query(`
    SELECT 
      tool_name, 
      tool_call_ts, 
      tool_result_ts, 
      execution_duration_seconds, 
      is_error,
      json_extract_string(input_payload, '$.file_path') AS file_path
    FROM fact_tool_executions
    WHERE session_id = ?
    ORDER BY tool_call_ts
  `, [id])
}
