import { query, queryOne } from '../db'

const SESSIONS_PAGE_SIZE = 50
const SESSIONS_STATS_CAP = 200
// SESSIONS_PAGE_SIZE is reserved for future paginated endpoints

export interface SessionFilters {
  provider?: string
  agent?: string
  status?: string
  sort?: string
  q?: string
}

export async function getSessions(filters: SessionFilters = {}, since: string | null = null) {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filters.provider) { conditions.push('ds.provider = ?'); params.push(filters.provider) }
  if (filters.agent)    { conditions.push('ds.agent = ?');    params.push(filters.agent) }
  if (filters.status)   { conditions.push('ds.status = ?');   params.push(filters.status) }
  if (filters.q) {
    conditions.push("(ds.session_title ILIKE ? OR ds.session_id ILIKE ? OR ds.cwd ILIKE ?)")
    params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`)
  }
  if (since) { conditions.push('ds.start_ts >= ?'); params.push(since) }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const sortMap: Record<string, string> = {
    cost: 'total_cost DESC', turns: 'turn_count DESC',
    tokens: 'total_output_tokens DESC', started: 'start_ts DESC'
  }
  const orderBy = sortMap[filters.sort ?? ''] ?? 'start_ts DESC'

  return query(`
    SELECT ds.session_id, ds.start_ts, ds.end_ts, ds.model, ds.cwd, ds.git_branch,
           ds.agent, ds.agents, ds.agent_count,
           ds.person_id, ds.person_name,
           COALESCE(ds.session_title, ds.session_id) AS session_title,
           ds.status, ds.provider,
           ds.turn_count, ds.total_cost, ds.total_input_tokens, ds.total_output_tokens,
           ds.commits, ds.tools_used, ds.files_touched,
           da.app_id,
           ds.session_title AS prompt_preview
    FROM dim_sessions ds
    LEFT JOIN dim_apps da ON da.cwd = ds.cwd
    ${where}
    ORDER BY ${orderBy}
    LIMIT ${SESSIONS_STATS_CAP}
  `, params)
}

export async function getSessionsStats(filters: SessionFilters = {}, since: string | null = null) {
  const conditions: string[] = []
  const params: unknown[] = []

  if (filters.provider) { conditions.push('ds.provider = ?'); params.push(filters.provider) }
  if (filters.agent)    { conditions.push('ds.agent = ?');    params.push(filters.agent) }
  if (filters.status)   { conditions.push('ds.status = ?');   params.push(filters.status) }
  if (filters.q) {
    conditions.push("(ds.session_title ILIKE ? OR ds.session_id ILIKE ? OR ds.cwd ILIKE ?)")
    params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`)
  }
  if (since) { conditions.push('ds.start_ts >= ?'); params.push(since) }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  return queryOne(`
    SELECT
      COUNT(*) as total_count,
      COALESCE(SUM(ds.total_cost), 0) AS total_cost,
      SUM(ds.turn_count) as total_turns,
      SUM(ds.commits) as total_commits
    FROM dim_sessions ds
    ${where}
  `, params)
}

export async function getSession(id: string) {
  const session = await queryOne(`
    SELECT * FROM dim_sessions WHERE session_id = ?
  `, [id])
  
  if (session) return session

  // Fallback: construct from raw events for real-time active sessions
  const raw = await queryOne(`
    SELECT 
      session_id,
      MIN(ts) as start_ts,
      MAX(ts) as end_ts,
      ANY_VALUE(model) as model,
      ANY_VALUE(cwd) as cwd,
      ANY_VALUE(git_branch) as git_branch,
      ANY_VALUE(claude_version) as claude_version,
      COUNT(DISTINCT CASE WHEN event_type = 'assistant' THEN message_id END) as turn_count,
      SUM(CASE WHEN event_type = 'assistant' THEN COALESCE(input_tokens, 0) ELSE 0 END) as total_input_tokens,
      SUM(CASE WHEN event_type = 'assistant' THEN COALESCE(output_tokens, 0) ELSE 0 END) as total_output_tokens,
      'active' as status,
      'Anthropic' as provider,
      ANY_VALUE(agent) as agent
    FROM raw_events
    WHERE session_id = ?
    GROUP BY session_id
  `, [id])

  if (!raw) return null

  const meta = await queryOne(`
    SELECT person_id, person_name, commits, session_title
    FROM session_meta
    WHERE session_id = ?
  `, [id])

  return {
    ...raw,
    project: raw.cwd,
    person_id: meta?.person_id ?? 'local',
    person_name: meta?.person_name ?? 'local',
    commits: meta?.commits ?? 0,
    session_title: meta?.session_title ?? 'Active Session',
    total_cost: 0.0,
    tools_used: 0,
    files_touched: 0,
    ephemeral_5m_total: 0,
    ephemeral_1h_total: 0,
    cache_read_total: 0
  }
}

export async function getSessionTurns(id: string, opts: { all?: boolean; limit?: number } = {}) {
  const limit = opts.all ? null : (opts.limit ?? 500)
  const limitClause = limit == null ? '' : `LIMIT ${limit}`
  const turns = await query(`
    SELECT turn_number, user_ts, assistant_ts, assistant_event_uuid, model,
           input_tokens, output_tokens, calculated_cost,
           cache_read_input_tokens, ephemeral_5m_input_tokens, ephemeral_1h_input_tokens,
           context_pct, user_prompt, assistant_response,
           is_sidechain
    FROM fact_turns
    WHERE session_id = ?
    ORDER BY turn_number
    ${limitClause}
  `, [id])

  if (turns.length) return turns

  // Fallback: construct turns directly from raw events for real-time responsiveness
  const fallbackLimit = limit == null ? '' : `LIMIT ${limit}`
  return query(`
    SELECT
      ROW_NUMBER() OVER (ORDER BY ts) as turn_number,
      ts as user_ts,
      ts as assistant_ts,
      uuid as assistant_event_uuid,
      model,
      COALESCE(input_tokens, 0) as input_tokens,
      COALESCE(output_tokens, 0) as output_tokens,
      0.0 as calculated_cost,
      COALESCE(cache_read_input_tokens, 0) as cache_read_input_tokens,
      COALESCE(ephemeral_5m_input_tokens, 0) as ephemeral_5m_input_tokens,
      COALESCE(ephemeral_1h_input_tokens, 0) as ephemeral_1h_input_tokens,
      COALESCE(context_pct, 0.0) as context_pct,
      NULL as user_prompt,
      NULL as assistant_response
    FROM raw_events
    WHERE session_id = ? AND event_type = 'assistant'
    ORDER BY ts
    ${fallbackLimit}
  `, [id])
}

export async function getSessionErrors(id: string) {
  return query(`
    SELECT ts, kind, tool, message, severity, turn_number
    FROM fact_errors
    WHERE session_id = ?
    ORDER BY ts
  `, [id])
}

export async function getSessionFiles(id: string) {
  return query(`
    SELECT file_path, file_ext, edit_count, write_count
    FROM fact_session_files
    WHERE session_id = ?
    ORDER BY edit_count DESC
  `, [id])
}

export async function getSessionToolMix(id: string) {
  return query(`
    SELECT tool_name, COUNT(*) AS calls, SUM(CASE WHEN is_error THEN 1 ELSE 0 END) AS errors
    FROM fact_tool_executions
    WHERE session_id = ?
    GROUP BY tool_name
    ORDER BY calls DESC
  `, [id])
}

export async function getSessionGitCommands(id: string) {
  return query(`
    SELECT ts, raw_command, output_text, git_op, is_error
    FROM fact_git_commands
    WHERE session_id = ?
    ORDER BY ts
  `, [id])
}

export async function getSessionToolExecutions(id: string) {
  return query(`
    SELECT
      tool_name,
      tool_call_ts,
      tool_result_ts,
      execution_duration_seconds,
      is_error,
      assistant_event_uuid,
      json_extract_string(CAST(input_payload AS VARCHAR), '$.file_path') AS file_path
    FROM fact_tool_executions
    WHERE session_id = ?
    ORDER BY tool_call_ts
  `, [id])
}

/**
 * Enriched prompts for the session detail page. Each prompt row carries
 * its tool calls (raw list) PLUS eight chip-friendly insight columns:
 *   - cache_hit_rate     (DOUBLE) cache_read / (input + ephemeral + cache_read)
 *   - tool_signature     STRUCT[]{tool_name, calls}    top-N tools by count
 *   - retry_count        (BIGINT) consecutive same-target retries after error
 *   - sub_agents         VARCHAR[]                     subagent_type values from Task/Agent
 *   - ttft_seconds       (DOUBLE) prompt_ts → first tool_call_ts
 *   - models_used        VARCHAR[]                     distinct models in window
 *   - model_count        (BIGINT)
 *   - cost_by_model      STRUCT[]{model, cost}         per-model rollup in window
 *   - final_stop_reason  (VARCHAR) last stop_reason in the window
 *
 * Defensive: any insight that can't be computed (e.g. no turn rows, missing
 * raw_events.uuid join) falls back to NULL — the UI tolerates nulls. Whole
 * query is wrapped in try/catch; on failure the page renders the simpler
 * prompts list instead of crashing.
 */
export async function getSessionPrompts(id: string): Promise<any[]> {
  try {
    const rows = await query(`
      WITH
      -- Tool calls that fall within each prompt's [prompt_ts, next_prompt_ts) window
      window_tools AS (
        SELECT fp.prompt_id,
               fte.tool_name,
               fte.tool_call_ts,
               fte.is_error,
               json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path')     AS target_file,
               json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.subagent_type') AS subagent_type
        FROM fact_prompts fp
        JOIN fact_tool_executions fte
          ON fte.session_id = fp.session_id
          AND fte.tool_call_ts >= fp.prompt_ts
          AND (fp.next_prompt_ts IS NULL OR fte.tool_call_ts < fp.next_prompt_ts)
        WHERE fp.session_id = ?
      ),
      -- Turns within each prompt window (for cost/model/cache/stop)
      window_turns AS (
        SELECT fp.prompt_id,
               ft.model,
               ft.calculated_cost,
               ft.input_tokens,
               ft.output_tokens,
               ft.cache_read_input_tokens,
               ft.ephemeral_5m_input_tokens,
               ft.ephemeral_1h_input_tokens,
               ft.assistant_ts,
               ft.assistant_event_uuid,
               re.stop_reason
        FROM fact_prompts fp
        JOIN fact_turns ft
          ON ft.session_id = fp.session_id
          AND ft.assistant_ts >= fp.prompt_ts
          AND (fp.next_prompt_ts IS NULL OR ft.assistant_ts < fp.next_prompt_ts)
        LEFT JOIN raw_events re
          ON re.uuid = ft.assistant_event_uuid
        WHERE fp.session_id = ?
      ),
      -- Per-prompt tool signature (top tools by count, full list — UI slices)
      sig AS (
        SELECT prompt_id,
               ARRAY_AGG(STRUCT_PACK(tool_name := tool_name, calls := calls) ORDER BY calls DESC) AS tool_signature
        FROM (
          SELECT prompt_id, tool_name, COUNT(*) AS calls
          FROM window_tools GROUP BY 1,2
        ) sub
        GROUP BY 1
      ),
      -- Consecutive same-(tool,target) retries after an error in the same window
      retries_calc AS (
        SELECT prompt_id,
               LAG(is_error) OVER (PARTITION BY prompt_id, tool_name, target_file ORDER BY tool_call_ts) AS prev_err
        FROM window_tools
      ),
      retries AS (
        SELECT prompt_id, SUM(CASE WHEN prev_err = TRUE THEN 1 ELSE 0 END) AS retry_count
        FROM retries_calc GROUP BY 1
      ),
      -- Subagent dispatches (Agent / Task tools carry subagent_type in input)
      subs AS (
        SELECT prompt_id, ARRAY_AGG(DISTINCT subagent_type) FILTER (WHERE subagent_type IS NOT NULL) AS sub_agents
        FROM window_tools GROUP BY 1
      ),
      -- Time-to-first-tool: prompt_ts → MIN(tool_call_ts)
      ttft AS (
        SELECT fp.prompt_id,
               EXTRACT(EPOCH FROM (MIN(fte.tool_call_ts) - fp.prompt_ts)) AS ttft_seconds
        FROM fact_prompts fp
        LEFT JOIN fact_tool_executions fte
          ON fte.session_id = fp.session_id
          AND fte.tool_call_ts >= fp.prompt_ts
          AND (fp.next_prompt_ts IS NULL OR fte.tool_call_ts < fp.next_prompt_ts)
        WHERE fp.session_id = ?
        GROUP BY fp.prompt_id, fp.prompt_ts
      ),
      -- Cache hit rate per prompt
      cache_hr AS (
        SELECT prompt_id,
               CASE WHEN SUM(COALESCE(input_tokens,0)
                          + COALESCE(ephemeral_5m_input_tokens,0)
                          + COALESCE(ephemeral_1h_input_tokens,0)
                          + COALESCE(cache_read_input_tokens,0)) > 0
                    THEN SUM(COALESCE(cache_read_input_tokens,0))::DOUBLE
                         / SUM(COALESCE(input_tokens,0)
                             + COALESCE(ephemeral_5m_input_tokens,0)
                             + COALESCE(ephemeral_1h_input_tokens,0)
                             + COALESCE(cache_read_input_tokens,0))
                    ELSE NULL END AS cache_hit_rate
        FROM window_turns GROUP BY 1
      ),
      -- Distinct models in window
      mdls AS (
        SELECT prompt_id,
               ARRAY_AGG(DISTINCT model) FILTER (WHERE model IS NOT NULL) AS models_used,
               COUNT(DISTINCT model)                                       AS model_count
        FROM window_turns GROUP BY 1
      ),
      -- Per-(prompt × model) cost
      cbm AS (
        SELECT prompt_id,
               ARRAY_AGG(STRUCT_PACK(model := model, cost := cost) ORDER BY cost DESC) AS cost_by_model
        FROM (
          SELECT prompt_id, model, SUM(COALESCE(calculated_cost,0)) AS cost
          FROM window_turns WHERE model IS NOT NULL
          GROUP BY 1,2
        ) sub
        GROUP BY 1
      ),
      -- Final stop_reason in window (latest assistant turn)
      stop_r AS (
        SELECT prompt_id,
               FIRST(stop_reason ORDER BY assistant_ts DESC) AS final_stop_reason
        FROM window_turns
        WHERE stop_reason IS NOT NULL
        GROUP BY 1
      )
      SELECT
        fp.prompt_id,
        fp.prompt_idx,
        fp.prompt_ts,
        fp.next_prompt_ts,
        fp.duration_seconds,
        fp.prompt_text_200,
        fp.prompt_text_full,
        fp.prompt_chars,
        fp.prompt_origin,
        fp.agent,
        fp.model_primary,
        fp.tool_call_count,
        fp.cost_total,
        fp.turn_count,
        fp.files_edited,
        fp.errors_caught,
        fp.is_overkill,
        fp.overkill_reason,
        fp.summary_200,
        fp.output_tokens_total,
        COALESCE(
          ARRAY_AGG(STRUCT_PACK(
            tool_name    := fte.tool_name,
            tool_call_ts := fte.tool_call_ts,
            is_error     := fte.is_error,
            file_path    := json_extract_string(CAST(fte.input_payload AS VARCHAR), '$.file_path')
          ) ORDER BY fte.tool_call_ts) FILTER (WHERE fte.tool_name IS NOT NULL),
          []
        ) AS tool_calls,
        ANY_VALUE(sig.tool_signature)      AS tool_signature,
        ANY_VALUE(retries.retry_count)     AS retry_count,
        ANY_VALUE(subs.sub_agents)         AS sub_agents,
        ANY_VALUE(ttft.ttft_seconds)       AS ttft_seconds,
        ANY_VALUE(cache_hr.cache_hit_rate) AS cache_hit_rate,
        ANY_VALUE(mdls.models_used)        AS models_used,
        ANY_VALUE(mdls.model_count)        AS model_count,
        ANY_VALUE(cbm.cost_by_model)       AS cost_by_model,
        ANY_VALUE(stop_r.final_stop_reason) AS final_stop_reason
      FROM fact_prompts fp
      LEFT JOIN fact_tool_executions fte
        ON  fte.session_id = fp.session_id
        AND fte.tool_call_ts >= fp.prompt_ts
        AND (fp.next_prompt_ts IS NULL OR fte.tool_call_ts < fp.next_prompt_ts)
      LEFT JOIN sig      ON sig.prompt_id      = fp.prompt_id
      LEFT JOIN retries  ON retries.prompt_id  = fp.prompt_id
      LEFT JOIN subs     ON subs.prompt_id     = fp.prompt_id
      LEFT JOIN ttft     ON ttft.prompt_id     = fp.prompt_id
      LEFT JOIN cache_hr ON cache_hr.prompt_id = fp.prompt_id
      LEFT JOIN mdls     ON mdls.prompt_id     = fp.prompt_id
      LEFT JOIN cbm      ON cbm.prompt_id      = fp.prompt_id
      LEFT JOIN stop_r   ON stop_r.prompt_id   = fp.prompt_id
      WHERE fp.session_id = ?
      GROUP BY 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20
      ORDER BY fp.prompt_idx
    `, [id, id, id, id])
    return rows as any[]
  } catch (e) {
    console.error('[sessions] getSessionPrompts failed:', e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * Hero strip: three "winner" prompts per metric. Each is a sane fallback to
 * null when the session has no prompts at all.
 */
export async function getSessionPromptHeroes(id: string): Promise<{
  most_expensive: any | null
  longest: any | null
  most_errored: any | null
}> {
  try {
    const rows = await query(`
      WITH p AS (
        SELECT prompt_id, prompt_idx, prompt_text_200, agent,
               cost_total, duration_seconds, errors_caught, tool_call_count
        FROM fact_prompts
        WHERE session_id = ?
      ),
      mx_cost AS (SELECT * FROM p WHERE cost_total IS NOT NULL ORDER BY cost_total DESC NULLS LAST LIMIT 1),
      mx_dur  AS (SELECT * FROM p WHERE duration_seconds IS NOT NULL ORDER BY duration_seconds DESC NULLS LAST LIMIT 1),
      mx_err  AS (SELECT * FROM p WHERE errors_caught > 0 ORDER BY errors_caught DESC NULLS LAST, cost_total DESC LIMIT 1)
      SELECT
        (SELECT prompt_id        FROM mx_cost) AS cost_prompt_id,
        (SELECT prompt_idx       FROM mx_cost) AS cost_prompt_idx,
        (SELECT prompt_text_200  FROM mx_cost) AS cost_prompt_text,
        (SELECT agent            FROM mx_cost) AS cost_prompt_agent,
        (SELECT cost_total       FROM mx_cost) AS cost_value,
        (SELECT prompt_id        FROM mx_dur)  AS dur_prompt_id,
        (SELECT prompt_idx       FROM mx_dur)  AS dur_prompt_idx,
        (SELECT prompt_text_200  FROM mx_dur)  AS dur_prompt_text,
        (SELECT agent            FROM mx_dur)  AS dur_prompt_agent,
        (SELECT duration_seconds FROM mx_dur)  AS dur_value,
        (SELECT prompt_id        FROM mx_err)  AS err_prompt_id,
        (SELECT prompt_idx       FROM mx_err)  AS err_prompt_idx,
        (SELECT prompt_text_200  FROM mx_err)  AS err_prompt_text,
        (SELECT agent            FROM mx_err)  AS err_prompt_agent,
        (SELECT errors_caught    FROM mx_err)  AS err_value
    `, [id])
    const r: any = rows[0] ?? {}
    return {
      most_expensive: r.cost_prompt_id ? {
        prompt_id: r.cost_prompt_id, prompt_idx: r.cost_prompt_idx,
        prompt_text_200: r.cost_prompt_text, agent: r.cost_prompt_agent,
        value: r.cost_value,
      } : null,
      longest: r.dur_prompt_id ? {
        prompt_id: r.dur_prompt_id, prompt_idx: r.dur_prompt_idx,
        prompt_text_200: r.dur_prompt_text, agent: r.dur_prompt_agent,
        value: r.dur_value,
      } : null,
      most_errored: r.err_prompt_id ? {
        prompt_id: r.err_prompt_id, prompt_idx: r.err_prompt_idx,
        prompt_text_200: r.err_prompt_text, agent: r.err_prompt_agent,
        value: r.err_value,
      } : null,
    }
  } catch (e) {
    console.error('[sessions] getSessionPromptHeroes failed:', e instanceof Error ? e.message : e)
    return { most_expensive: null, longest: null, most_errored: null }
  }
}

/**
 * Thinking-block disclosures for the Messages tab. Returns one row per
 * assistant event that contained at least one `thinking` content block.
 * Robust to malformed JSON via a try-LIKE pre-filter; extraction proceeds in
 * SQL via json_extract on the content array.
 *
 * Note: as of 2026-05-25 the source raw_events for the bundled DB contain no
 * thinking blocks at all — this query returns [] and the UI hides the
 * disclosure gracefully. Light up when the data starts flowing.
 */
export async function getSessionThinkingBlocks(_id: string): Promise<Array<{
  assistant_event_uuid: string
  thinking_text: string
}>> {
  // Short-circuit: ingested JSONL transcripts do not currently carry
  // type='thinking' content blocks (verified 2026-05-25). The previous
  // implementation did `ILIKE '%"type":"thinking"%'` on the raw_events.payload
  // VARCHAR column — a leading-wildcard full-payload scan that cost 500ms–2s
  // per session detail page load while always returning [].
  // Re-enable when thinking blocks start appearing in raw_events. The
  // implementation is preserved in git history (before this commit).
  return []
}

/**
 * Per-error resolution distance: for each error in this session, how many
 * turns later did an Edit/Write occur? Null if never resolved within session.
 */
export async function getSessionErrorResolutions(id: string): Promise<Array<{
  ts: string
  kind: string
  tool: string | null
  message: string
  severity: string | null
  turn_number: number
  resolved_in_turns: number | null
}>> {
  try {
    const rows = await query(`
      SELECT e.ts, e.kind, e.tool, e.message, e.severity, e.turn_number,
        (
          SELECT MIN(ft.turn_number) - e.turn_number
          FROM fact_turns ft
          JOIN fact_tool_executions fte
            ON fte.assistant_event_uuid = ft.assistant_event_uuid
          WHERE ft.session_id = e.session_id
            AND ft.turn_number > e.turn_number
            AND fte.tool_name IN ('Edit','Write','NotebookEdit')
        ) AS resolved_in_turns
      FROM fact_errors e
      WHERE e.session_id = ?
      ORDER BY e.ts
    `, [id])
    return rows as any
  } catch (e) {
    console.error('[sessions] getSessionErrorResolutions failed:', e instanceof Error ? e.message : e)
    return []
  }
}
