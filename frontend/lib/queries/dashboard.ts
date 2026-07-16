import { query, queryOne } from '../db'
import { assertTs, tsFilter, andTsFilter } from './_helpers'

const TOP_N = 10
const DAILY_SPEND_DAYS = 14

// COST-ANCHORING CONTRACT (F-H2/F-H3):
// total_cost is intentionally anchored to EVENT DATE via fact_daily_spend.date,
// NOT to session start_ts. This reconciles with int_entity_spend (which also
// aggregates by event date via fact_model_calls.ts). Switching cost to start_ts
// would break reconciliation — do NOT do that.
//
// total_sessions and the session-dimension counts (total_people, total_agents,
// total_tool_calls, etc.) are filtered by start_ts via dim_sessions. This is
// correct: session counts should reflect sessions that started in the window,
// while cost reflects spend that occurred in the window. The two windows can
// diverge slightly at boundaries (a session started before `since` may still
// have events billed after `since`), which is the expected and documented
// behaviour.
export async function getDashboardKPIs(since: string | null = null) {
  const wh = tsFilter('start_ts', since)
  // Cost filter uses event date (::DATE cast), not start_ts — see contract above.
  const spendWh = since ? `WHERE date >= '${assertTs(since)}'::DATE` : ''
  return queryOne(`
    SELECT
      COUNT(DISTINCT session_id)                                            AS total_sessions,
      (SELECT SUM(daily_cost) FROM fact_daily_spend ${spendWh})            AS total_cost,
      SUM(turn_count)                                                       AS total_turns,
      SUM(total_input_tokens)                                               AS total_input_tokens,
      SUM(total_output_tokens)                                              AS total_output_tokens,
      SUM(tools_used)                                                       AS total_tool_calls,
      SUM(commits)                                                          AS total_commits,
      (SELECT COUNT(DISTINCT al.app_id)
       FROM dim_sessions ds2
       LEFT JOIN int_app_cwd_lookup al ON al.cwd = ds2.cwd AND al.tenant_id = ds2.tenant_id
       ${since ? `WHERE ds2.start_ts >= '${assertTs(since)}'` : ''})       AS total_apps,
      COUNT(DISTINCT person_id)                                             AS total_people,
      COUNT(DISTINCT agent)                                                 AS total_agents,
      COUNT(DISTINCT CASE WHEN status = 'active' THEN session_id END)      AS active_sessions,
      COUNT(*) FILTER (WHERE session_status = 'budget_killed')             AS budget_killed_count,
      SUM(cache_read_total)::DOUBLE /
          NULLIF(SUM(cache_read_total + ephemeral_5m_total + ephemeral_1h_total), 0) AS cache_hit_rate,
      SUM(cache_read_total)                                                 AS cache_read_total,
      SUM(ephemeral_5m_total)                                               AS cache_5m_total,
      SUM(ephemeral_1h_total)                                               AS cache_1h_total,
      MIN(start_ts)                                                         AS first_session,
      MAX(start_ts)                                                         AS last_session,
      COUNT(*) FILTER (WHERE verdict = 'accepted')                         AS accepted_sessions,
      COALESCE(SUM(CASE WHEN verdict = 'accepted' THEN total_cost ELSE 0 END), 0) AS accepted_cost,
      COALESCE(SUM(CASE WHEN verdict = 'accepted' THEN total_cost ELSE 0 END), 0)
        / NULLIF(COUNT(*) FILTER (WHERE verdict = 'accepted'), 0)          AS cost_per_accepted_session
    FROM dim_sessions
    ${wh}
  `)
}

export async function getDailySpend(since: string | null = null) {
  const wh = since ? `WHERE date >= '${assertTs(since)}'::DATE` : ''
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

// Token volume bucketed over time. Hour-grain for 'today' (24 buckets);
// day-grain otherwise. Returns one row per bucket with 5 token-type columns
// already split out so the chart can stack them without further math.
//
// All buckets are derived from fact_model_calls.ts so the same time anchor
// that drives cost (fact_daily_spend ← fact_model_calls) drives token
// volume too — no day-vs-session-start drift.
export async function getTokenSeries(since: string | null, hourly: boolean) {
  const bucket = hourly ? "date_trunc('hour', ts)" : "date_trunc('day', ts)"
  const wh = since ? `WHERE ts >= TIMESTAMP '${assertTs(since).replace('T', ' ').replace('Z','')}'` : ''
  return query(`
    SELECT
      ${bucket}::TIMESTAMP                            AS bucket_ts,
      COALESCE(SUM(input_tokens), 0)                  AS input_tokens,
      COALESCE(SUM(output_tokens), 0)                 AS output_tokens,
      COALESCE(SUM(ephemeral_5m_input_tokens), 0)     AS cache_5m,
      COALESCE(SUM(ephemeral_1h_input_tokens), 0)     AS cache_1h,
      COALESCE(SUM(cache_read_input_tokens), 0)       AS cache_read
    FROM fact_model_calls
    ${wh}
    GROUP BY 1
    ORDER BY 1
  `)
}

// Token volume per (bucket, model). Long form — chart code pivots.
export async function getTokenSeriesByModel(since: string | null, hourly: boolean) {
  const bucket = hourly ? "date_trunc('hour', ts)" : "date_trunc('day', ts)"
  const wh = since ? `WHERE ts >= TIMESTAMP '${assertTs(since).replace('T', ' ').replace('Z','')}'` : ''
  return query(`
    SELECT
      ${bucket}::TIMESTAMP                                                   AS bucket_ts,
      model,
      COALESCE(SUM(input_tokens + output_tokens
                 + ephemeral_5m_input_tokens
                 + ephemeral_1h_input_tokens
                 + cache_read_input_tokens), 0)                              AS total_tokens
    FROM fact_model_calls
    ${wh}
    GROUP BY 1, 2
    ORDER BY 1
  `)
}

// Token volume per (bucket, provider). 2–3 providers is small enough to chart.
export async function getTokenSeriesByProvider(since: string | null, hourly: boolean) {
  const bucket = hourly ? "date_trunc('hour', ts)" : "date_trunc('day', ts)"
  const wh = since ? `WHERE ts >= TIMESTAMP '${assertTs(since).replace('T', ' ').replace('Z','')}'` : ''
  return query(`
    SELECT
      ${bucket}::TIMESTAMP                                                   AS bucket_ts,
      CASE
        WHEN model LIKE 'claude%'  THEN 'Anthropic'
        WHEN model LIKE 'gemini%'  THEN 'Google'
        ELSE 'Other'
      END                                                                    AS provider,
      COALESCE(SUM(input_tokens + output_tokens
                 + ephemeral_5m_input_tokens
                 + ephemeral_1h_input_tokens
                 + cache_read_input_tokens), 0)                              AS total_tokens
    FROM fact_model_calls
    ${wh}
    GROUP BY 1, 2
    ORDER BY 1
  `)
}

// Token volume rolled up per agent (no time dimension — too many series for a
// chart). Table-shape, sorted by total descending, top N. Resolved agent
// comes from int_event_agent via fact_model_calls; missing → 'main'.
export async function getTokenByAgent(since: string | null, limit = 20) {
  const wh = since ? `WHERE fmc.ts >= TIMESTAMP '${assertTs(since).replace('T', ' ').replace('Z','')}'` : ''
  return query(`
    SELECT
      COALESCE(ea.agent_resolved, 'main')                                    AS agent,
      COALESCE(SUM(fmc.input_tokens), 0)                                     AS input_tokens,
      COALESCE(SUM(fmc.output_tokens), 0)                                    AS output_tokens,
      COALESCE(SUM(fmc.ephemeral_5m_input_tokens + fmc.ephemeral_1h_input_tokens), 0) AS cache_write,
      COALESCE(SUM(fmc.cache_read_input_tokens), 0)                          AS cache_read,
      COALESCE(SUM(fmc.input_tokens + fmc.output_tokens
                 + fmc.ephemeral_5m_input_tokens
                 + fmc.ephemeral_1h_input_tokens
                 + fmc.cache_read_input_tokens), 0)                          AS total_tokens,
      COALESCE(SUM(fmc.calculated_cost), 0)                                  AS cost
    FROM fact_model_calls fmc
    LEFT JOIN int_event_agent ea
      ON ea.event_uuid = fmc.event_uuid
     AND ea.tenant_id  = fmc.tenant_id
    ${wh}
    GROUP BY 1
    ORDER BY total_tokens DESC
    LIMIT ${limit}
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
      AND es.date >= '${assertTs(since)}'::DATE
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
      LIMIT 50
    `)
  ])

  type ProjectRow = { project_id: string; [key: string]: unknown }
  type AppRow    = { project_id: string | null; total_cost: number | null; [key: string]: unknown }
  return (projects as ProjectRow[]).map((p) => ({
    ...p,
    apps: (apps as AppRow[])
      .filter((a) => a.project_id === p.project_id)
      .sort((a, b) => ((b.total_cost ?? 0) as number) - ((a.total_cost ?? 0) as number))
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
      AND es.date >= '${assertTs(since)}'::DATE
    GROUP BY es.entity_id
    ORDER BY total_cost DESC NULLS LAST
    LIMIT 20
  `)
}

export async function getToolMix(since: string | null = null) {
  const wh = since ? `WHERE tool_call_ts >= '${assertTs(since)}'` : ''
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
  const wh = since ? `WHERE date >= '${assertTs(since)}'::DATE` : ''
  return query(`
    SELECT provider, SUM(daily_cost) AS cost, SUM(session_count) AS sessions
    FROM fact_daily_spend
    ${wh}
    GROUP BY provider
    ORDER BY cost DESC
  `)
}

export async function getModelBreakdown(since: string | null = null) {
  // Return all models (no LIMIT) so the page can render a "top 8 of N · $X of $Y"
  // disclosure when the model count exceeds the visible cap. Models per tenant are
  // ~10 in practice — the unbounded read stays small.
  const wh = since ? `WHERE date >= '${assertTs(since)}'::DATE` : ''
  return query(`
    SELECT model, SUM(daily_cost) AS cost, SUM(session_count) AS sessions
    FROM fact_daily_spend
    ${wh}
    GROUP BY model
    ORDER BY cost DESC
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
    WHERE ds.start_ts >= '${assertTs(since!)}'
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
      AND es.date >= '${assertTs(since)}'::DATE
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

// Top skills loaded across sessions in the range. Counts distinct sessions per
// skill and surfaces the most recent session end as "last used". raw_session_skills
// has no per-row timestamp, so we anchor recency to dim_sessions.end_ts via the
// session join. Returns at most 10 rows for the dashboard mini-table.
export async function getTopSkills(since: string | null = null, limit = 10) {
  const wh = since ? `WHERE s.end_ts >= '${assertTs(since)}'::TIMESTAMP` : ''
  return query(`
    SELECT
      rs.skill_name                   AS skill,
      COUNT(DISTINCT rs.session_id)   AS session_count,
      MAX(s.end_ts)                   AS last_used
    FROM raw_session_skills rs
    JOIN dim_sessions s ON s.session_id = rs.session_id
    ${wh}
    GROUP BY rs.skill_name
    ORDER BY session_count DESC, last_used DESC
    LIMIT ${limit}
  `)
}

// Top MCP servers loaded across sessions in the range. Same shape as getTopSkills.
export async function getTopMcps(since: string | null = null, limit = 10) {
  const wh = since ? `WHERE s.end_ts >= '${assertTs(since)}'::TIMESTAMP` : ''
  return query(`
    SELECT
      rm.mcp_server                   AS mcp_server,
      COUNT(DISTINCT rm.session_id)   AS session_count,
      MAX(s.end_ts)                   AS last_used
    FROM raw_session_mcps rm
    JOIN dim_sessions s ON s.session_id = rm.session_id
    ${wh}
    GROUP BY rm.mcp_server
    ORDER BY session_count DESC, last_used DESC
    LIMIT ${limit}
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
