{{ config(materialized='table') }}

WITH session_stats AS (
    SELECT
        tenant_id,
        session_id,
        MIN(COALESCE(user_ts, assistant_ts))    AS start_ts,
        MAX(assistant_ts)                        AS end_ts,
        model,
        cwd,
        project_id,
        git_branch,
        claude_version,
        COUNT(*)                                 AS turn_count,
        SUM(calculated_cost)                     AS total_cost,
        SUM(input_tokens)                        AS total_input_tokens,
        SUM(output_tokens)                       AS total_output_tokens,
        SUM(ephemeral_5m_input_tokens)           AS ephemeral_5m_total,
        SUM(ephemeral_1h_input_tokens)           AS ephemeral_1h_total,
        SUM(cache_read_input_tokens)             AS cache_read_total
    FROM {{ ref('fact_turns') }}
    GROUP BY tenant_id, session_id, model, cwd, project_id, git_branch, claude_version
),
aggregated_sessions AS (
    SELECT
        tenant_id,
        session_id,
        MIN(start_ts)                            AS start_ts,
        MAX(end_ts)                              AS end_ts,
        ANY_VALUE(model)                         AS model,
        ANY_VALUE(cwd)                           AS cwd,
        ANY_VALUE(project_id)                    AS project_id,
        ANY_VALUE(git_branch)                    AS git_branch,
        ANY_VALUE(claude_version)                AS claude_version,
        SUM(turn_count)                          AS turn_count,
        SUM(total_cost)                          AS total_cost,
        SUM(total_input_tokens)                  AS total_input_tokens,
        SUM(total_output_tokens)                 AS total_output_tokens,
        SUM(ephemeral_5m_total)                  AS ephemeral_5m_total,
        SUM(ephemeral_1h_total)                  AS ephemeral_1h_total,
        SUM(cache_read_total)                    AS cache_read_total
    FROM session_stats
    GROUP BY tenant_id, session_id
),
tool_stats AS (
    SELECT session_id, COUNT(*) AS tools_used
    FROM {{ ref('fact_tool_executions') }}
    GROUP BY session_id
),
end_turn_stats AS (
    SELECT session_id, COUNT(*) AS end_turns
    FROM {{ ref('stg_events') }}
    WHERE stop_reason = 'end_turn'
    GROUP BY session_id
),
file_stats AS (
    SELECT session_id, COUNT(DISTINCT file_path) AS files_touched
    FROM {{ ref('fact_session_files') }}
    GROUP BY session_id
),
agent_per_session AS (
    SELECT session_id, ANY_VALUE(agent) AS agent
    FROM {{ ref('stg_events') }}
    GROUP BY session_id
),
skills_per_session AS (
    SELECT 
        session_id, 
        COUNT(DISTINCT skill_name) AS skill_count,
        array_agg(DISTINCT skill_name) AS skills_loaded
    FROM {{ ref('stg_session_skills') }}
    GROUP BY session_id
)
SELECT
    s.tenant_id,
    s.session_id,
    s.start_ts,
    s.end_ts,
    s.model,
    s.cwd,
    s.project_id,
    s.git_branch,
    s.claude_version,
    s.turn_count,
    s.total_cost,
    s.total_input_tokens,
    s.total_output_tokens,
    s.ephemeral_5m_total,
    s.ephemeral_1h_total,
    s.cache_read_total,
    COALESCE(t.tools_used, 0)      AS tools_used,
    COALESCE(e.end_turns, 0)       AS end_turns,
    COALESCE(f.files_touched, 0)   AS files_touched,
    sm.person_id,
    sm.person_name,
    COALESCE(sm.commits, 0)        AS commits,
    sm.session_title,
    CASE WHEN s.end_ts IS NULL THEN 'active' ELSE 'completed' END AS status,
    CASE
        WHEN s.model LIKE 'claude%'  THEN 'Anthropic'
        WHEN s.model LIKE 'gemini%'  THEN 'Google'
        ELSE 'Other'
    END                            AS provider,
    ag.agent,
    COALESCE(sk.skill_count, 0) AS skill_count,
    sk.skills_loaded
FROM aggregated_sessions s
LEFT JOIN tool_stats t      ON s.session_id = t.session_id
LEFT JOIN end_turn_stats e  ON s.session_id = e.session_id
LEFT JOIN file_stats f      ON s.session_id = f.session_id
LEFT JOIN agent_per_session ag ON s.session_id = ag.session_id
LEFT JOIN session_meta sm   ON s.session_id = sm.session_id
LEFT JOIN skills_per_session sk ON s.session_id = sk.session_id
