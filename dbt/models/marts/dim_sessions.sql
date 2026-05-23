{{ config(materialized='table') }}

WITH session_stats AS (
    SELECT
        tenant_id,
        session_id,
        MIN(COALESCE(user_ts, assistant_ts)) as start_ts,
        MAX(assistant_ts) as end_ts,
        model,
        cwd as project,
        git_branch,
        claude_version,
        COUNT(*) as turn_count,
        SUM(calculated_cost) as total_cost,
        SUM(input_tokens) as total_input_tokens,
        SUM(output_tokens) as total_output_tokens
    FROM {{ ref('fact_turns') }}
    GROUP BY tenant_id, session_id, model, cwd, git_branch, claude_version
),
aggregated_sessions AS (
    SELECT
        tenant_id,
        session_id,
        MIN(start_ts) as start_ts,
        MAX(end_ts) as end_ts,
        ANY_VALUE(model) as model,
        ANY_VALUE(project) as project,
        ANY_VALUE(git_branch) as git_branch,
        ANY_VALUE(claude_version) as claude_version,
        SUM(turn_count) as turn_count,
        SUM(total_cost) as total_cost,
        SUM(total_input_tokens) as total_input_tokens,
        SUM(total_output_tokens) as total_output_tokens
    FROM session_stats
    GROUP BY tenant_id, session_id
)
SELECT * FROM aggregated_sessions
