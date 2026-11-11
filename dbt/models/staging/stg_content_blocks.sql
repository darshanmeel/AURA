{{ config(
    materialized='incremental',
    incremental_strategy='delete+insert',
    unique_key=['tenant_id', 'session_id']
) }}

-- One row per message.content block of a user or assistant event: the one place
-- content arrays are unnested and parsed. stg_tool_calls, stg_tool_results,
-- stg_thinking_blocks and the first-text lookups read these columns.
-- block_idx is the 0-based position in the array. Events whose content is a
-- string (typed prompts) have no blocks; their text is stg_events.content_text.
WITH
{% if is_incremental() %}
recent_sessions AS ({{ recent_sessions() }}),
{% endif %}
events AS (
    SELECT
        e.tenant_id, e.uuid, e.session_id, e.event_type, e.ts, e.byte_offset,
        e.message_id, e.is_sidechain, e.model, e.cwd,
        TRY_CAST(json_extract(e.payload, '$.message.content') AS JSON[]) AS items
    FROM {{ ref('stg_events') }} e
    {% if is_incremental() %}
    SEMI JOIN recent_sessions rs
        ON  rs.tenant_id  = e.tenant_id
        AND rs.session_id = e.session_id
    {% endif %}
    WHERE e.event_type IN ('assistant', 'user')
      AND starts_with(e.content_text, '[')
),
-- Unnest in the SELECT list: a lateral UNNEST is decorrelated into a join keyed
-- on the whole payload.
blocks AS (
    SELECT
        * EXCLUDE (items),
        unnest(items)                               AS blk,
        unnest(range(len(items)))                   AS block_idx
    FROM events
),
fields AS (
    SELECT
        * EXCLUDE (blk),
        json_extract_string(blk, [
            '$.type', '$.id', '$.name', '$.tool_use_id', '$.content', '$.is_error',
            '$.text', '$.thinking', '$.signature'
        ])                                          AS f,
        blk
    FROM blocks
)
SELECT
    tenant_id,
    session_id,
    uuid                                            AS event_uuid,
    event_type,
    ts,
    byte_offset,
    message_id,
    is_sidechain,
    model,
    cwd,
    block_idx,
    f[1]                                            AS block_type,
    -- tool_use blocks carry their own id; tool_result blocks point back to it.
    CASE WHEN f[1] = 'tool_use' THEN f[2] ELSE f[4] END AS tool_use_id,
    f[3]                                            AS tool_name,
    CASE WHEN f[1] = 'tool_use' THEN json_extract(blk, '$.input') END AS tool_input,
    f[5]                                            AS result_text,
    f[6] = 'true'                                   AS is_error,
    f[7]                                            AS text,
    f[8]                                            AS thinking,
    f[9]                                            AS signature,
    {{ built_at() }}                                AS _built_at
FROM fields
