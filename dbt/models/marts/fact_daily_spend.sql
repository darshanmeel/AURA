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
    SUM(cache_read_input_tokens) as daily_cache_read_tokens,
    COUNT(DISTINCT session_id) as session_count,
    COUNT(*) as turn_count
FROM {{ ref('fact_model_calls') }}
GROUP BY tenant_id, CAST(ts AS DATE), agent, model,
    CASE
        WHEN model LIKE 'claude%'  THEN 'Anthropic'
        WHEN model LIKE 'gemini%'  THEN 'Google'
        ELSE 'Other'
    END
