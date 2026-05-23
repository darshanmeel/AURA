import os
import streamlit as st
import duckdb
import pandas as pd

st.set_page_config(page_title="Aura — Agent Usage", layout="wide")
st.title("Aura — Agent Usage & Resource Analytics")

def get_connection():
    # Use environment variable or default to local path
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
        df = conn.execute("""
            SELECT context_pct, input_tokens, output_tokens, model, ts
            FROM raw_events 
            WHERE event_type = 'assistant' 
            ORDER BY ts DESC LIMIT 1
        """).df()
    except Exception as e:
        st.error(f"Query error: {e}")
        return
    finally:
        conn.close()

    if not df.empty:
        row = df.iloc[0]
        st.subheader("Live Session Metrics")
        col1, col2, col3 = st.columns(3)
        col1.metric("Context Usage", f"{row['context_pct']:.2%}")
        col2.metric("Input Tokens", f"{row['input_tokens']:,}")
        col3.metric("Output Tokens", f"{row['output_tokens']:,}")
        st.caption(f"Last updated: {row['ts']} (Model: {row['model']})")
    else:
        st.info("No assistant messages found in the database yet.")

def daily_totals():
    conn = get_connection()
    if not conn:
        return

    st.divider()
    st.subheader("Today's Totals")
    
    try:
        df = conn.execute("""
            SELECT 
                model,
                sum(input_tokens) as total_input, 
                sum(output_tokens) as total_output,
                count(*) as turns
            FROM raw_events 
            WHERE ts >= CURRENT_DATE AND event_type = 'assistant'
            GROUP BY model
        """).df()
    except Exception as e:
        st.error(f"Query error: {e}")
        return
    finally:
        conn.close()

    if not df.empty:
        st.dataframe(df, use_container_width=True)
    else:
        st.info("No activity recorded for today.")

# Layout
live_metrics()
daily_totals()
