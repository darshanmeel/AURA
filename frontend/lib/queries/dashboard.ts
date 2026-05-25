import { query, queryOne } from '../db'

const TOP_N = 10
const DAILY_SPEND_DAYS = 14

function tsFilter(col: string, since: string | null): string {
  if (!since) return ''
  return `WHERE ${col} >= '${since}'`
}

function andTsFilter(col: string, since: string | null): string {
  if (!since) return ''
  return `AND ${col} >= '${since}'`
}

export async function getDashboardKPIs(since: string | null = null) {
  const wh = tsFilter('start_ts', since)
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
       WHERE prompt_ts >= CURRENT_DATE - INTERVAL '1 day' AND prompt_origin = 'human'
       ORDER BY output_tokens_total DESC LIMIT 1)                          AS editor_quote,
      (SELECT agent FROM fact_prompts
       WHERE prompt_ts >= CURRENT_DATE - INTERVAL '1 day' AND prompt_origin = 'human'
       ORDER BY output_tokens_total DESC LIMIT 1)                          AS editor_quote_agent,
      (SELECT app_id FROM fact_prompts
       WHERE prompt_ts >= CURRENT_DATE - INTERVAL '1 day' AND prompt_origin = 'human'
       ORDER BY output_tokens_total DESC LIMIT 1)                          AS editor_quote_app
    FROM dim_sessions
    ${wh}
  `)
}

export async function getDailySpend(since: string | null = null) {
  const wh = since ? `WHERE date >= '${since}'::DATE` : ''
  return query(`
    SELECT
      date,
      SUM(daily_cost)  AS cost,
      SUM(turn_count)  AS turns
    FROM fact_daily_spend
    ${wh}
    GROUP BY date
    ORDER BY date DESC
    LIMIT ${DAILY_SPEND_DAYS}
  `)
}

export async function getTopApps(since: string | null = null) {
  const wh = tsFilter('ds.start_ts', since)
  return query(`
    SELECT
      COALESCE(da.app_id, ds.cwd)                   AS app_id,
      COALESCE(da.app_name, da.app_id, ds.cwd)      AS app_name,
      SUM(ds.total_cost)                             AS total_cost,
      COUNT(DISTINCT ds.session_id)                  AS session_count,
      SUM(ds.turn_count)                             AS total_turns,
      COUNT(DISTINCT ds.agent)                       AS agent_count,
      ARRAY_AGG(DISTINCT ds.agent)                   AS agents
    FROM dim_sessions ds
    LEFT JOIN int_app_cwd_lookup al ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id
    LEFT JOIN dim_apps da ON da.app_id = al.app_id
    ${wh}
    GROUP BY 1, 2
    ORDER BY total_cost DESC NULLS LAST
    LIMIT ${TOP_N}
  `)
}

export async function getTopProjects(since: string | null = null) {
  const wh = tsFilter('ds.start_ts', since)
  const andWh = andTsFilter('ds.start_ts', since)

  const [projects, apps] = await Promise.all([
    query(`
      SELECT
        COALESCE(dp.project_id, al.project_id, ds.cwd)   AS project_id,
        COALESCE(dp.project_name, dp.project_id, ds.cwd)  AS project_name,
        SUM(ds.total_cost)                                AS total_cost,
        COUNT(DISTINCT ds.session_id)                     AS session_count,
        SUM(ds.turn_count)                                AS total_turns,
        COUNT(DISTINCT al.app_id)                         AS app_count
      FROM dim_sessions ds
      LEFT JOIN int_app_cwd_lookup al ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id
      LEFT JOIN dim_projects dp ON dp.project_id = al.project_id
      ${wh}
      GROUP BY 1, 2
      ORDER BY total_cost DESC NULLS LAST
      LIMIT ${TOP_N}
    `),
    query(`
      SELECT
        COALESCE(da.app_id, ds.cwd)                   AS app_id,
        COALESCE(da.app_name, da.app_id, ds.cwd)      AS app_name,
        SUM(ds.total_cost)                             AS total_cost,
        SUM(ds.turn_count)                             AS total_turns,
        COUNT(DISTINCT ds.session_id)                  AS session_count,
        al.project_id
      FROM dim_sessions ds
      LEFT JOIN int_app_cwd_lookup al ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id
      LEFT JOIN dim_apps da ON da.app_id = al.app_id
      ${wh}
      GROUP BY 1, 2, al.project_id
      ORDER BY total_cost DESC NULLS LAST
    `)
  ])

  return projects.map((p: any) => ({
    ...p,
    apps: apps
      .filter((a: any) => a.project_id === p.project_id)
      .sort((a: any, b: any) => (b.total_cost ?? 0) - (a.total_cost ?? 0))
  }))
}

export async function getTopAgents(since: string | null = null) {
  const wh = tsFilter('ds.start_ts', since)
  return query(`
    SELECT
      ds.agent,
      al.app_id,
      al.project_id,
      COUNT(DISTINCT ds.session_id)   AS session_count,
      SUM(ds.turn_count)              AS total_turns,
      SUM(ds.total_cost)              AS total_cost,
      SUM(ds.tools_used)              AS total_tool_calls
    FROM dim_sessions ds
    LEFT JOIN int_app_cwd_lookup al ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id
    ${wh}
    GROUP BY ds.agent, al.app_id, al.project_id
    ORDER BY total_cost DESC NULLS LAST
    LIMIT 20
  `)
}

export async function getToolMix(since: string | null = null) {
  const wh = since ? `WHERE tool_call_ts >= '${since}'` : ''
  return query(`
    SELECT tool_name, COUNT(*) AS call_count
    FROM fact_tool_executions
    ${wh}
    GROUP BY tool_name
    ORDER BY call_count DESC
    LIMIT 12
  `)
}

export async function getProviderSplit(since: string | null = null) {
  const wh = tsFilter('start_ts', since)
  return query(`
    SELECT provider, SUM(total_cost) AS cost, COUNT(DISTINCT session_id) AS sessions
    FROM dim_sessions
    ${wh}
    GROUP BY provider
    ORDER BY cost DESC
  `)
}

export async function getModelBreakdown(since: string | null = null) {
  const wh = tsFilter('start_ts', since)
  return query(`
    SELECT model, SUM(total_cost) AS cost, COUNT(DISTINCT session_id) AS sessions
    FROM dim_sessions
    ${wh}
    GROUP BY model
    ORDER BY cost DESC
    LIMIT 8
  `)
}

export async function getRecentErrors(since: string | null = null) {
  const wh = tsFilter('ts', since)
  return query(`
    SELECT ts, kind, tool, message, severity, session_id
    FROM fact_errors
    ${wh}
    ORDER BY ts DESC
    LIMIT 5
  `)
}

export async function getTopFiles(since: string | null = null) {
  const andWh = andTsFilter('ds.start_ts', since)
  // fact_session_files has no timestamp column; join to dim_sessions for filtering
  if (!since) {
    return query(`
      SELECT file_path, file_ext, SUM(edit_count) AS edits, SUM(write_count) AS writes
      FROM fact_session_files
      GROUP BY file_path, file_ext
      ORDER BY edits DESC
      LIMIT ${TOP_N}
    `)
  }
  return query(`
    SELECT fsf.file_path, fsf.file_ext, SUM(fsf.edit_count) AS edits, SUM(fsf.write_count) AS writes
    FROM fact_session_files fsf
    JOIN dim_sessions ds ON ds.session_id = fsf.session_id
    WHERE ds.start_ts >= '${since}'
    GROUP BY fsf.file_path, fsf.file_ext
    ORDER BY edits DESC
    LIMIT ${TOP_N}
  `)
}

export async function getTopPeople(since: string | null = null) {
  const wh = tsFilter('start_ts', since)
  return query(`
    SELECT
      person_id,
      person_name,
      SUM(total_cost)   AS total_cost,
      COUNT(DISTINCT session_id) AS session_count,
      SUM(commits)      AS total_commits
    FROM dim_sessions
    ${wh}
    GROUP BY person_id, person_name
    ORDER BY total_cost DESC NULLS LAST
    LIMIT 6
  `)
}
