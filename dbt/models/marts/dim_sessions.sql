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
    GROUP BY tenant_id, session_id, cwd, project_id, git_branch, claude_version
),
aggregated_sessions AS (
    SELECT
        tenant_id,
        session_id,
        MIN(start_ts)                            AS start_ts,
        MAX(end_ts)                              AS end_ts,
        -- Pick the model responsible for the most cost in the session.
        -- model is no longer in the GROUP BY of session_stats, so each row
        -- carries its own model; ordering by total_cost DESC selects the
        -- dominant model deterministically.
        FIRST(model ORDER BY total_cost DESC)    AS model,
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
-- Resolved agent per session: mode (most common) for scalar back-compat,
-- plus full array of distinct resolved agents and count.
agent_per_session AS (
    SELECT
        e.tenant_id,
        e.session_id,
        -- Use resolved agent from int_event_agent; fall back to 'main'
        mode() WITHIN GROUP (ORDER BY COALESCE(ea.agent_resolved, 'main')) AS agent,
        array_distinct(
            array_agg(COALESCE(ea.agent_resolved, 'main'))
        )                                                                   AS agents,
        COUNT(DISTINCT COALESCE(ea.agent_resolved, 'main'))                 AS agent_count
    FROM {{ ref('stg_events') }} e
    LEFT JOIN {{ ref('int_event_agent') }} ea
        ON ea.tenant_id  = e.tenant_id
       AND ea.event_uuid = e.uuid
    GROUP BY e.tenant_id, e.session_id
),
-- First external user prompt per session (200-char truncation) for title fallback.
first_prompt AS (
    SELECT
        tenant_id,
        session_id,
        FIRST(
            SUBSTR(user_prompt, 1, 200)
            || CASE WHEN length(user_prompt) > 200 THEN '…' ELSE '' END
            ORDER BY user_ts
        )                                                                   AS first_prompt_200,
        FIRST(user_ts ORDER BY user_ts)                                     AS first_user_ts
    FROM {{ ref('int_turns') }}
    WHERE user_prompt IS NOT NULL
    GROUP BY tenant_id, session_id
),
-- App and project IDs from the cwd-parsing mart.
app_lookup AS (
    SELECT tenant_id, cwd, app_id, project_id AS app_project_id
    FROM {{ ref('dim_apps') }}
),
skills_per_session AS (
    SELECT
        session_id,
        COUNT(DISTINCT skill_name) AS skill_count,
        array_agg(DISTINCT skill_name) AS skills_loaded
    FROM {{ ref('stg_session_skills') }}
    GROUP BY session_id
),
-- Staged session_meta (person, commits, title).
session_meta_lookup AS (
    SELECT session_id, person_id, person_name, commits
    FROM {{ ref('stg_session_meta') }}
)
SELECT
    s.tenant_id,
    s.session_id,
    s.start_ts,
    s.end_ts,
    s.model,
    s.cwd,
    -- Prefer the parsed project_id from dim_apps; fall back to the raw column
    COALESCE(al.app_project_id, s.project_id)       AS project_id,
    al.app_id,
    s.git_branch,
    s.claude_version,
    s.turn_count,
    s.total_cost,
    s.total_input_tokens,
    s.total_output_tokens,
    s.ephemeral_5m_total,
    s.ephemeral_1h_total,
    s.cache_read_total,
    COALESCE(t.tools_used, 0)                       AS tools_used,
    COALESCE(e.end_turns, 0)                        AS end_turns,
    COALESCE(f.files_touched, 0)                    AS files_touched,
    -- Agent columns (resolved via int_event_agent)
    COALESCE(ag.agent, 'main')                      AS agent,
    ag.agents,
    COALESCE(ag.agent_count, 1)                     AS agent_count,
    -- session_title fallback: prompt preview → session_id
    COALESCE(fp.first_prompt_200, s.session_id)     AS session_title,
    -- person columns from session_meta; fallback to current-user defaults
    COALESCE(sm.person_id,   'darshan')             AS person_id,
    COALESCE(sm.person_name, 'Darshan Meel')        AS person_name,
    COALESCE(sm.commits, 0)                         AS commits,
    CASE WHEN s.end_ts IS NULL THEN 'active' ELSE 'completed' END AS status,
    CASE
        WHEN s.model LIKE 'claude%'  THEN 'Anthropic'
        WHEN s.model LIKE 'gemini%'  THEN 'Google'
        ELSE 'Other'
    END                                             AS provider,
    COALESCE(sk.skill_count, 0)                     AS skill_count,
    sk.skills_loaded
FROM aggregated_sessions s
LEFT JOIN tool_stats t          ON s.session_id = t.session_id
LEFT JOIN end_turn_stats e      ON s.session_id = e.session_id
LEFT JOIN file_stats f          ON s.session_id = f.session_id
LEFT JOIN agent_per_session ag  ON s.session_id = ag.session_id AND s.tenant_id = ag.tenant_id
LEFT JOIN first_prompt fp       ON s.session_id = fp.session_id AND s.tenant_id = fp.tenant_id
LEFT JOIN app_lookup al         ON al.cwd = s.cwd AND al.tenant_id = s.tenant_id
LEFT JOIN session_meta_lookup sm ON sm.session_id = s.session_id
LEFT JOIN skills_per_session sk ON s.session_id = sk.session_id
