import os
import streamlit as st
import duckdb
import pandas as pd

st.set_page_config(page_title="Trends & Resource Analytics — Aura", layout="wide")

# Styling
st.markdown("""
<style>
    .reportview-container {
        background: #0e1117;
    }
    .chart-container {
        background-color: #1f2937;
        border-radius: 8px;
        padding: 20px;
        border: 1px solid #374151;
        margin-bottom: 20px;
    }
</style>
""", unsafe_allow_html=True)

st.title("📈 Trends & Resource Analytics")
st.caption("Inspect cost curves, cumulative spend, token mix, and tool execution patterns.")

def get_connection():
    db_path = os.getenv("AURA_READ_DB", "/data/aura_read.duckdb")
    if not os.path.exists(db_path):
        st.warning(f"Database not found at {db_path}. Waiting for dbt run...")
        return None
    return duckdb.connect(db_path, read_only=True)

conn = get_connection()

if conn:
    try:
        # Load daily spend
        spend_df = conn.execute("""
            SELECT 
                date,
                model,
                daily_cost,
                daily_input_tokens,
                daily_output_tokens,
                daily_cache_read_tokens,
                turn_count
            FROM fact_daily_spend
            ORDER BY date ASC
        """).df()
        
        # Load tool executions
        tools_df = conn.execute("""
            SELECT 
                tool_name,
                COUNT(*) as count,
                AVG(execution_duration_seconds) as avg_duration,
                SUM(CASE WHEN is_error THEN 1 ELSE 0 END) as error_count
            FROM fact_tool_executions
            GROUP BY tool_name
            ORDER BY count DESC
        """).df()
        
        # Load top sessions
        top_projects_df = conn.execute("""
            SELECT 
                project,
                COUNT(*) as session_count,
                SUM(total_cost) as total_cost,
                SUM(turn_count) as total_turns
            FROM dim_sessions
            GROUP BY project
            ORDER BY total_cost DESC
            LIMIT 10
        """).df()
        
    except Exception as e:
        st.error(f"Error querying marts: {e}")
        spend_df = pd.DataFrame()
        tools_df = pd.DataFrame()
        top_projects_df = pd.DataFrame()
    finally:
        conn.close()

    if not spend_df.empty:
        # Cost Over Time Chart
        st.subheader("💰 Spend Over Time")
        
        # Pivot date by model for multi-series area chart
        cost_pivot = spend_df.pivot(index='date', columns='model', values='daily_cost').fillna(0)
        
        with st.container(border=True):
            st.area_chart(cost_pivot)
            st.caption("Daily spend split by model ($)")
            
        # Divider with Columns
        st.divider()
        col1, col2 = st.columns(2)
        
        # Token Mix
        with col1:
            st.subheader("🪙 Token Mix Breakdown")
            token_mix = spend_df.groupby('model')[['daily_input_tokens', 'daily_output_tokens', 'daily_cache_read_tokens']].sum()
            token_mix.columns = ['Input Tokens', 'Output Tokens', 'Cache Read Tokens']
            
            with st.container(border=True):
                st.bar_chart(token_mix)
                st.caption("Cumulative tokens used split by model")
                
        # Tool execution counts
        with col2:
            st.subheader("🛠️ Tool Executions Frequency")
            if not tools_df.empty:
                tools_chart = tools_df.set_index('tool_name')[['count']]
                with st.container(border=True):
                    st.bar_chart(tools_chart)
                    st.caption("Total times each tool was executed")
            else:
                st.info("No tool executions recorded yet.")
                
        # Workspace Analytics
        st.divider()
        st.subheader("📂 Workspace & Project Activity")
        
        col_proj, col_tool_stats = st.columns(2)
        
        with col_proj:
            st.markdown("##### Top Active Project Directories")
            if not top_projects_df.empty:
                top_projects_df["project_name"] = top_projects_df["project"].apply(lambda x: os.path.basename(str(x)) if pd.notna(x) else "unknown")
                top_projects_styled = top_projects_df[['project_name', 'session_count', 'total_turns', 'total_cost']].copy()
                top_projects_styled.columns = ['Project Directory', 'Sessions', 'Total Turns', 'Cost ($)']
                # Format cost column
                top_projects_styled['Cost ($)'] = top_projects_styled['Cost ($)'].apply(lambda x: f"${x:.4f}")
                st.dataframe(top_projects_styled, use_container_width=True, hide_index=True)
            else:
                st.info("No project session statistics available yet.")
                
        with col_tool_stats:
            st.markdown("##### Tool Execution Details (Performance & Errors)")
            if not tools_df.empty:
                tools_styled = tools_df.copy()
                tools_styled.columns = ['Tool Name', 'Executions', 'Avg Duration (s)', 'Errors']
                # Format avg duration column
                tools_styled['Avg Duration (s)'] = tools_styled['Avg Duration (s)'].apply(lambda x: f"{x:.3f}s" if pd.notna(x) else "N/A")
                st.dataframe(tools_styled, use_container_width=True, hide_index=True)
            else:
                st.info("No detailed tool performance stats available yet.")
    else:
        st.info("No analytical daily rollup data recorded yet. Please wait for the hourly dbt rollup to run.")
else:
    st.info("Waiting for DuckDB database read sync...")
