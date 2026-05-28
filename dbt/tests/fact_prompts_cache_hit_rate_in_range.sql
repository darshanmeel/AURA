-- Asserts cache_hit_rate is bounded to [0, 1]. Fails loud if any prompt
-- yields a NaN / negative / >1 value (e.g., from a future schema change
-- that lets cache_read exceed total_input on a partially-counted span).

SELECT
    prompt_id,
    cache_hit_rate
FROM {{ ref('fact_prompts') }}
WHERE cache_hit_rate IS NULL
   OR cache_hit_rate < 0
   OR cache_hit_rate > 1
