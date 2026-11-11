{{ config(
    materialized='incremental',
    incremental_strategy='delete+insert',
    unique_key=['tenant_id', 'session_id']
) }}

-- One row per (tenant_id, uuid): the lake source minus the duplicate copies in
-- stg_lake_event_dups. A table, not a view: a view re-read the lake, re-checked
-- the JSON and re-ran the dedup ANTI JOIN for each of its ~20 references per
-- cycle. The JSON fields the models filter on are extracted here once.
-- Incremental per session (recent_sessions cursor): duplicates of an event land
-- in the same session, so recomputing a whole session keeps the dedup exact.
WITH
{% if is_incremental() %}
recent_sessions AS ({{ recent_sessions() }}),
{% endif %}
src AS (
    SELECT
        r.*,
        -- Historical rows with invalid JSON exist: TRY_CAST nulls the payload so
        -- json_extract_* returns NULL instead of throwing; the row stays.
        CASE WHEN TRY_CAST(r.payload AS JSON) IS NOT NULL THEN r.payload END AS valid_payload
    FROM {{ source('lake', 'raw_events') }} r
    {% if is_incremental() %}
    SEMI JOIN recent_sessions rs
        ON  rs.tenant_id  = r.tenant_id
        AND rs.session_id = r.session_id
    {% endif %}
    ANTI JOIN {{ ref('stg_lake_event_dups') }} d
        USING (tenant_id, uuid, filename, file_row_number)
    WHERE {{ lake_cutoff() }}
),
parsed AS (
    SELECT
        *,
        -- One parse for all string fields.
        json_extract_string(valid_payload, [
            '$.userType', '$.isMeta', '$.message.content', '$.sourceToolAssistantUUID',
            '$.toolUseResult.text', '$.toolUseResult.isError', '$.toolUseResult.agentId'
        ]) AS f
    FROM src
)
SELECT
    tenant_id,
    uuid,
    session_id,
    -- raw_events.project_id exists but holds path junk for nested files
    -- (subagents/, wf_...); project comes from int_app_cwd_lookup instead.
    NULL::VARCHAR  AS project_id,
    agent,
    source,
    reported_cost_usd,
    event_type,
    ts,
    file_path,
    byte_offset,
    parent_uuid,
    request_id,
    message_id,
    is_sidechain,
    stop_reason,
    cwd,
    git_branch,
    claude_version,
    model,
    input_tokens,
    output_tokens,
    cache_creation_input_tokens,
    ephemeral_5m_input_tokens,
    ephemeral_1h_input_tokens,
    cache_read_input_tokens,
    context_pct,
    valid_payload                AS payload,
    f[1]                         AS user_type,
    f[2]                         AS is_meta,
    -- The prompt string, or the JSON text of a content array (starts with '[').
    f[3]                         AS content_text,
    f[4]                         AS source_tool_assistant_uuid,
    json_extract(valid_payload, '$.toolUseResult') IS NOT NULL AS has_tool_use_result,
    f[5]                         AS tool_use_result_text,
    f[6]                         AS tool_use_result_is_error,
    f[7]                         AS tool_use_result_agent_id,
    ingested_at,
    "date",
    {{ built_at() }}             AS _built_at
FROM parsed
