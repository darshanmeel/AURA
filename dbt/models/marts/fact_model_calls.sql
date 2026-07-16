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
    c.source,
    c.reported_cost_usd,

    -- Pricing calculations
    mp.cost_input_per_mtok,
    mp.cost_output_per_mtok,
    
    -- Calculated cost in dollars. Token categories are distinct (non-overlapping):
    -- input_tokens = base input (not cached), output_tokens = base output,
    -- cache_creation_input_tokens = tokens written to cache (total of 5m + 1h slices),
    -- cache_read_input_tokens = tokens read from cache.
    --
    -- Cache-write split: when ephemeral_5m/1h are present each slice is priced at its
    -- own rate; the residual term handles older logs where the breakdown is absent
    -- (ephemeral_5m/1h NULL => residual = full cache_creation_input_tokens, priced at
    -- the 1h rate — identical to previous behaviour and therefore backward-compatible).
    CASE
        -- sdk_trace: bypass token pricing entirely and use the verbatim run cost
        -- (result.total_cost_usd) the watcher recorded in reported_cost_usd. Only the
        -- result-merged assistant row carries a non-null value; earlier 'message' turns
        -- in the same sdk_trace session have NULL reported_cost_usd, so COALESCE(...,0)
        -- maps them to 0 (keeping the not_null test green and the session total exact).
        WHEN c.source = 'sdk_trace' THEN COALESCE(c.reported_cost_usd, 0)
        WHEN mp.model IS NULL THEN NULL
        ELSE (
            COALESCE(c.input_tokens, 0) * mp.cost_input_per_mtok +
            COALESCE(c.output_tokens, 0) * mp.cost_output_per_mtok +
            -- 5-minute cache-write slice
            COALESCE(c.ephemeral_5m_input_tokens, 0) * COALESCE(mp.cost_cache_write_5m_per_mtok, 0.0) +
            -- 1-hour cache-write slice
            COALESCE(c.ephemeral_1h_input_tokens, 0) * COALESCE(mp.cost_cache_write_1h_per_mtok, 0.0) +
            -- Residual: zero when breakdown is present; equals total when breakdown is absent
            (COALESCE(c.cache_creation_input_tokens, 0) - COALESCE(c.ephemeral_5m_input_tokens, 0) - COALESCE(c.ephemeral_1h_input_tokens, 0)) * COALESCE(mp.cost_cache_write_1h_per_mtok, 0.0) +
            COALESCE(c.cache_read_input_tokens, 0) * COALESCE(mp.cost_cache_read_per_mtok, 0.0)
        ) / 1000000.0
    END AS calculated_cost
FROM {{ ref('stg_assistant_messages') }} c
LEFT JOIN {{ ref('int_event_agent') }} ea
    ON ea.tenant_id = c.tenant_id
   AND ea.event_uuid = c.uuid
-- D-H5: model ID coverage — if a model ID present in raw_events has no
-- matching row in model_pricing.csv (e.g. a future version-suffixed ID such
-- as claude-sonnet-4-5-20251219), the LEFT JOIN produces a NULL mp.model row,
-- and the CASE guard above maps that to NULL calculated_cost.  The schema.yml
-- not_null test on fact_model_calls.calculated_cost catches this loudly in CI.
-- Operational remedy: add the missing seed row to dbt/seeds/model_pricing.csv.
-- Diagnostic query to find the gap:
--   SELECT DISTINCT model FROM raw_events
--   WHERE model NOT IN (SELECT model FROM model_pricing);
LEFT JOIN {{ ref('model_pricing') }} mp
    ON c.model = mp.model
    AND (mp.tenant_id IS NULL OR mp.tenant_id = c.tenant_id)
    AND c.ts >= mp.valid_from
    AND c.ts <= COALESCE(CAST(mp.valid_to AS TIMESTAMP), CAST('9999-12-31' AS TIMESTAMP))
-- D-C1: per-call tenant-correct pricing selection.
-- The LEFT JOIN above admits two candidate rows per call when both a tenant-specific
-- row (tenant_id = c.tenant_id) AND a global row (tenant_id IS NULL) cover the
-- same (model, period). QUALIFY keeps exactly one: the tenant-specific row
-- (sort key = 0) beats the global row (sort key = 1).
-- When no pricing row matches at all the LEFT JOIN produces a single NULL-filled
-- row; it gets rank 1 and is kept; calculated_cost guards on mp.model IS NULL.
QUALIFY ROW_NUMBER() OVER (
    PARTITION BY c.tenant_id, c.message_id
    ORDER BY CASE WHEN mp.tenant_id IS NULL THEN 1 ELSE 0 END
) = 1
