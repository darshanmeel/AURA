import { query, queryOne } from '../db'
import { tsFilter, andTsFilter } from './_helpers'

const TOP_N = 10
const DAILY_SPEND_DAYS = 14

export async function getDashboardKPIs(since: string | null = null) {
  const wh = tsFilter('start_ts', since)
  const spendWh = since ? `WHERE date >= '${since}'::DATE` : ''
  return queryOne(`
    SELECT
      COUNT(DISTINCT session_id)                                            AS total_sessions,
      (SELECT SUM(daily_cost) FROM fact_daily_spend ${spendWh})            AS total_cost,
      SUM(turn_count)                                                       AS total_turns,
      SUM(tools_used)                                                       AS total_tool_calls,
      SUM(commits)                                                          AS total_commits,
      (SELECT COUNT(DISTINCT al.app_id)
       FROM dim_sessions ds2
       LEFT JOIN int_app_cwd_lookup al ON al.cwd = ds2.cwd AND al.tenant_id = ds2.tenant_id
       ${since ? `WHERE ds2.start_ts >= '${since}'` : ''})       AS total_apps,
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
  // Fast path: lifetime mart (no date filter).
  if (!since) {
    return query(`
      SELECT
        da.app_id,
        COALESCE(da.app_name, da.app_id) AS app_name,
        da.total_cost,
        da.session_count,
        da.total_turns,
        NULL::BIGINT                     AS agent_count,
        NULL::VARCHAR[]                  AS agents
      FROM dim_apps da
      ORDER BY total_cost DESC NULLS LAST
      LIMIT ${TOP_N}
    `)
  }
  // Range path: read from pre-aggregated int_entity_spend (date-grain table).
  return query(`
    SELECT
      es.entity_id                                   AS app_id,
      COALESCE(da.app_name, da.app_id, es.entity_id) AS app_name,
      SUM(es.total_cost)                             AS total_cost,
      SUM(es.session_count)                          AS session_count,
      SUM(es.total_turns)                            AS total_turns,
      NULL::BIGINT                                   AS agent_count,
      NULL::VARCHAR[]                                AS agents
    FROM int_entity_spend es
    LEFT JOIN dim_apps da ON da.app_id = es.entity_id AND da.tenant_id = es.tenant_id
    WHERE es.entity_type = 'app'
      AND es.date >= '${since}'::DATE
    GROUP BY es.entity_id, COALESCE(da.app_name, da.app_id, es.entity_id)
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
  // Fast path: lifetime mart (no date filter).
  if (!since) {
    return query(`
      SELECT
        agent,
        app_id,
        project_id,
        session_count,
        total_turns,
        total_cost,
        total_tool_calls
      FROM dim_agents
      ORDER BY total_cost DESC NULLS LAST
      LIMIT 20
    `)
  }
  // Range path: read from pre-aggregated int_entity_spend (date-grain table).
  return query(`
    SELECT
      es.entity_id                     AS agent,
      NULL::VARCHAR                    AS app_id,
      NULL::VARCHAR                    AS project_id,
      SUM(es.session_count)            AS session_count,
      SUM(es.total_turns)              AS total_turns,
      SUM(es.total_cost)               AS total_cost,
      SUM(es.total_tool_calls)         AS total_tool_calls
    FROM int_entity_spend es
    WHERE es.entity_type = 'agent'
      AND es.date >= '${since}'::DATE
    GROUP BY es.entity_id
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
  const wh = since ? `WHERE date >= '${since}'::DATE` : ''
  return query(`
    SELECT provider, SUM(daily_cost) AS cost, SUM(session_count) AS sessions
    FROM fact_daily_spend
    ${wh}
    GROUP BY provider
    ORDER BY cost DESC
  `)
}

export async function getModelBreakdown(since: string | null = null) {
  const wh = since ? `WHERE date >= '${since}'::DATE` : ''
  return query(`
    SELECT model, SUM(daily_cost) AS cost, SUM(session_count) AS sessions
    FROM fact_daily_spend
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
  // Fast path: lifetime mart (no date filter).
  if (!since) {
    return query(`
      SELECT
        person_id,
        person_name,
        total_cost,
        session_count,
        total_commits
      FROM dim_people
      ORDER BY total_cost DESC NULLS LAST
      LIMIT 6
    `)
  }
  // Range path: read from pre-aggregated int_entity_spend (date-grain table).
  return query(`
    SELECT
      es.entity_id                     AS person_id,
      ANY_VALUE(dp.person_name)        AS person_name,
      SUM(es.total_cost)               AS total_cost,
      SUM(es.session_count)            AS session_count,
      SUM(es.commits)                  AS total_commits
    FROM int_entity_spend es
    LEFT JOIN dim_people dp ON dp.person_id = es.entity_id
    WHERE es.entity_type = 'person'
      AND es.date >= '${since}'::DATE
    GROUP BY es.entity_id
    ORDER BY total_cost DESC NULLS LAST
    LIMIT 6
  `)
}

export async function getSpendPace() {
  return queryOne(`
    SELECT
      today_cost,
      today_pace_hourly,
      avg_30d_cost,
      avg_30d_turns,
      avg_30d_tools,
      today_turn_count,
      hours_elapsed_today
    FROM fact_spend_pace
    WHERE tenant_id = 'local'
    LIMIT 1
  `)
}

export async function getHourlyActivity() {
  return query(`
    SELECT
      day_of_week,
      hour_of_day,
      turn_count,
      total_cost,
      session_starts
    FROM fact_hourly_activity
    ORDER BY day_of_week, hour_of_day
  `)
}
