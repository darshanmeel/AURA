{{ config(materialized='table') }}

SELECT
    c.tenant_id,
    c.uuid as event_uuid,
    c.session_id,
    c.agent,
    c.message_id as model_call_id,
    c.ts,
    c.model,
    c.input_tokens,
    c.output_tokens,
    c.cache_creation_input_tokens,
    c.ephemeral_5m_input_tokens,
    c.ephemeral_1h_input_tokens,
    c.cache_read_input_tokens,
    c.is_sidechain,
    
    -- Pricing calculations
    mp.cost_input_per_mtok,
    mp.cost_output_per_mtok,
    
    -- Calculated cost in dollars
    (
        COALESCE(c.input_tokens, 0) * COALESCE(mp.cost_input_per_mtok, 0.0) +
        COALESCE(c.output_tokens, 0) * COALESCE(mp.cost_output_per_mtok, 0.0) +
        COALESCE(c.ephemeral_5m_input_tokens, 0) * COALESCE(mp.cost_cache_write_5m_per_mtok, 0.0) +
        COALESCE(c.ephemeral_1h_input_tokens, 0) * COALESCE(mp.cost_cache_write_1h_per_mtok, 0.0) +
        -- Fallback if ephemeral columns are null but cache_creation exists
        CASE 
            WHEN c.ephemeral_5m_input_tokens IS NULL AND c.ephemeral_1h_input_tokens IS NULL 
            THEN COALESCE(c.cache_creation_input_tokens, 0) * COALESCE(mp.cost_cache_write_1h_per_mtok, 0.0)
            ELSE 0.0
        END +
        COALESCE(c.cache_read_input_tokens, 0) * COALESCE(mp.cost_cache_read_per_mtok, 0.0)
    ) / 1000000.0 as calculated_cost
FROM {{ ref('stg_assistant_messages') }} c
LEFT JOIN {{ ref('model_pricing') }} mp
    ON c.model = mp.model 
    AND (mp.tenant_id IS NULL OR c.tenant_id = mp.tenant_id)
    AND c.ts >= mp.valid_from 
    AND c.ts <= COALESCE(CAST(mp.valid_to AS TIMESTAMP), CAST('9999-12-31' AS TIMESTAMP))
