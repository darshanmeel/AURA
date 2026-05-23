{{ config(materialized='table') }}

WITH tool_counts AS (
    SELECT
        tenant_id,
        event_uuid,
        COUNT(*) as tool_count
    FROM {{ ref('stg_tool_calls') }}
    GROUP BY tenant_id, event_uuid
)
SELECT
    t.tenant_id,
    t.session_id,
    t.turn_number,
    t.turn_id,
    t.user_event_uuid,
    t.assistant_event_uuid,
    t.user_ts,
    t.assistant_ts,
    t.user_prompt,
    t.assistant_response,
    t.cwd,
    t.project_id,
    t.git_branch,
    t.claude_version,
    t.model,
    t.input_tokens,
    t.output_tokens,
    t.cache_creation_input_tokens,
    t.ephemeral_5m_input_tokens,
    t.ephemeral_1h_input_tokens,
    t.cache_read_input_tokens,
    t.context_pct,
    t.is_sidechain,
    COALESCE(tc.tool_count, 0) as tool_count,
    COALESCE(mc.calculated_cost, 0.0) as calculated_cost
FROM {{ ref('int_turns') }} t
LEFT JOIN tool_counts tc
    ON t.assistant_event_uuid = tc.event_uuid AND t.tenant_id = tc.tenant_id
LEFT JOIN {{ ref('fact_model_calls') }} mc
    ON t.turn_id = mc.model_call_id AND t.tenant_id = mc.tenant_id
