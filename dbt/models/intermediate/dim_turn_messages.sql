{{ config(materialized='view') }}

-- dim_turn_messages: thin passthrough view carrying the large per-turn text
-- columns (user_prompt, assistant_response) from int_turns. Split out of
-- fact_turns to avoid materializing those columns (ASOF-joined user_prompt +
-- 20-position content-block COALESCE for assistant_response) into a `table`
-- mart, which exhausted DuckDB's memory pool. Kept as a VIEW deliberately —
-- materializing this as a table would reintroduce the same OOM.
-- Extraction logic lives exactly once, in int_turns; do not re-derive it here.
SELECT
    tenant_id,
    session_id,
    turn_id,
    user_event_uuid,
    assistant_event_uuid,
    user_prompt,
    assistant_response
FROM {{ ref('int_turns') }}
