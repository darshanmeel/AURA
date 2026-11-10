{{ config(materialized='view') }}

-- One row per (tenant_id, uuid): the lake source minus the duplicate copies in
-- stg_lake_event_dups.
SELECT
    r.tenant_id,
    r.uuid,
    r.session_id,
    -- raw_events.project_id exists but holds path junk for nested files
    -- (subagents/, wf_...); project comes from int_app_cwd_lookup instead.
    NULL::VARCHAR  AS project_id,
    r.agent,
    r.source,
    r.reported_cost_usd,
    r.event_type,
    r.ts,
    r.file_path,
    r.byte_offset,
    r.parent_uuid,
    r.request_id,
    r.message_id,
    r.is_sidechain,
    r.stop_reason,
    r.cwd,
    r.git_branch,
    r.claude_version,
    r.model,
    r.input_tokens,
    r.output_tokens,
    r.cache_creation_input_tokens,
    r.ephemeral_5m_input_tokens,
    r.ephemeral_1h_input_tokens,
    r.cache_read_input_tokens,
    r.context_pct,
    -- Historical rows with invalid JSON exist: TRY_CAST nulls the payload so
    -- json_extract_* downstream returns NULL instead of throwing; the row stays.
    CASE WHEN TRY_CAST(r.payload AS JSON) IS NOT NULL THEN r.payload END AS payload,
    r.ingested_at,
    r."date"
FROM {{ source('lake', 'raw_events') }} r
ANTI JOIN {{ ref('stg_lake_event_dups') }} d
    USING (tenant_id, uuid, filename, file_row_number)
WHERE {{ lake_cutoff() }}
