import os
import streamlit as st
import duckdb
import pandas as pd

st.set_page_config(page_title="Aura — Agent Usage", layout="wide")

# Theme styling
st.markdown("""
<style>
    .reportview-container {
        background: #0e1117;
    }
    .metric-card {
        background-color: #1f2937;
        border-radius: 8px;
        padding: 20px;
        border: 1px solid #374151;
        margin-bottom: 15px;
        box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    }
    .metric-val {
        font-size: 2.2rem;
        font-weight: 700;
        color: #f3f4f6;
    }
    .metric-lbl {
        font-size: 0.9rem;
        color: #9ca3af;
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }
</style>
""", unsafe_allow_html=True)

st.title("🌌 Aura — Agent Usage & Resource Analytics")
st.caption("Real-time telemetry and resource usage reflection for Claude Code.")

def get_connection():
    db_path = os.getenv("AURA_READ_DB", "/data/aura_read.duckdb")
    if not os.path.exists(db_path):
        st.warning(f"Database not found at {db_path}. Waiting for data...")
        return None
    return duckdb.connect(db_path, read_only=True)

@st.fragment(run_every="2s")
def live_metrics():
    conn = get_connection()
    if not conn:
        return
    
    try:
        # Get the most recent assistant event
        df = conn.execute("""
            SELECT context_pct, input_tokens, output_tokens, model, ts, session_id, cwd
            FROM raw_events 
            WHERE event_type = 'assistant' 
            ORDER BY ts DESC LIMIT 1
        """).df()
    except Exception as e:
        st.error(f"Query error: {e}")
        return
    finally:
        conn.close()

    st.subheader("⚡ Live Session Metrics (Right Now)")
    
    if not df.empty:
        row = df.iloc[0]
        
        # Display live metrics cards
        col1, col2, col3 = st.columns(3)
        
        context_val = row['context_pct'] if pd.notna(row['context_pct']) else 0.0
        with col1:
            st.markdown(f"""
            <div class="metric-card">
                <div class="metric-lbl">Context Window Usage</div>
                <div class="metric-val">{context_val:.2%}</div>
            </div>
            """, unsafe_allow_html=True)
            st.progress(min(max(context_val, 0.0), 1.0))
            
        with col2:
            st.markdown(f"""
            <div class="metric-card">
                <div class="metric-lbl">Session Input Tokens</div>
                <div class="metric-val">{row['input_tokens']:,}</div>
            </div>
            """, unsafe_allow_html=True)
            
        with col3:
            st.markdown(f"""
            <div class="metric-card">
                <div class="metric-lbl">Session Output Tokens</div>
                <div class="metric-val">{row['output_tokens']:,}</div>
            </div>
            """, unsafe_allow_html=True)
            
        st.caption(f"Last Event: {row['ts']} | Model: `{row['model']}` | Directory: `{row['cwd']}`")
    else:
        st.info("No active sessions detected. Run a prompt in Claude Code to see live context usage here.")

def daily_totals():
    conn = get_connection()
    if not conn:
        return

    st.divider()
    st.subheader("📅 Today's Totals Summary")
    
    try:
        # Check if fact_daily_spend exists to read dbt rollups, otherwise fallback to raw_events
        tables = [t[0] for t in conn.execute("show tables").fetchall()]
        
        if "fact_daily_spend" in tables:
            # High-fidelity dbt rollup
            df = conn.execute("""
                SELECT 
                    model,
                    SUM(daily_input_tokens) as total_input,
                    SUM(daily_output_tokens) as total_output,
                    SUM(daily_cost) as total_cost,
                    SUM(turn_count) as turns
                FROM fact_daily_spend
                WHERE date = CURRENT_DATE
                GROUP BY model
            """).df()
        else:
            # Inline fallback over raw_events directly
            df = conn.execute("""
                SELECT 
                    model,
                    SUM(input_tokens) as total_input, 
                    SUM(output_tokens) as total_output,
                    0.0 as total_cost, -- Cost is computed in dbt layer
                    COUNT(*) as turns
                FROM raw_events 
                WHERE ts >= CURRENT_DATE AND event_type = 'assistant'
                GROUP BY model
            """).df()
            
    except Exception as e:
        st.error(f"Error querying daily totals: {e}")
        df = pd.DataFrame()
    finally:
        conn.close()

    if not df.empty:
        # Render a KPI summary cards row
        col_spend, col_turns, col_toks = st.columns(3)
        
        tot_cost = df["total_cost"].sum() if "total_cost" in df.columns else 0.0
        tot_turns = df["turns"].sum()
        tot_tokens = df["total_input"].sum() + df["total_output"].sum()
        
        with col_spend:
            st.markdown(f"""
            <div class="metric-card">
                <div class="metric-lbl">Today's Cost</div>
                <div class="metric-val">${tot_cost:.4f}</div>
            </div>
            """, unsafe_allow_html=True)
            
        with col_turns:
            st.markdown(f"""
            <div class="metric-card">
                <div class="metric-lbl">Today's LLM Turns</div>
                <div class="metric-val">{tot_turns:,}</div>
            </div>
            """, unsafe_allow_html=True)
            
        with col_toks:
            st.markdown(f"""
            <div class="metric-card">
                <div class="metric-lbl">Today's Total Tokens</div>
                <div class="metric-val">{tot_tokens:,}</div>
            </div>
            """, unsafe_allow_html=True)
            
        st.markdown("##### Activity Breakdown by Model")
        st.dataframe(df, use_container_width=True, hide_index=True)
    else:
        st.info("No activity recorded for today yet.")

# Layout Render
live_metrics()
daily_totals()
