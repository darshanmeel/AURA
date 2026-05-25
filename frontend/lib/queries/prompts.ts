import { query } from '../db'

export async function getSessionPrompts(sessionId: string) {
  return query(`
    SELECT prompt_idx, prompt_ts, duration_seconds,
           prompt_text_200, summary_200,
           agent, model_primary, turn_count, tool_call_count,
           files_edited, output_tokens_total, cost_total, errors_caught,
           is_overkill, overkill_reason, complexity_tier
    FROM fact_prompts
    WHERE session_id = ?
    ORDER BY prompt_ts
  `, [sessionId])
}

export async function getAppPrompts(appId: string, limit = 6) {
  return query(`
    SELECT prompt_idx, prompt_ts, prompt_text_200, agent, cost_total,
           turn_count, tool_call_count, files_edited, session_id
    FROM fact_prompts
    WHERE app_id = ?
    ORDER BY cost_total DESC
    LIMIT ?
  `, [appId, limit])
}

export async function getAppAllPrompts(appId: string, limit = 200) {
  return query(`
    SELECT prompt_idx, prompt_ts, duration_seconds, prompt_text_200, summary_200,
           agent, model_primary, turn_count, tool_call_count,
           files_edited, output_tokens_total, cost_total, errors_caught,
           is_overkill, overkill_reason, complexity_tier, session_id
    FROM fact_prompts
    WHERE app_id = ?
    ORDER BY prompt_ts DESC
    LIMIT ?
  `, [appId, limit])
}

export async function getAgentPrompts(agent: string, limit = 6) {
  return query(`
    SELECT prompt_idx, prompt_ts, prompt_text_200, app_id, cost_total,
           turn_count, files_edited, session_id, is_overkill
    FROM fact_prompts
    WHERE agent = ?
    ORDER BY prompt_ts DESC
    LIMIT ?
  `, [agent, limit])
}

export async function getOverkillPrompts(limit = 5) {
  return query(`
    SELECT prompt_text_200, agent, app_id, model_primary, overkill_reason,
           cost_total, session_id, prompt_ts
    FROM fact_prompts
    WHERE is_overkill = TRUE
    ORDER BY cost_total DESC
    LIMIT ?
  `, [limit])
}

export async function getLoudestPromptOfDay() {
  return query(`
    SELECT prompt_text_200, agent, app_id, model_primary, output_tokens_total
    FROM fact_prompts
    WHERE prompt_ts >= CURRENT_DATE - INTERVAL '1 day'
      AND prompt_origin = 'human'
    ORDER BY output_tokens_total DESC
    LIMIT 1
  `).then(rs => rs[0] ?? null)
}
