{{ config(materialized='table') }}

-- The frontend appends one JSON line per verdict POST to the inbox file
-- (spec §2.4); the latest line per session wins. ignore_errors turns a torn
-- last line into an all-NULL row, which the WHERE removes.
WITH inbox AS (
    SELECT *
    FROM read_json(
        '{{ env_var("AURA_VERDICTS_INBOX", "/data/inbox/verdicts-inbox.jsonl") }}',
        format = 'newline_delimited',
        ignore_errors = true,
        columns = {tenant_id: 'VARCHAR', session_id: 'VARCHAR', verdict: 'VARCHAR', note: 'VARCHAR', created_at: 'VARCHAR'}
    )
)
SELECT
    COALESCE(tenant_id, 'local')                               AS tenant_id,
    session_id,
    verdict,
    left(note, 500)                                            AS note,
    TRY_CAST(created_at AS TIMESTAMPTZ) AT TIME ZONE 'UTC'     AS created_at
FROM inbox
WHERE session_id IS NOT NULL
  AND verdict IN ('accepted', 'wrong', 'needs_review')
QUALIFY row_number() OVER (
    PARTITION BY COALESCE(tenant_id, 'local'), session_id
    ORDER BY TRY_CAST(created_at AS TIMESTAMPTZ) DESC NULLS LAST
) = 1
