import { query, queryOne } from '../db'
import { tsFilter } from './_helpers'

export async function getAllAgents(since: string | null = null) {
  // No range filter: lifetime mart is correct (fast path).
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
      ORDER BY total_cost DESC
    `)
  }
  // Range filter: read from pre-aggregated int_entity_spend (date-grain table).
  // int_entity_spend aggregates to agent grain (not agent × app), so app_id
  // and project_id are NULL — the agents list page only needs agent totals.
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
  `)
}

export async function getAgent(name: string) {
  // dim_agents has no commits column — sum it from dim_sessions in parallel.
  const [agentRow, commitRow] = await Promise.all([
    queryOne(`
      SELECT agent,
             COUNT(DISTINCT app_id)         AS app_count,
             SUM(session_count)             AS session_count,
             SUM(total_turns)               AS total_turns,
             SUM(total_tool_calls)          AS total_tool_calls,
             SUM(total_cost)                AS total_cost,
             SUM(total_output_tokens)       AS total_output_tokens,
             array_distinct(array_agg(app_id))      AS apps,
             array_distinct(array_agg(project_id))  AS projects,
             MIN(first_seen)                AS first_seen,
             MAX(last_seen)                 AS last_seen
      FROM dim_agents
      WHERE agent = ?
      GROUP BY agent
    `, [name]),
    queryOne(`
      SELECT COALESCE(SUM(commits), 0) AS commits
      FROM dim_sessions
      WHERE agent = ?
    `, [name]),
  ])
  if (!agentRow) return null
  return { ...agentRow, commits: commitRow?.commits ?? 0 }
}

export async function getAgentApps(name: string, since: string | null = null) {
  // Fast path: lifetime mart.
  if (!since) {
    return query(`
      SELECT app_id, project_id, session_count, total_turns,
             total_cost, total_tool_calls
      FROM dim_agents WHERE agent = ?
      ORDER BY total_cost DESC
    `, [name])
  }
  // Range path: join fact_model_calls for accurate date-filtered cost.
  return query(`
    SELECT
      al.app_id                          AS app_id,
      al.project_id                      AS project_id,
      COUNT(DISTINCT fmc.session_id)     AS session_count,
      SUM(ds.turn_count)                 AS total_turns,
      SUM(fmc.calculated_cost)           AS total_cost,
      SUM(ds.tools_used)                 AS total_tool_calls
    FROM fact_model_calls fmc
    JOIN dim_sessions ds ON ds.session_id = fmc.session_id
    LEFT JOIN int_app_cwd_lookup al ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id
    WHERE fmc.agent = ?
      AND CAST(fmc.ts AS DATE) >= ?::DATE
      AND al.app_id IS NOT NULL
    GROUP BY al.app_id, al.project_id
    ORDER BY total_cost DESC
  `, [name, since])
}

export async function getAgentModels(name: string, since: string | null = null) {
  const sinceClause = since ? ` AND ft.assistant_ts >= '${since}'` : ''
  return query(`
    SELECT ft.model, SUM(ft.calculated_cost) AS cost,
           COUNT(DISTINCT ft.session_id) AS sessions
    FROM fact_turns ft
    LEFT JOIN int_event_agent ea
      ON ea.event_uuid = ft.assistant_event_uuid AND ea.tenant_id = ft.tenant_id
    WHERE COALESCE(ea.agent_resolved, 'main') = ?${sinceClause}
    GROUP BY ft.model
    ORDER BY cost DESC
  `, [name])
}

export async function getAgentSessions(name: string, limit = 12, since: string | null = null) {
  const sinceClause = since ? ` AND ds.start_ts >= '${since}'` : ''
  return query(`
    SELECT ds.session_id, ds.start_ts, ds.end_ts, ds.model, ds.turn_count,
           ds.total_cost, ds.session_title, ds.cwd, da.app_id
    FROM dim_sessions ds
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd
    WHERE ds.agent = ?${sinceClause}
    ORDER BY ds.start_ts DESC
    LIMIT ?
  `, [name, limit])
}

export async function getAgentPeople(name: string, since: string | null = null) {
  // Fast path: lifetime mart.
  if (!since) {
    return query(`
      SELECT ds.person_id, ds.person_name,
             COUNT(DISTINCT ds.session_id)  AS session_count,
             SUM(ds.turn_count)             AS total_turns,
             SUM(ds.total_cost)             AS total_cost
      FROM dim_sessions ds
      WHERE ds.agent = ?
        AND ds.person_id IS NOT NULL
      GROUP BY ds.person_id, ds.person_name
      ORDER BY total_cost DESC
    `, [name])
  }
  // Range path: join fact_model_calls for accurate date-filtered cost.
  return query(`
    SELECT
      ds.person_id,
      ds.person_name,
      COUNT(DISTINCT fmc.session_id)   AS session_count,
      SUM(ds.turn_count)               AS total_turns,
      SUM(fmc.calculated_cost)         AS total_cost
    FROM fact_model_calls fmc
    JOIN dim_sessions ds ON ds.session_id = fmc.session_id
    WHERE fmc.agent = ?
      AND CAST(fmc.ts AS DATE) >= ?::DATE
      AND ds.person_id IS NOT NULL
    GROUP BY ds.person_id, ds.person_name
    ORDER BY total_cost DESC
  `, [name, since])
}

export async function getAgentFiles(name: string, limit = 8, since: string | null = null) {
  const sinceClause = since ? ` AND ds.start_ts >= '${since}'` : ''
  return query(`
    SELECT fsf.file_path, fsf.file_ext,
           SUM(fsf.tokens_attributed)            AS tokens,
           SUM(fsf.duration_attributed_seconds)  AS duration_s,
           SUM(fsf.edit_count)                   AS edits
    FROM fact_session_files fsf
    JOIN dim_sessions ds ON ds.session_id = fsf.session_id
    WHERE ds.agent = ?${sinceClause}
    GROUP BY fsf.file_path, fsf.file_ext
    ORDER BY tokens DESC
    LIMIT ?
  `, [name, limit])
}

// Top skills loaded across sessions where this agent was the resolved agent.
export async function getAgentSkills(name: string, since: string | null = null, limit = 10) {
  const sinceClause = since ? ` AND ds.end_ts >= '${since}'::TIMESTAMP` : ''
  return query(`
    SELECT
      rs.skill_name                 AS skill,
      COUNT(DISTINCT rs.session_id) AS session_count,
      MAX(ds.end_ts)                AS last_used
    FROM raw_session_skills rs
    JOIN dim_sessions ds ON ds.session_id = rs.session_id
    WHERE ds.agent = ?${sinceClause}
    GROUP BY rs.skill_name
    ORDER BY session_count DESC, last_used DESC
    LIMIT ${limit}
  `, [name])
}

export async function getAgentMcps(name: string, since: string | null = null, limit = 10) {
  const sinceClause = since ? ` AND ds.end_ts >= '${since}'::TIMESTAMP` : ''
  return query(`
    SELECT
      rm.mcp_server                 AS mcp_server,
      COUNT(DISTINCT rm.session_id) AS session_count,
      MAX(ds.end_ts)                AS last_used
    FROM raw_session_mcps rm
    JOIN dim_sessions ds ON ds.session_id = rm.session_id
    WHERE ds.agent = ?${sinceClause}
    GROUP BY rm.mcp_server
    ORDER BY session_count DESC, last_used DESC
    LIMIT ${limit}
  `, [name])
}

/**
 * Range-aware header rollup for the agent profile. Returns null when
 * `since` is null so the page falls back to the lifetime `dim_agents` mart.
 */
export async function getAgentRangeAggregates(name: string, since: string | null) {
  if (!since) return null
  // int_entity_spend.total_tool_calls is hardcoded to 0 in the dbt model.
  // Fetch real tool_call count from dim_sessions in a parallel query.
  // total_output_tokens IS in int_entity_spend for agent grain — use it directly.
  const [agg, toolRow] = await Promise.all([
    queryOne(`
      SELECT
        SUM(es.session_count)            AS session_count,
        SUM(es.total_turns)              AS total_turns,
        SUM(es.total_cost)               AS total_cost,
        SUM(es.total_output_tokens)      AS total_output_tokens,
        NULL::BIGINT                     AS app_count
      FROM int_entity_spend es
      WHERE es.entity_type = 'agent'
        AND es.entity_id = ?
        AND es.date >= ?::DATE
    `, [name, since]),
    queryOne(`
      SELECT COALESCE(SUM(tools_used), 0) AS total_tool_calls
      FROM dim_sessions
      WHERE agent = ?
        AND CAST(start_ts AS DATE) >= ?::DATE
    `, [name, since]),
  ])
  if (!agg) return null
  return { ...agg, total_tool_calls: toolRow?.total_tool_calls ?? 0 }
}
