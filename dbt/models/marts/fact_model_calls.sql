{{ config(materialized='table') }}

SELECT
    c.tenant_id,
    c.uuid as event_uuid,
    c.session_id,
    -- The watcher hardcodes raw_events.agent='claude' for every event (it was
    -- originally meant as a provider/platform tag). The real subagent is
    -- resolved in int_event_agent.agent_resolved (text-prefix classifier +
    -- is_sidechain heuristics). Use that here so downstream rollups
    -- (int_entity_spend, /agents, /tokens by agent) see the actual subagent
    -- name (technical-writer, frontend-engineer, code-reviewer, …) instead
    -- of every row collapsing into a single 'claude' bucket.
    COALESCE(ea.agent_resolved, 'main') AS agent,
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
    
    -- Calculated cost in dollars. Token categories are distinct (non-overlapping):
    -- input_tokens = base input (not cached), output_tokens = base output,
    -- cache_creation_input_tokens = tokens written to cache,
    -- cache_read_input_tokens = tokens read from cache
    CASE
        WHEN mp.model IS NULL THEN NULL
        ELSE (
            COALESCE(c.input_tokens, 0) * mp.cost_input_per_mtok +
            COALESCE(c.output_tokens, 0) * mp.cost_output_per_mtok +
            COALESCE(c.cache_creation_input_tokens, 0) * COALESCE(mp.cost_cache_write_1h_per_mtok, 0.0) +
            COALESCE(c.cache_read_input_tokens, 0) * COALESCE(mp.cost_cache_read_per_mtok, 0.0)
        ) / 1000000.0
    END AS calculated_cost
FROM {{ ref('stg_assistant_messages') }} c
LEFT JOIN {{ ref('int_event_agent') }} ea
    ON ea.tenant_id = c.tenant_id
   AND ea.event_uuid = c.uuid
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
