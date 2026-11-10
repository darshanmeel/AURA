{{ config(materialized='view') }}

WITH ranked AS (
    SELECT
        *,
        ROW_NUMBER() OVER (PARTITION BY tenant_id, message_id ORDER BY ts DESC, byte_offset DESC) as rn
    FROM {{ ref('stg_events') }}
    WHERE event_type = 'assistant' AND message_id IS NOT NULL
)
SELECT
    tenant_id,
    uuid,
    session_id,
    project_id,   -- will be NULL (not in raw_events; derived via dim_apps)
    agent,
    source,
    reported_cost_usd,
    ts,
    file_path,
    byte_offset,
    parent_uuid,
    request_id,
    message_id,
    is_sidechain,
    stop_reason,
    cwd,
    git_branch,
    claude_version,
    model,
    input_tokens,
    output_tokens,
    cache_creation_input_tokens,
    ephemeral_5m_input_tokens,
    ephemeral_1h_input_tokens,
    cache_read_input_tokens,
    -- Recomputed from the seed window so a model added to the seed later is fixed for old rows too.
    COALESCE((input_tokens + cache_creation_input_tokens + cache_read_input_tokens)
             / NULLIF(w.context_window_tokens, 0), context_pct) AS context_pct,
    payload
FROM ranked
LEFT JOIN (SELECT model AS w_model, MAX(context_window_tokens) AS context_window_tokens
           FROM {{ ref('model_pricing') }} WHERE valid_to IS NULL GROUP BY model) w
    ON w.w_model = ranked.model
WHERE ranked.rn = 1
