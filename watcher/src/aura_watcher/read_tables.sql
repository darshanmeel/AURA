-- Read DB contents (spec §2.2.1): the only tables and columns the frontend and
-- scripts/verify/run_all.mjs may query. Run by dbt_cycle.publish on a connection
-- that attached the work DB as "aura" (marts) and the DuckLake as "stage"
-- (staging + intermediate; dbt bakes both catalog names into view SQL) and
-- USEs the new read DB. One create-table-as-select statement per table;
-- adding a column the frontend needs is one edit here, in the same change as
-- the query.
-- Text caps: 12,000 chars (~2,000 words) for text the session page expands, the shown width
-- for previews.

CREATE TABLE dim_sessions AS
SELECT * FROM aura.main.dim_sessions;

CREATE TABLE dim_apps AS
SELECT * FROM aura.main.dim_apps;

CREATE TABLE dim_people AS
SELECT * FROM aura.main.dim_people;

CREATE TABLE dim_projects AS
SELECT tenant_id, project_id, project_name, app_count, session_count, total_cost, total_turns
FROM aura.main.dim_projects;

CREATE TABLE dim_agents AS
SELECT tenant_id, agent, app_id, project_id, first_seen, last_seen, session_count, total_cost,
       total_output_tokens, total_tool_calls, total_turns
FROM aura.main.dim_agents;

CREATE TABLE fact_model_calls AS
SELECT tenant_id, event_uuid, session_id, ts, model, agent, source, input_tokens, output_tokens,
       cache_read_input_tokens, ephemeral_5m_input_tokens, ephemeral_1h_input_tokens,
       calculated_cost, reported_cost_usd
FROM aura.main.fact_model_calls;

CREATE TABLE fact_daily_spend AS
SELECT tenant_id, date, model, provider, daily_cost, session_count, turn_count
FROM aura.main.fact_daily_spend;

CREATE TABLE fact_hourly_activity AS
SELECT * FROM aura.main.fact_hourly_activity;

CREATE TABLE fact_spend_pace AS
SELECT tenant_id, today_cost, today_pace_hourly, today_turn_count, hours_elapsed_today,
       avg_30d_cost, avg_30d_turns, avg_30d_tools
FROM aura.main.fact_spend_pace;

CREATE TABLE fact_prompts AS
SELECT tenant_id, prompt_id, prompt_idx, session_id, prompt_ts, next_prompt_ts, agent, app_id,
       model_primary, models_used, complexity_tier, is_overkill, overkill_reason, prompt_origin,
       prompt_chars, prompt_text_200, left(prompt_text_full, 12000) AS prompt_text_full, summary_200,
       cost_total, output_tokens_total, cache_hit_rate, duration_seconds, ttft_seconds, turn_count,
       tool_call_count, tool_signature, retry_count, errors_caught, files_edited, final_stop_reason
FROM aura.main.fact_prompts
ORDER BY tenant_id, session_id;

CREATE TABLE fact_turns AS
SELECT tenant_id, turn_id, session_id, turn_number, user_ts, assistant_ts, assistant_event_uuid, model,
       input_tokens, output_tokens, cache_read_input_tokens, ephemeral_5m_input_tokens,
       ephemeral_1h_input_tokens, context_pct, is_sidechain, calculated_cost, stop_reason
FROM aura.main.fact_turns
ORDER BY tenant_id, session_id;

CREATE TABLE dim_turn_messages AS
SELECT tenant_id, session_id, turn_id, left(user_prompt, 12000) AS user_prompt,
       left(assistant_response, 12000) AS assistant_response
FROM stage.main.dim_turn_messages
ORDER BY tenant_id, session_id;

CREATE TABLE fact_tool_executions AS
SELECT tenant_id, session_id, assistant_event_uuid, tool_name, model, tool_call_ts, tool_result_ts,
       execution_duration_seconds, is_error, target_file, subagent_type, skill_name
FROM aura.main.fact_tool_executions
ORDER BY tenant_id, session_id;

-- The session Git tab shows output_text.slice(0, 80).
CREATE TABLE fact_git_commands AS
SELECT tenant_id, session_id, ts, git_op, raw_command, is_error, left(output_text, 80) AS output_text
FROM aura.main.fact_git_commands;

CREATE TABLE fact_errors AS
SELECT * FROM aura.main.fact_errors;

CREATE TABLE fact_session_files AS
SELECT tenant_id, session_id, file_path, file_ext, edit_count, write_count, cost_attributed,
       tokens_attributed, duration_attributed_seconds
FROM aura.main.fact_session_files;

CREATE TABLE int_entity_spend AS
SELECT * FROM stage.main.int_entity_spend;

-- A view in the stage; copied so the read DB holds tables only.
CREATE TABLE int_app_cwd_lookup AS
SELECT * FROM stage.main.int_app_cwd_lookup;

CREATE TABLE int_event_agent AS
SELECT tenant_id, event_uuid, session_id, agent_resolved
FROM stage.main.int_event_agent;

CREATE TABLE stg_session_skills AS
SELECT tenant_id, session_id, skill_name
FROM stage.main.stg_session_skills;

CREATE TABLE stg_session_mcps AS
SELECT tenant_id, session_id, mcp_server
FROM stage.main.stg_session_mcps;

CREATE TABLE stg_session_meta AS
SELECT tenant_id, session_id, person_id, person_name, session_title, permission_mode, mode
FROM stage.main.stg_session_meta;

CREATE TABLE stg_watcher_errors AS
SELECT ts, source, file_path, error_message, stack_trace
FROM stage.main.stg_watcher_errors;

-- The only lake read of the publish: last 8 UTC
-- days, no payload. Runs under lake_lock so compaction cannot delete files mid-read.
CREATE TABLE recent_events AS
SELECT tenant_id, uuid, session_id, agent, event_type, ts, "date", message_id, model, cwd, git_branch,
       claude_version, input_tokens, output_tokens, cache_read_input_tokens, ephemeral_5m_input_tokens,
       ephemeral_1h_input_tokens, context_pct, byte_offset
FROM stage.main.stg_events
WHERE "date" >= current_date - 8
ORDER BY ts;

CREATE TABLE model_pricing AS
SELECT * FROM aura.main.model_pricing;
