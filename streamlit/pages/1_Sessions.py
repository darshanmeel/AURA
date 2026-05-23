import os
import streamlit as st
import duckdb
import pandas as pd
import json

st.set_page_config(page_title="Sessions Explorer — Aura", layout="wide")

# Styling
st.markdown("""
<style>
    .reportview-container {
        background: #0e1117;
    }
    .metric-card {
        background-color: #1f2937;
        border-radius: 8px;
        padding: 15px;
        border: 1px solid #374151;
        margin-bottom: 10px;
    }
    .tool-box {
        background-color: #111827;
        border-left: 4px solid #6366f1;
        padding: 10px;
        margin: 5px 0;
        font-family: monospace;
        font-size: 0.9em;
        color: #e5e7eb;
    }
</style>
""", unsafe_allow_html=True)

st.title("🛡️ Session Deep-Dive & Replay")
st.caption("Inspect individual agent sessions, turn-by-turn prompt execution, and exploded tool calls.")

def get_connection():
    db_path = os.getenv("AURA_READ_DB", "/data/aura_read.duckdb")
    if not os.path.exists(db_path):
        st.warning(f"Database not found at {db_path}. Waiting for dbt run...")
        return None
    return duckdb.connect(db_path, read_only=True)

conn = get_connection()

if conn:
    try:
        # Load all sessions for filtering
        sessions_df = conn.execute("""
            SELECT 
                session_id, 
                start_ts, 
                end_ts, 
                model, 
                project, 
                git_branch, 
                claude_version, 
                turn_count, 
                total_cost,
                total_input_tokens + total_output_tokens as total_tokens
            FROM dim_sessions
            ORDER BY start_ts DESC
        """).df()
    except Exception as e:
        st.error(f"Error reading dim_sessions: {e}")
        sessions_df = pd.DataFrame()
    finally:
        conn.close()

    if not sessions_df.empty:
        # Filters in sidebar
        st.sidebar.header("🔍 Filter Sessions")
        
        projects = ["All"] + sorted(list(sessions_df["project"].dropna().unique()))
        selected_project = st.sidebar.selectbox("Project Directory", projects)
        
        models = ["All"] + sorted(list(sessions_df["model"].dropna().unique()))
        selected_model = st.sidebar.selectbox("Model", models)

        # Apply filters
        filtered_df = sessions_df.copy()
        if selected_project != "All":
            filtered_df = filtered_df[filtered_df["project"] == selected_project]
        if selected_model != "All":
            filtered_df = filtered_df[filtered_df["model"] == selected_model]

        # Display sessions selection
        st.subheader("Select a Session")
        
        # Format session choice labels
        filtered_df["label"] = filtered_df.apply(
            lambda r: f"{r['start_ts'].strftime('%Y-%m-%d %H:%M:%S')} — {os.path.basename(str(r['project']))} ({r['model']}) — {r['turn_count']} turns",
            axis=1
        )
        
        session_options = dict(zip(filtered_df["session_id"], filtered_df["label"]))
        
        if session_options:
            selected_session_id = st.selectbox(
                "Choose Session to Replay:",
                options=list(session_options.keys()),
                format_func=lambda x: session_options[x]
            )
            
            # Get details of selected session
            session_meta = sessions_df[sessions_df["session_id"] == selected_session_id].iloc[0]
            
            # Session Stats Row
            st.divider()
            col1, col2, col3, col4 = st.columns(4)
            with col1:
                st.metric("Total Cost", f"${session_meta['total_cost']:.4f}")
            with col2:
                st.metric("Turn Count", f"{session_meta['turn_count']}")
            with col3:
                st.metric("Total Tokens", f"{session_meta['total_tokens']:,}")
            with col4:
                st.metric("Claude Version", f"{session_meta['claude_version']}")
                
            # Details block
            st.markdown(f"**Workspace**: `{session_meta['project']}` | **Git Branch**: `{session_meta['git_branch']}`")
            st.divider()
            
            # Load turns
            conn = get_connection()
            try:
                turns_df = conn.execute("""
                    SELECT 
                        turn_id,
                        user_event_uuid,
                        assistant_event_uuid,
                        user_ts,
                        assistant_ts,
                        user_prompt,
                        assistant_response,
                        model,
                        input_tokens,
                        output_tokens,
                        calculated_cost,
                        context_pct
                    FROM fact_turns
                    WHERE session_id = ?
                    ORDER BY COALESCE(user_ts, assistant_ts) ASC
                """, [selected_session_id]).df()
                
                # Load all tool executions for this session
                tools_df = conn.execute("""
                    SELECT 
                        assistant_event_uuid,
                        tool_name,
                        input_payload,
                        output_text,
                        is_error,
                        execution_duration_seconds
                    FROM fact_tool_executions
                    WHERE session_id = ?
                    ORDER BY tool_call_ts ASC
                """, [selected_session_id]).df()
                
            except Exception as e:
                st.error(f"Error fetching turn details: {e}")
                turns_df = pd.DataFrame()
                tools_df = pd.DataFrame()
            finally:
                conn.close()

            if not turns_df.empty:
                st.subheader("💬 Turn-by-Turn Replay")
                
                for idx, turn in turns_df.iterrows():
                    st.markdown(f"### Turn {idx+1}")
                    
                    # User message
                    if pd.notna(turn["user_prompt"]) and turn["user_prompt"].strip():
                        with st.chat_message("user"):
                            st.markdown(turn["user_prompt"])
                            st.caption(f"Prompt sent at: {turn['user_ts']}")
                            
                    # Assistant message
                    if pd.notna(turn["assistant_response"]) and turn["assistant_response"].strip():
                        with st.chat_message("assistant"):
                            st.markdown(turn["assistant_response"])
                            
                            # Metrics sub-bar
                            metrics_line = []
                            if pd.notna(turn["model"]):
                                metrics_line.append(f"Model: `{turn['model']}`")
                            if pd.notna(turn["input_tokens"]):
                                metrics_line.append(f"In: `{turn['input_tokens']}`")
                            if pd.notna(turn["output_tokens"]):
                                metrics_line.append(f"Out: `{turn['output_tokens']}`")
                            if pd.notna(turn["context_pct"]):
                                metrics_line.append(f"Context: `{turn['context_pct']:.2%}`")
                            if pd.notna(turn["calculated_cost"]) and turn["calculated_cost"] > 0:
                                metrics_line.append(f"Cost: `${turn['calculated_cost']:.5f}`")
                                
                            st.markdown(" | ".join(metrics_line))
                            
                            # Associated tool calls
                            turn_tools = tools_df[tools_df["assistant_event_uuid"] == turn["assistant_event_uuid"]]
                            if not turn_tools.empty:
                                st.markdown("##### 🛠️ Executed Tools")
                                for t_idx, tool in turn_tools.iterrows():
                                    status_emoji = "❌" if tool["is_error"] else "✅"
                                    duration_text = f" ({tool['execution_duration_seconds']:.2f}s)" if pd.notna(tool["execution_duration_seconds"]) else ""
                                    
                                    with st.expander(f"{status_emoji} `{tool['tool_name']}`{duration_text}"):
                                        # Input
                                        try:
                                            parsed_input = json.loads(tool["input_payload"])
                                            st.markdown("**Arguments**:")
                                            st.json(parsed_input)
                                        except:
                                            st.markdown(f"**Arguments**: `{tool['input_payload']}`")
                                            
                                        # Output
                                        if pd.notna(tool["output_text"]) and tool["output_text"].strip():
                                            st.markdown("**Output**:")
                                            st.code(tool["output_text"])
                                        else:
                                            st.caption("No output returned")
                    st.divider()
            else:
                st.info("No turns found for this session.")
        else:
            st.info("No sessions match the selected filters.")
    else:
        st.info("No session data recorded in dim_sessions yet.")
else:
    st.info("Waiting for DuckDB database read sync...")
