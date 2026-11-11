"""One-off: move staging + intermediate tables from the work DB into the DuckLake
stage (Parquet), slim the marts' long-text columns, then compact the work DB.
Run with Aura stopped:  .venv/Scripts/python scripts/migrate_to_stage.py data/<user>/work/aura.duckdb
Idempotent: tables already in the stage are skipped."""
import os
import sys
import time
from pathlib import Path

import duckdb

from aura_watcher.dbt_cycle import _sql_path, attach_stage, compact, stage_dir

work = sys.argv[1]
models = Path(__file__).resolve().parents[1] / "dbt" / "models"
names = sorted(p.stem for d in ("staging", "intermediate") for p in (models / d).glob("*.sql"))
gb = lambda: f"{os.path.getsize(work) / 1e9:.1f} GB"  # noqa: E731
print("work DB before:", gb())

os.makedirs(os.path.join(stage_dir(work), "files"), exist_ok=True)
con = duckdb.connect(work)
con.execute(f"SET memory_limit = '4GB'; SET temp_directory = '{_sql_path(work + '.tmp')}'")
attach_stage(con, work)
kind = dict(con.execute("SELECT table_name, table_type FROM information_schema.tables "
                        "WHERE table_catalog = 'aura' AND table_schema = 'main'").fetchall())
staged = {r[0] for r in con.execute("SELECT table_name FROM information_schema.tables "
                                    "WHERE table_catalog = 'stage'").fetchall()}

# Views first: they reference the tables about to move. dbt recreates them in the stage.
for n in names:
    if kind.get(n) == "VIEW":
        con.execute(f"DROP VIEW aura.main.{n}")
for n in names:
    if kind.get(n) != "BASE TABLE":
        continue
    t0 = time.time()
    if n not in staged:
        con.execute(f"CREATE TABLE stage.main.{n} AS SELECT * FROM aura.main.{n}")
    con.execute(f"DROP TABLE aura.main.{n}")
    print(f"moved {n} in {time.time() - t0:.0f}s", flush=True)
con.execute("DROP TABLE IF EXISTS aura.main.fact_tool_executions__dbt_backup")

# Marts keep extracted keys and ~2,000 words of text; full payloads stay in the stage.
cols = [r[0] for r in con.execute("DESCRIBE aura.main.fact_tool_executions").fetchall()]
if "input_payload" in cols:
    con.execute("""
        CREATE TABLE aura.main.fte_new AS SELECT
            tenant_id, session_id, assistant_event_uuid, message_id, cwd, tool_use_id, tool_call_ts,
            tool_result_ts, model, tool_name,
            json_extract_string(CAST(input_payload AS VARCHAR), '$.file_path')     AS target_file,
            json_extract_string(CAST(input_payload AS VARCHAR), '$.subagent_type') AS subagent_type,
            json_extract_string(CAST(input_payload AS VARCHAR), '$.skill')         AS skill_name,
            left(json_extract_string(CAST(input_payload AS VARCHAR), '$.command'), 12000) AS command,
            left(output_text, 12000) AS output_text,
            is_error, execution_duration_seconds, _built_at
        FROM aura.main.fact_tool_executions""")
    con.execute("DROP TABLE aura.main.fact_tool_executions")
    con.execute("ALTER TABLE aura.main.fte_new RENAME TO fact_tool_executions")
    print("slimmed fact_tool_executions", flush=True)
con.execute("UPDATE aura.main.fact_prompts SET prompt_text_full = left(prompt_text_full, 12000) "
            "WHERE length(prompt_text_full) > 12000")
con.execute("CHECKPOINT stage")
con.execute("CHECKPOINT")
con.close()

compact(work)
print("work DB after:", gb())
