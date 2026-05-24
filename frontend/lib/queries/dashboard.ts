import { query, queryOne } from '../db'

const TOP_N = 10
const DAILY_SPEND_DAYS = 14

export async function getDashboardKPIs() {
  return queryOne(`
    SELECT
      COUNT(DISTINCT session_id)                                            AS total_sessions,
      SUM(total_cost)                                                       AS total_cost,
      SUM(turn_count)                                                       AS total_turns,
      SUM(tools_used)                                                       AS total_tool_calls,
      SUM(commits)                                                          AS total_commits,
      COUNT(DISTINCT cwd)                                                   AS total_apps,
      COUNT(DISTINCT person_id)                                             AS total_people,
      COUNT(DISTINCT CASE WHEN status = 'active' THEN session_id END)      AS active_sessions,
      SUM(cache_read_total)::DOUBLE /
          NULLIF(SUM(cache_read_total + ephemeral_5m_total + ephemeral_1h_total), 0) AS cache_hit_rate,
      SUM(ephemeral_5m_total)                                               AS cache_5m_total,
      SUM(ephemeral_1h_total)                                               AS cache_1h_total,
      MIN(start_ts)                                                         AS first_session,
      MAX(start_ts)                                                         AS last_session,
      (SELECT prompt_text_200 FROM fact_prompts
       WHERE prompt_ts >= CURRENT_DATE - INTERVAL '1 day'
       ORDER BY output_tokens_total DESC LIMIT 1)                          AS editor_quote,
      (SELECT agent FROM fact_prompts
       WHERE prompt_ts >= CURRENT_DATE - INTERVAL '1 day'
       ORDER BY output_tokens_total DESC LIMIT 1)                          AS editor_quote_agent,
      (SELECT app_id FROM fact_prompts
       WHERE prompt_ts >= CURRENT_DATE - INTERVAL '1 day'
       ORDER BY output_tokens_total DESC LIMIT 1)                          AS editor_quote_app
    FROM dim_sessions
  `)
}

export async function getDailySpend() {
  return query(`
    SELECT
      date,
      SUM(daily_cost)  AS cost,
      SUM(turn_count)  AS turns
    FROM fact_daily_spend
    GROUP BY date
    ORDER BY date DESC
    LIMIT ${DAILY_SPEND_DAYS}
  `)
}

export async function getTopApps() {
  return query(`
    SELECT app_id, app_name, total_cost, session_count, total_turns
    FROM dim_apps
    ORDER BY total_cost DESC
    LIMIT ${TOP_N}
  `)
}

export async function getTopProjects() {
  const rows = await query<any>(`
    SELECT
        p.project_id,
        p.project_name,
        p.total_cost,
        p.session_count,
        p.total_turns,
        p.app_count,
        LIST({
            app_id:       a.app_id,
            app_name:     a.app_name,
            total_cost:   a.total_cost,
            total_turns:  a.total_turns,
            session_count: a.session_count
        } ORDER BY a.total_cost DESC NULLS LAST) AS apps
    FROM dim_projects p
    LEFT JOIN dim_apps a USING (project_id)
    GROUP BY p.project_id, p.project_name, p.total_cost, p.session_count, p.total_turns, p.app_count
    ORDER BY p.total_cost DESC NULLS LAST
    LIMIT ${TOP_N}
  `)

  return rows.map((row: any) => ({
    ...row,
    apps: typeof row.apps === 'string' ? JSON.parse(row.apps) : (row.apps ?? [])
  }))
}

export async function getTopAgents() {
  return query(`
    SELECT
      agent,
      COUNT(DISTINCT session_id) AS session_count,
      SUM(total_cost)            AS total_cost,
      SUM(turn_count)            AS total_turns
    FROM dim_sessions
    GROUP BY agent
    ORDER BY total_cost DESC
    LIMIT ${TOP_N}
  `)
}

export async function getToolMix() {
  return query(`
    SELECT tool_name, COUNT(*) AS call_count
    FROM fact_tool_executions
    GROUP BY tool_name
    ORDER BY call_count DESC
    LIMIT 12
  `)
}

export async function getProviderSplit() {
  return query(`
    SELECT provider, SUM(total_cost) AS cost, COUNT(DISTINCT session_id) AS sessions
    FROM dim_sessions
    GROUP BY provider
    ORDER BY cost DESC
  `)
}

export async function getModelBreakdown() {
  return query(`
    SELECT model, SUM(total_cost) AS cost, COUNT(DISTINCT session_id) AS sessions
    FROM dim_sessions
    GROUP BY model
    ORDER BY cost DESC
    LIMIT 8
  `)
}

export async function getRecentErrors() {
  return query(`
    SELECT ts, kind, tool, message, severity, session_id
    FROM fact_errors
    ORDER BY ts DESC
    LIMIT 5
  `)
}

export async function getTopFiles() {
  return query(`
    SELECT file_path, file_ext, SUM(edit_count) AS edits, SUM(write_count) AS writes
    FROM fact_session_files
    GROUP BY file_path, file_ext
    ORDER BY edits DESC
    LIMIT ${TOP_N}
  `)
}

export async function getTopPeople() {
  return query(`
    SELECT person_id, person_name, total_cost, session_count, total_commits
    FROM dim_people
    ORDER BY total_cost DESC
    LIMIT 6
  `)
}
