import { query, queryOne } from '../db'

export async function getAgent(name: string) {
  return queryOne(`
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
  `, [name])
}

export async function getAgentApps(name: string) {
  return query(`
    SELECT app_id, project_id, session_count, total_turns,
           total_cost, total_tool_calls
    FROM dim_agents WHERE agent = ?
    ORDER BY total_cost DESC
  `, [name])
}

export async function getAgentModels(name: string) {
  return query(`
    SELECT ft.model, SUM(ft.calculated_cost) AS cost,
           COUNT(DISTINCT ft.session_id) AS sessions
    FROM fact_turns ft
    LEFT JOIN int_event_agent ea
      ON ea.event_uuid = ft.assistant_event_uuid AND ea.tenant_id = ft.tenant_id
    WHERE COALESCE(ea.agent_resolved, 'main') = ?
    GROUP BY ft.model
    ORDER BY cost DESC
  `, [name])
}

export async function getAgentSessions(name: string, limit = 12) {
  return query(`
    SELECT ds.session_id, ds.start_ts, ds.end_ts, ds.model, ds.turn_count,
           ds.total_cost, ds.session_title, ds.cwd, da.app_id
    FROM dim_sessions ds
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd
    WHERE ds.agent = ?
    ORDER BY ds.start_ts DESC
    LIMIT ?
  `, [name, limit])
}

export async function getAgentFiles(name: string, limit = 8) {
  return query(`
    SELECT fsf.file_path, fsf.file_ext,
           SUM(fsf.tokens_attributed)            AS tokens,
           SUM(fsf.duration_attributed_seconds)  AS duration_s,
           SUM(fsf.edit_count)                   AS edits
    FROM fact_session_files fsf
    JOIN dim_sessions ds ON ds.session_id = fsf.session_id
    WHERE ds.agent = ?
    GROUP BY fsf.file_path, fsf.file_ext
    ORDER BY tokens DESC
    LIMIT ?
  `, [name, limit])
}
