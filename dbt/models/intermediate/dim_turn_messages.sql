{{ config(
    materialized='incremental',
    incremental_strategy='delete+insert',
    unique_key=['tenant_id', 'turn_id']
) }}

-- dim_turn_messages: the large per-turn text (user_prompt, assistant_response)
-- from int_turns, stored as a table so the publish step can copy it into the
-- read DB (which holds no views) and the session page reads one pre-sorted
-- table. Kept out of fact_turns on purpose.
--
-- The OOM noted in the old header came from materializing this text inside
-- fact_turns in one unscoped pass. Incremental runs here are scoped to
-- recent_sessions(), so they are bounded. The first (full) build is unscoped
-- and is measured in spec §6.2. Extraction logic lives in int_turns only.
WITH
{% if is_incremental() %}
recent_sessions AS ({{ recent_sessions() }}),
{% endif %}
turns AS (
    SELECT t.*
    FROM {{ ref('int_turns') }} t
    {% if is_incremental() %}
    JOIN recent_sessions rs
        ON  rs.tenant_id  = t.tenant_id
        AND rs.session_id = t.session_id
    {% endif %}
)
SELECT
    tenant_id,
    session_id,
    turn_id,
    user_event_uuid,
    assistant_event_uuid,
    user_prompt,
    assistant_response,
    {{ built_at() }} AS _built_at
FROM turns
ORDER BY tenant_id, session_id
