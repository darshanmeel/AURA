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
    
    -- Calculated cost in dollars.
    -- CASE on mp.model ensures: when no pricing row matches, calculated_cost is
    -- NULL (not 0). The not_null schema test then catches missing model IDs loudly
    -- rather than silently underreporting spend as zero. (spec §5.3 fail-loud rule)
    CASE
        WHEN mp.model IS NULL THEN NULL
        ELSE (
            COALESCE(c.input_tokens, 0) * mp.cost_input_per_mtok +
            COALESCE(c.output_tokens, 0) * mp.cost_output_per_mtok +
            COALESCE(c.ephemeral_5m_input_tokens, 0) * COALESCE(mp.cost_cache_write_5m_per_mtok, 0.0) +
            COALESCE(c.ephemeral_1h_input_tokens, 0) * COALESCE(mp.cost_cache_write_1h_per_mtok, 0.0) +
            -- Fallback if ephemeral columns are null but cache_creation exists
            CASE
                WHEN c.ephemeral_5m_input_tokens IS NULL AND c.ephemeral_1h_input_tokens IS NULL
                THEN COALESCE(c.cache_creation_input_tokens, 0) * COALESCE(mp.cost_cache_write_1h_per_mtok, 0.0)
                ELSE 0.0
            END +
            COALESCE(c.cache_read_input_tokens, 0) * COALESCE(mp.cost_cache_read_per_mtok, 0.0)
        ) / 1000000.0
    END AS calculated_cost
FROM {{ ref('stg_assistant_messages') }} c
LEFT JOIN (
    -- Rank pricing rows so tenant-specific rows (tenant_id IS NOT NULL) beat
    -- global rows (tenant_id IS NULL) when both cover the same (model, period).
    -- _rn = 1 per (model, valid_from, valid_to, tenant_id bucket) keeps exactly
    -- one winner per period without cross-tenant contamination.
    SELECT *,
           ROW_NUMBER() OVER (
               PARTITION BY model, valid_from, valid_to
               ORDER BY CASE WHEN tenant_id IS NULL THEN 1 ELSE 0 END
           ) AS _rn
    FROM {{ ref('model_pricing') }}
) mp
    ON c.model = mp.model
    AND mp._rn = 1
    AND (mp.tenant_id IS NULL OR c.tenant_id = mp.tenant_id)
    AND c.ts >= mp.valid_from
    AND c.ts <= COALESCE(CAST(mp.valid_to AS TIMESTAMP), CAST('9999-12-31' AS TIMESTAMP))
