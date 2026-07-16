{{ config(materialized='table') }}

SELECT
    tenant_id,
    CAST(ts AS DATE) as date,
    agent,
    model,
    CASE
        WHEN model LIKE 'claude%'  THEN 'Anthropic'
        WHEN model LIKE 'gemini%'  THEN 'Google'
        ELSE 'Other'
    END                          AS provider,
    SUM(calculated_cost) as daily_cost,
    SUM(input_tokens) as daily_input_tokens,
    SUM(output_tokens) as daily_output_tokens,
    SUM(cache_read_input_tokens)              AS daily_cache_read_tokens,
    -- D-L5: cache-write token breakdown for cache-economics observability.
    -- daily_cost already includes these; these columns are additive detail only.
    -- ephemeral_5m / ephemeral_1h are NULL for logs predating the breakdown field;
    -- daily_cache_creation_tokens = their sum in that case (backward-compatible).
    SUM(cache_creation_input_tokens)          AS daily_cache_creation_tokens,
    SUM(ephemeral_5m_input_tokens)            AS daily_ephemeral_5m_tokens,
    SUM(ephemeral_1h_input_tokens)            AS daily_ephemeral_1h_tokens,
    COUNT(DISTINCT session_id) as session_count,
    COUNT(*) as turn_count
FROM {{ ref('fact_model_calls') }}
GROUP BY tenant_id, CAST(ts AS DATE), agent, model,
    CASE
        WHEN model LIKE 'claude%'  THEN 'Anthropic'
        WHEN model LIKE 'gemini%'  THEN 'Google'
        ELSE 'Other'
    END
