{{ config(materialized='view') }}

-- real_user_prompts: one row per genuine human-typed prompt in a session.
-- Excludes:
--   - tool_result containers (content starts with '[')
--   - isMeta=true events (claude-internal compact-summary events)
--   - sidechain user events (is_sidechain=true) — dispatch payloads from MAIN to
--     subagents. Including these caused them to "leak" via the ASOF JOIN into the
--     non-sidechain parent turn immediately after the sidechain completed, producing
--     duplicate display of the dispatch text (once as CLAUDE→SUBAGENT, again as
--     USER→CLAUDE). Sidechain assistant turns now receive user_prompt=NULL, which
--     is correct: the dispatch text is already shown as the parent's tool-call side.
--
-- user_prompt extraction: plain-string content only. A prompt whose content
-- is an array (a text block next to an image or attachment) is dropped by the
-- '[' shape filter below; fact_prompts drops the same prompts (Q4). Measure the share before changing
-- it (spec §6.2); if it is > 1 %, take the first text block of array content:
--   SELECT avg(CASE WHEN json_type(payload, '$.message.content') = 'ARRAY'
--                    AND list_contains(json_extract_string(payload, '$.message.content[*].type'), 'text')
--              THEN 1 ELSE 0 END)
--   FROM stg_events
--   WHERE event_type = 'user' AND NOT is_sidechain
--     AND json_extract_string(payload, '$.userType') = 'external'
WITH real_user_prompts AS (
    SELECT
        tenant_id,
        session_id,
        uuid         AS user_event_uuid,
        ts           AS user_ts,
        content_text AS user_prompt
    FROM {{ ref('stg_events') }}
    WHERE event_type = 'user'
      AND user_type = 'external'
      AND COALESCE(is_meta, 'false') != 'true'
      AND substr(trim(COALESCE(content_text, '')), 1, 1) != '['
      -- Exclude sidechain user events from the ASOF JOIN pool.
      -- When MAIN dispatches a subagent, the dispatch payload is written as a
      -- sidechain user event (is_sidechain=true). Including it in real_user_prompts
      -- causes it to "leak" into the non-sidechain assistant turn immediately after
      -- the sidechain completes (the ASOF JOIN picks up the sidechain event as the
      -- "most recent" prompt for that parent-thread turn), producing a duplicate:
      --   #024 CLAUDE → SUBAGENT  ← sidechain turn, user_prompt = dispatch text
      --   #025 USER → CLAUDE      ← parent turn, user_prompt = same dispatch text
      -- Excluding sidechain events means parent turns receive the last real human
      -- prompt instead; sidechain turns receive user_prompt = NULL (no bubble),
      -- which is correct — the dispatch is already visible as the parent's tool call.
      AND is_sidechain = FALSE
    -- Prompts sharing a ts: keep one (the same one fact_prompts gives the span).
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY tenant_id, session_id, ts ORDER BY uuid DESC
    ) = 1
),

-- First text block of each assistant event (positions 0-19, as before).
first_text AS (
    SELECT tenant_id, event_uuid, arg_min(text, block_idx) AS assistant_response
    FROM {{ ref('stg_content_blocks') }}
    WHERE event_type = 'assistant' AND block_type = 'text'
      AND text IS NOT NULL AND block_idx < 20
    GROUP BY tenant_id, event_uuid
)

-- turns_base: one row per assistant turn with user prompt attached via ASOF JOIN.
-- All columns here are passed through unchanged by the outer SELECT; the outer
-- layer adds compaction_inferred which requires a LAG over the same partition.
-- The CTE boundary is necessary because ASOF JOIN does not allow window functions
-- referencing the join's right-side columns in the same SELECT.
, turns_base AS (
    SELECT
        a.tenant_id,
        a.session_id,
        a.project_id,
        ROW_NUMBER() OVER (PARTITION BY a.tenant_id, a.session_id ORDER BY a.ts, a.message_id) AS turn_number,
        a.message_id                    AS turn_id,
        u.user_event_uuid,
        a.uuid                          AS assistant_event_uuid,
        u.user_ts,
        a.ts                            AS assistant_ts,
        -- user_prompt: attached via ASOF JOIN — the most recent real user prompt
        -- at or before the assistant message timestamp in the same session.
        -- parent_uuid was previously used for this join but it points to whatever
        -- event immediately preceded the assistant turn (usually a tool_result user
        -- event or another assistant event in a tool-use chain), so ~all rows
        -- matched a tool_result container whose content starts with '[' and was
        -- excluded by the shape filter, yielding NULL for every turn.
        -- ASOF JOIN resolves the correct "which human prompt does this turn answer"
        -- even across long tool-use chains.
        a.cwd,
        a.git_branch,
        a.claude_version,
        a.model,
        a.input_tokens,
        a.output_tokens,
        a.cache_creation_input_tokens,
        a.ephemeral_5m_input_tokens,
        a.ephemeral_1h_input_tokens,
        a.cache_read_input_tokens,
        a.context_pct,
        a.is_sidechain
    FROM {{ ref('stg_assistant_messages') }} a
    -- ASOF JOIN: for each assistant message, attach the most recent real user
    -- prompt at or before the assistant's timestamp within the same session.
    -- DuckDB ASOF requires the LEFT-side column first in the inequality
    -- (`a.ts >= u.user_ts`). Writing it as `u.user_ts <= a.ts` parses but
    -- matches nothing — verified by direct test where flipping the operands
    -- went from 0/4591 to 4591/4591 matched turns.
    ASOF LEFT JOIN (SELECT tenant_id, session_id, user_event_uuid, user_ts FROM real_user_prompts) u
        ON  u.tenant_id  = a.tenant_id
        AND u.session_id = a.session_id
        AND a.ts        >= u.user_ts
)

-- Window functions run on narrow rows; the prompt and response text join last
-- (sorting rows with the text took ~280 s on a full build).
, turns AS (
    SELECT
        *,
    -- compaction_inferred: visual marker (BOOLEAN) set when the model's context
    -- window appears to have been compacted between this turn and the previous
    -- turn in the same session. Heuristic: input_tokens dropped to less than
    -- half the previous turn's value AND the previous turn had > 50 000 tokens
    -- (ruling out normal low-token sessions where small counts fluctuate).
    -- This column is a diagnostic signal only — it is NOT used in any cost or
    -- context_pct calculation (spec §5.4). fact_turns may surface it for UI.
    (
        input_tokens < 0.5 * LAG(input_tokens) OVER (
            PARTITION BY tenant_id, session_id
            ORDER BY assistant_ts, turn_id
        )
        AND LAG(input_tokens) OVER (
            PARTITION BY tenant_id, session_id
            ORDER BY assistant_ts, turn_id
        ) > 50000
    )::BOOLEAN AS compaction_inferred
    FROM turns_base
)

SELECT
    t.tenant_id,
    t.session_id,
    t.project_id,
    t.turn_number,
    t.turn_id,
    t.user_event_uuid,
    t.assistant_event_uuid,
    t.user_ts,
    t.assistant_ts,
    p.user_prompt,
    ft.assistant_response,
    t.cwd,
    t.git_branch,
    t.claude_version,
    t.model,
    t.input_tokens,
    t.output_tokens,
    t.cache_creation_input_tokens,
    t.ephemeral_5m_input_tokens,
    t.ephemeral_1h_input_tokens,
    t.cache_read_input_tokens,
    t.context_pct,
    t.is_sidechain,
    t.compaction_inferred
FROM turns t
LEFT JOIN real_user_prompts p
    ON  p.tenant_id       = t.tenant_id
    AND p.user_event_uuid = t.user_event_uuid
LEFT JOIN first_text ft
    ON  ft.tenant_id  = t.tenant_id
    AND ft.event_uuid = t.assistant_event_uuid
