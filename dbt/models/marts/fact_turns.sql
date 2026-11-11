{{ config(
    materialized='incremental',
    incremental_strategy='delete+insert',
    unique_key=['tenant_id', 'turn_id']
) }}
-- Incremental: each cycle rebuilds only turns of sessions with new lake rows
-- (recent_sessions macro); a full refresh gives the same rows as the old table.

-- tool_count: one assistant message is streamed as several events, each with its
-- own uuid, and a tool_use block can repeat across them. Count distinct
-- tool_use_id per message_id (= turn_id) so no block is missed or double counted.
WITH
{% if is_incremental() %}
recent_sessions AS ({{ recent_sessions() }}),
{% endif %}
tool_counts AS (
    SELECT
        tc.tenant_id,
        tc.message_id,
        COUNT(DISTINCT tc.tool_use_id) as tool_count
    FROM {{ ref('stg_tool_calls') }} tc
    {% if is_incremental() %}
    JOIN recent_sessions rs ON rs.tenant_id = tc.tenant_id AND rs.session_id = tc.session_id
    {% endif %}
    GROUP BY tc.tenant_id, tc.message_id
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
    -- NULL when the model has no pricing row (fail loud, same as fact_model_calls).
    mc.calculated_cost,
    mc.stop_reason,
    {{ built_at() }} AS _built_at
FROM {{ ref('int_turns') }} t
    {% if is_incremental() %}
    JOIN recent_sessions rs ON rs.tenant_id = t.tenant_id AND rs.session_id = t.session_id
    {% endif %}
LEFT JOIN tool_counts tc
    ON t.turn_id = tc.message_id AND t.tenant_id = tc.tenant_id
LEFT JOIN {{ ref('fact_model_calls') }} mc
    ON t.turn_id = mc.model_call_id AND t.tenant_id = mc.tenant_id
