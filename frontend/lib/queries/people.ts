import { query, queryOne } from '../db'
import { tsFilter } from './_helpers'

export async function getPeople(since: string | null = null) {
  // No range filter: lifetime mart is correct (fast path).
  // NOTE: dim_people has no last_seen column, so the previous WHERE clause
  // threw and the page silently showed lifetime data via catch() fallback.
  if (!since) {
    return query(`SELECT * FROM dim_people ORDER BY total_cost DESC`)
  }
  // Range filter: read from pre-aggregated int_entity_spend (date-grain table).
  // agents[] and apps[] chip arrays are not in int_entity_spend; fall back to
  // dim_people for those columns (lifetime data) — the filter affects the KPI
  // numbers only. The page renders chips from dim_people regardless of range.
  return query(`
    SELECT
      es.entity_id                                AS person_id,
      ANY_VALUE(dp.person_name)                   AS person_name,
      SUM(es.session_count)                       AS session_count,
      NULL::BIGINT                                AS app_count,
      NULL::VARCHAR[]                             AS agents,
      NULL::VARCHAR[]                             AS apps,
      SUM(es.total_cost)                          AS total_cost,
      SUM(es.total_turns)                         AS total_turns,
      SUM(es.commits)                             AS total_commits
    FROM int_entity_spend es
    LEFT JOIN dim_people dp ON dp.person_id = es.entity_id
    WHERE es.entity_type = 'person'
      AND es.date >= '${since}'::DATE
    GROUP BY es.entity_id
    ORDER BY total_cost DESC NULLS LAST
  `)
}

export async function getPerson(personId: string) {
  return queryOne(`SELECT * FROM dim_people WHERE person_id = ?`, [personId])
}

export async function getPersonSessions(personId: string, since: string | null = null) {
  const sinceClause = since ? ` AND start_ts >= '${since}'` : ''
  return query(`
    SELECT session_id, start_ts, end_ts, cwd, agent, session_title,
           status, turn_count, total_cost, commits
    FROM dim_sessions WHERE person_id = ?${sinceClause} ORDER BY start_ts DESC LIMIT 20
  `, [personId])
}

export async function getPersonAgents(personId: string, since: string | null = null) {
  // Fast path: lifetime mart.
  if (!since) {
    return query(`
      SELECT ds.agent,
             COUNT(DISTINCT ds.session_id) AS session_count,
             SUM(ds.turn_count)            AS total_turns,
             SUM(ds.total_cost)            AS total_cost
      FROM dim_sessions ds
      WHERE ds.person_id = ?
        AND ds.agent IS NOT NULL
      GROUP BY ds.agent
      ORDER BY total_cost DESC
    `, [personId])
  }
  // Range path: join fact_model_calls for accurate date-filtered cost.
  return query(`
    SELECT
      fmc.agent,
      COUNT(DISTINCT fmc.session_id)   AS session_count,
      SUM(ds.turn_count)               AS total_turns,
      SUM(fmc.calculated_cost)         AS total_cost
    FROM fact_model_calls fmc
    JOIN dim_sessions ds ON ds.session_id = fmc.session_id
    WHERE ds.person_id = ?
      AND CAST(fmc.ts AS DATE) >= ?::DATE
      AND fmc.agent IS NOT NULL
    GROUP BY fmc.agent
    ORDER BY total_cost DESC
  `, [personId, since])
}

export async function getPersonApps(personId: string, since: string | null = null) {
  // Fast path: lifetime mart.
  if (!since) {
    return query(`
      SELECT da.app_id,
             COALESCE(da.app_name, da.app_id) AS app_name,
             COUNT(DISTINCT ds.session_id)    AS session_count,
             SUM(ds.turn_count)               AS total_turns,
             SUM(ds.total_cost)               AS total_cost
      FROM dim_sessions ds
      INNER JOIN dim_apps da ON da.cwd = ds.cwd
      WHERE ds.person_id = ?
        AND da.app_id IS NOT NULL
      GROUP BY da.app_id, da.app_name
      ORDER BY total_cost DESC
    `, [personId])
  }
  // Range path: join fact_model_calls for accurate date-filtered cost.
  return query(`
    SELECT
      da.app_id,
      COALESCE(da.app_name, da.app_id)  AS app_name,
      COUNT(DISTINCT fmc.session_id)    AS session_count,
      SUM(ds.turn_count)                AS total_turns,
      SUM(fmc.calculated_cost)          AS total_cost
    FROM fact_model_calls fmc
    JOIN dim_sessions ds ON ds.session_id = fmc.session_id
    INNER JOIN dim_apps da ON da.cwd = ds.cwd
    WHERE ds.person_id = ?
      AND CAST(fmc.ts AS DATE) >= ?::DATE
      AND da.app_id IS NOT NULL
    GROUP BY da.app_id, da.app_name
    ORDER BY total_cost DESC
  `, [personId, since])
}

export async function getPersonPrompts(personId: string, limit = 8, since: string | null = null) {
  const sinceClause = since ? ` AND ds.start_ts >= '${since}'` : ''
  return query(`
    SELECT fp.prompt_ts, fp.prompt_text_200, fp.agent, fp.app_id,
           fp.turn_count, fp.tool_call_count, fp.files_edited, fp.cost_total
    FROM fact_prompts fp
    JOIN dim_sessions ds USING (session_id)
    WHERE ds.person_id = ?${sinceClause}
    ORDER BY fp.prompt_ts DESC
    LIMIT ?
  `, [personId, limit])
}

/**
 * Range-aware aggregates for the person header KPIs. When `since` is null we
 * return null so the page falls back to the lifetime mart (`dim_people`).
 * When set, we re-aggregate from dim_sessions in the same shape dim_people
 * exposes, so the detail page can swap them in-place.
 */
export async function getPersonRangeAggregates(personId: string, since: string | null) {
  if (!since) return null
  const [agg, commitRow] = await Promise.all([
    queryOne(`
      SELECT
        SUM(es.session_count)  AS session_count,
        SUM(es.total_turns)    AS total_turns,
        SUM(es.total_cost)     AS total_cost,
        NULL::BIGINT           AS total_output_tokens
      FROM int_entity_spend es
      WHERE es.entity_type = 'person'
        AND es.entity_id = ?
        AND es.date >= ?::DATE
    `, [personId, since]),
    queryOne(`
      SELECT COALESCE(SUM(commits), 0) AS total_commits
      FROM dim_sessions
      WHERE person_id = ?
        AND CAST(start_ts AS DATE) >= ?::DATE
    `, [personId, since]),
  ])
  if (!agg) return null
  return { ...agg, total_commits: commitRow?.total_commits ?? 0 }
}
