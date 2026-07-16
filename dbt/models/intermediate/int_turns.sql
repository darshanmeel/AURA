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
-- user_prompt extraction: try plain-string content first (most common).
-- If content is a JSON array, walk up to 8 positions for a text-type block.
-- The 8-position limit covers real sessions where tool_result blocks precede
-- the actual text block. list_filter would be cleaner but this is readable.
WITH real_user_prompts AS (
    SELECT
        tenant_id,
        session_id,
        uuid    AS user_event_uuid,
        ts      AS user_ts,
        COALESCE(
            CASE
                WHEN NOT starts_with(
                    COALESCE(json_extract_string(payload, '$.message.content'), ''), '[')
                THEN json_extract_string(payload, '$.message.content')
            END,
            json_extract_string(payload, '$.message.content[0].text'),
            json_extract_string(payload, '$.message.content[1].text'),
            json_extract_string(payload, '$.message.content[2].text'),
            json_extract_string(payload, '$.message.content[3].text'),
            json_extract_string(payload, '$.message.content[4].text'),
            json_extract_string(payload, '$.message.content[5].text'),
            json_extract_string(payload, '$.message.content[6].text'),
            json_extract_string(payload, '$.message.content[7].text')
        ) AS user_prompt
    FROM {{ ref('stg_events') }}
    WHERE event_type = 'user'
      AND json_extract_string(payload, '$.userType') = 'external'
      AND COALESCE(json_extract_string(payload, '$.isMeta'), 'false') != 'true'
      AND substr(
            trim(COALESCE(json_extract_string(payload, '$.message.content'), '')),
            1, 1
          ) != '['
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
        ROW_NUMBER() OVER (PARTITION BY a.tenant_id, a.session_id ORDER BY a.ts) AS turn_number,
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
        u.user_prompt,
        -- assistant_response: type-guarded COALESCE walks up to 20 content block
        -- positions, returning text only for blocks where type='text'.
        -- Thinking blocks (type='thinking') and tool-use blocks (type='tool_use')
        -- are skipped. 20 positions covers the observed maximum leading-block depth
        -- across all sessions (profiled: max first-text-block index was 12).
        COALESCE(
            CASE WHEN json_extract_string(a.payload, '$.message.content[0].type')  = 'text' THEN json_extract_string(a.payload, '$.message.content[0].text')  END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[1].type')  = 'text' THEN json_extract_string(a.payload, '$.message.content[1].text')  END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[2].type')  = 'text' THEN json_extract_string(a.payload, '$.message.content[2].text')  END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[3].type')  = 'text' THEN json_extract_string(a.payload, '$.message.content[3].text')  END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[4].type')  = 'text' THEN json_extract_string(a.payload, '$.message.content[4].text')  END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[5].type')  = 'text' THEN json_extract_string(a.payload, '$.message.content[5].text')  END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[6].type')  = 'text' THEN json_extract_string(a.payload, '$.message.content[6].text')  END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[7].type')  = 'text' THEN json_extract_string(a.payload, '$.message.content[7].text')  END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[8].type')  = 'text' THEN json_extract_string(a.payload, '$.message.content[8].text')  END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[9].type')  = 'text' THEN json_extract_string(a.payload, '$.message.content[9].text')  END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[10].type') = 'text' THEN json_extract_string(a.payload, '$.message.content[10].text') END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[11].type') = 'text' THEN json_extract_string(a.payload, '$.message.content[11].text') END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[12].type') = 'text' THEN json_extract_string(a.payload, '$.message.content[12].text') END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[13].type') = 'text' THEN json_extract_string(a.payload, '$.message.content[13].text') END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[14].type') = 'text' THEN json_extract_string(a.payload, '$.message.content[14].text') END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[15].type') = 'text' THEN json_extract_string(a.payload, '$.message.content[15].text') END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[16].type') = 'text' THEN json_extract_string(a.payload, '$.message.content[16].text') END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[17].type') = 'text' THEN json_extract_string(a.payload, '$.message.content[17].text') END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[18].type') = 'text' THEN json_extract_string(a.payload, '$.message.content[18].text') END,
            CASE WHEN json_extract_string(a.payload, '$.message.content[19].type') = 'text' THEN json_extract_string(a.payload, '$.message.content[19].text') END
        ) AS assistant_response,
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
    ASOF LEFT JOIN real_user_prompts u
        ON  u.tenant_id  = a.tenant_id
        AND u.session_id = a.session_id
        AND a.ts        >= u.user_ts
)

SELECT
    tenant_id,
    session_id,
    project_id,
    turn_number,
    turn_id,
    user_event_uuid,
    assistant_event_uuid,
    user_ts,
    assistant_ts,
    user_prompt,
    assistant_response,
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
    is_sidechain,
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
            ORDER BY assistant_ts
        )
        AND LAG(input_tokens) OVER (
            PARTITION BY tenant_id, session_id
            ORDER BY assistant_ts
        ) > 50000
    )::BOOLEAN AS compaction_inferred
FROM turns_base
