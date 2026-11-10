"""dbt cycle and read-DB publish (spec §2.2, §2.2.1, §6.1)."""
import glob
import json
import os
import subprocess
import threading
import time
from datetime import datetime, timedelta
from types import SimpleNamespace

import duckdb
import pytest

from aura_watcher import dbt_cycle, lake

# The §2.2.1 contract: read table -> exact columns.
EXPECTED = {
    "dim_sessions": ["tenant_id", "session_id", "total_cost"],
    "dim_apps": ["tenant_id", "app_id", "cwd", "total_cost"],
    "dim_people": ["tenant_id", "person_id", "total_cost"],
    "dim_projects": ["tenant_id", "project_id", "project_name", "app_count", "session_count", "total_cost",
                     "total_turns"],
    "dim_agents": ["tenant_id", "agent", "app_id", "project_id", "first_seen", "last_seen", "session_count",
                   "total_cost", "total_output_tokens", "total_tool_calls", "total_turns"],
    "fact_model_calls": ["tenant_id", "event_uuid", "session_id", "ts", "model", "agent", "source", "input_tokens",
                         "output_tokens", "cache_read_input_tokens", "ephemeral_5m_input_tokens",
                         "ephemeral_1h_input_tokens", "calculated_cost", "reported_cost_usd"],
    "fact_daily_spend": ["tenant_id", "date", "model", "provider", "daily_cost", "session_count", "turn_count"],
    "fact_hourly_activity": ["day_of_week", "hour_of_day", "turn_count", "total_cost", "session_starts"],
    "fact_spend_pace": ["tenant_id", "today_cost", "today_pace_hourly", "today_turn_count", "hours_elapsed_today",
                        "avg_30d_cost", "avg_30d_turns", "avg_30d_tools"],
    "fact_prompts": ["tenant_id", "prompt_id", "prompt_idx", "session_id", "prompt_ts", "next_prompt_ts", "agent",
                     "app_id", "model_primary", "models_used", "complexity_tier", "is_overkill", "overkill_reason",
                     "prompt_origin", "prompt_chars", "prompt_text_200", "prompt_text_full", "summary_200",
                     "cost_total", "output_tokens_total", "cache_hit_rate", "duration_seconds", "ttft_seconds",
                     "turn_count", "tool_call_count", "tool_signature", "retry_count", "errors_caught",
                     "files_edited", "final_stop_reason"],
    "fact_turns": ["tenant_id", "turn_id", "session_id", "turn_number", "user_ts", "assistant_ts",
                   "assistant_event_uuid", "model", "input_tokens", "output_tokens", "cache_read_input_tokens",
                   "ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens", "context_pct", "is_sidechain",
                   "calculated_cost", "stop_reason"],
    "dim_turn_messages": ["tenant_id", "session_id", "turn_id", "user_prompt", "assistant_response"],
    "fact_tool_executions": ["tenant_id", "session_id", "assistant_event_uuid", "tool_name", "model", "tool_call_ts",
                             "tool_result_ts", "execution_duration_seconds", "is_error", "target_file",
                             "subagent_type", "skill_name"],
    "fact_git_commands": ["tenant_id", "session_id", "ts", "git_op", "raw_command", "is_error", "output_text"],
    "fact_errors": ["tenant_id", "session_id", "ts", "kind", "tool", "message", "severity", "turn_number",
                    "resolved_in_turns"],
    "fact_session_files": ["tenant_id", "session_id", "file_path", "file_ext", "edit_count", "write_count",
                           "cost_attributed", "tokens_attributed", "duration_attributed_seconds"],
    "int_entity_spend": ["tenant_id", "entity_type", "entity_id", "project_id", "date", "cost"],
    "int_app_cwd_lookup": ["tenant_id", "cwd", "app_id"],
    "int_event_agent": ["tenant_id", "event_uuid", "session_id", "agent_resolved"],
    "stg_session_skills": ["tenant_id", "session_id", "skill_name"],
    "stg_session_mcps": ["tenant_id", "session_id", "mcp_server"],
    "stg_session_meta": ["tenant_id", "session_id", "person_id", "person_name", "session_title", "permission_mode",
                         "mode"],
    "stg_watcher_errors": ["ts", "source", "file_path", "error_message", "stack_trace"],
    "recent_events": ["tenant_id", "uuid", "session_id", "agent", "event_type", "ts", "date", "message_id", "model",
                      "cwd", "git_branch", "claude_version", "input_tokens", "output_tokens", "cache_read_input_tokens",
                      "ephemeral_5m_input_tokens", "ephemeral_1h_input_tokens", "context_pct", "byte_offset"],
    "model_pricing": ["tenant_id", "model", "cost_input_per_mtok"],
}
EXTRA = {  # columns the work DB has but the read DB must not
    "dim_projects": ["all_cwds"], "fact_model_calls": ["model_call_id"], "fact_prompts": ["sub_agents_dispatched"],
    "fact_turns": ["user_prompt", "assistant_response"], "dim_turn_messages": ["user_event_uuid"],
    "fact_tool_executions": ["input_payload", "output_text"], "stg_session_meta": ["ingested_at"],
    "recent_events": ["payload", "file_path"],
}
TYPES = {"ts": "TIMESTAMP", "date": "DATE"}
SOURCE = {"recent_events": "stg_events"}


def make_work_db(path, drop=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    con = duckdb.connect(path)  # basename aura.duckdb -> catalog "aura", like dbt's
    for read, cols in EXPECTED.items():
        if read == "int_app_cwd_lookup":
            continue
        src = SOURCE.get(read, read)
        extracted = ("target_file", "subagent_type", "skill_name")
        all_cols = [c for c in cols if not (read == "fact_tool_executions" and c in extracted)]
        all_cols += EXTRA.get(read, [])
        con.execute(f"CREATE TABLE {src} (" + ", ".join(f'"{c}" {TYPES.get(c, "VARCHAR")}' for c in all_cols) + ")")
        con.execute(f"INSERT INTO {src} (tenant_id) VALUES ('local')" if "tenant_id" in all_cols
                    else f"INSERT INTO {src} (ts) VALUES (now())" if "ts" in all_cols
                    else f"INSERT INTO {src} (day_of_week) VALUES ('1')")
    con.execute("CREATE VIEW int_app_cwd_lookup AS SELECT tenant_id, cwd, app_id FROM aura.main.dim_apps")
    con.execute("UPDATE fact_prompts SET prompt_text_full = repeat('p', 30000)")
    con.execute("UPDATE dim_turn_messages SET user_prompt = repeat('u', 30000), assistant_response = 'a'")
    con.execute("UPDATE fact_git_commands SET output_text = repeat('g', 1000)")
    con.execute("UPDATE fact_tool_executions SET input_payload = '{\"file_path\": \"/a.py\", \"subagent_type\": \"x\"}',"
                " output_text = repeat('o', 1000)")
    con.execute("UPDATE fact_model_calls SET ts = TIMESTAMP '2026-11-01 10:00:00'")
    con.execute("DELETE FROM stg_events")
    con.execute("INSERT INTO stg_events (uuid, \"date\", ts, payload) VALUES "
                "('recent', current_date - 2, now(), '{}'), ('old', current_date - 20, now(), '{}')")
    con.execute("CREATE TABLE stg_tool_results (x VARCHAR); CREATE TABLE raw_x (x VARCHAR)")
    if drop:
        con.execute(f"DROP TABLE {drop}")
    con.close()


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.setattr(dbt_cycle, "_cycle", {"first_done": False, "fingerprint": None, "last_publish": None,
                                              "last_max_ts": None})
    monkeypatch.setattr(dbt_cycle, "status", dict(dbt_cycle.status))
    dbt_dir = tmp_path / "dbt"
    (dbt_dir / "seeds").mkdir(parents=True)
    (dbt_dir / "dbt_project.yml").write_text("name: aura\n")
    (dbt_dir / "seeds" / "model_pricing.csv").write_text("model\n")
    c = SimpleNamespace(db_path=str(tmp_path / "work" / "aura.duckdb"), lake_dir=str(tmp_path / "lake"),
                        read_dir=str(tmp_path / "read"), artifacts_dir=str(tmp_path / "artifacts"),
                        verdicts_inbox=str(tmp_path / "inbox.jsonl"), dbt_dir=str(dbt_dir), dbt_timeout=5,
                        verify_script=str(tmp_path / "missing.mjs"))
    lake.ensure_tables(c.lake_dir)
    make_work_db(c.db_path)
    return c


class Errors(list):
    def __call__(self, source, file_path, message, stack=None):
        self.append((source, message))


def _versions(read_dir):
    return sorted(os.path.basename(d) for d in glob.glob(os.path.join(read_dir, "v*")))


def test_publish_contents(cfg):
    errors = Errors()
    rec = dbt_cycle.publish(cfg.db_path, cfg.read_dir, cfg.artifacts_dir, errors)
    assert errors == [] and rec is not None
    assert dbt_cycle.read_current(cfg.read_dir) == rec["published"]
    db = os.path.join(cfg.read_dir, rec["published"], "aura.duckdb")
    assert not os.path.exists(os.path.join(cfg.read_dir, rec["published"], "build.duckdb"))
    con = duckdb.connect(db, read_only=True)
    names = sorted(r[0] for r in con.execute("SELECT table_name FROM duckdb_tables()").fetchall())
    assert names == sorted(dbt_cycle.read_table_names()) == sorted(EXPECTED)
    assert con.execute("SELECT count(*) FROM duckdb_views() WHERE NOT internal").fetchone()[0] == 0
    for t, cols in EXPECTED.items():
        got = [r[0] for r in con.execute(f"DESCRIBE {t}").fetchall()]
        assert sorted(got) == sorted(cols), t
    assert con.execute("SELECT max(length(prompt_text_full)) FROM fact_prompts").fetchone()[0] == 20000
    assert con.execute("SELECT max(length(user_prompt)) FROM dim_turn_messages").fetchone()[0] == 20000
    assert con.execute("SELECT max(length(output_text)) FROM fact_git_commands").fetchone()[0] == 80
    assert con.execute("SELECT target_file, subagent_type FROM fact_tool_executions").fetchone() == ("/a.py", "x")
    assert con.execute("SELECT uuid FROM recent_events").fetchall() == [("recent",)]
    con.close()
    with open(os.path.join(cfg.artifacts_dir, "publish.ndjson")) as f:
        lines = [json.loads(ln) for ln in f]
    assert len(lines) == 1 and lines[0]["read_db_bytes"] > 0 and lines[0]["tables"]["recent_events"] == 1


def test_publish_failure_leaves_current(cfg):
    errors = Errors()
    first = dbt_cycle.publish(cfg.db_path, cfg.read_dir, cfg.artifacts_dir, errors)
    os.remove(cfg.db_path)
    make_work_db(cfg.db_path, drop="fact_errors")
    assert dbt_cycle.publish(cfg.db_path, cfg.read_dir, cfg.artifacts_dir, errors) is None
    assert _versions(cfg.read_dir) == [first["published"]]
    assert dbt_cycle.read_current(cfg.read_dir) == first["published"]
    assert errors and errors[0][0] == "publish"


def test_publish_refuses_with_wal(cfg):
    open(cfg.db_path + ".wal", "w").close()
    errors = Errors()
    assert dbt_cycle.publish(cfg.db_path, cfg.read_dir, cfg.artifacts_dir, errors) is None
    assert _versions(cfg.read_dir) == [] and errors


def test_publish_swap_and_prune_with_open_reader(cfg):
    pub = lambda: dbt_cycle.publish(cfg.db_path, cfg.read_dir, cfg.artifacts_dir, Errors())  # noqa: E731
    v1 = pub()["published"]
    reader = duckdb.connect(os.path.join(cfg.read_dir, v1, "aura.duckdb"), read_only=True)
    v2 = pub()["published"]
    assert dbt_cycle.read_current(cfg.read_dir) == v2 and _versions(cfg.read_dir) == [v1, v2]
    rec = pub()
    v3 = rec["published"]
    assert dbt_cycle.read_current(cfg.read_dir) == v3
    left = _versions(cfg.read_dir)
    # v1 goes now, or (when the OS refuses to delete a file a reader holds) on a later prune.
    assert left in ([v2, v3], [v1, v2, v3])
    assert rec["read_dir_bytes"] == sum(dbt_cycle._dir_bytes(os.path.join(cfg.read_dir, v)) for v in left)
    reader.close()
    dbt_cycle.prune(cfg.read_dir, v3)
    assert _versions(cfg.read_dir) == [v2, v3]


class FakeDbt:
    def __init__(self, run_rc=0, timeout=False):
        self.calls = []
        self.run_rc = run_rc
        self.timeout = timeout

    def __call__(self, argv, **kw):
        self.calls.append(argv)
        cmd = argv[1]
        if self.timeout and cmd == "run":
            raise subprocess.TimeoutExpired(argv, kw["timeout"])
        return subprocess.CompletedProcess(argv, self.run_rc if cmd == "run" else 0, "out", "")


def test_run_cycle_ok_argv_and_publish(cfg, monkeypatch):
    fake = FakeDbt()
    monkeypatch.setattr(dbt_cycle.subprocess, "run", fake)
    assert dbt_cycle.run_cycle(cfg, Errors()) == "ok"
    assert [c[1] for c in fake.calls] == ["seed", "run", "test", "source"]
    argv = fake.calls[1]
    i = argv.index("--profiles-dir")
    assert argv[i:i + 4] == ["--profiles-dir", ".", "--no-partial-parse", "--vars"]
    assert json.loads(argv[i + 4]) == {"aura_cutoff": dbt_cycle.status["cutoff"]}
    assert dbt_cycle.status["published"] == dbt_cycle.read_current(cfg.read_dir)


def test_run_cycle_failure_and_timeout_do_not_publish(cfg, monkeypatch):
    errors = Errors()
    monkeypatch.setattr(dbt_cycle.subprocess, "run", FakeDbt(run_rc=1))
    assert dbt_cycle.run_cycle(cfg, errors) == "failed"
    monkeypatch.setattr(dbt_cycle.subprocess, "run", FakeDbt(timeout=True))
    assert dbt_cycle.run_cycle(cfg, errors, force=True) == "timeout"
    assert dbt_cycle.read_current(cfg.read_dir) is None
    assert [e[0] for e in errors] == ["dbt_run", "dbt_run"]


def test_publish_runs_under_lake_lock(cfg, monkeypatch):
    monkeypatch.setattr(dbt_cycle.subprocess, "run", FakeDbt())
    seen = []
    real = dbt_cycle.publish

    def spy(*a):
        seen.append(lake.compact(cfg.lake_dir, "2026-11-02", os.path.dirname(cfg.db_path), 50, print))
        return real(*a)

    monkeypatch.setattr(dbt_cycle, "publish", spy)
    dbt_cycle.run_cycle(cfg, Errors())
    assert seen == [False]


def test_cutoff_waits_for_a_running_flush(cfg, monkeypatch):
    monkeypatch.setattr(dbt_cycle.subprocess, "run", FakeDbt())
    held = threading.Event()
    released = {}

    def flush():
        with lake.flush_lock:
            held.set()
            time.sleep(0.3)
            released["at"] = lake.utcnow().strftime(lake.TS_FORMAT)

    t = threading.Thread(target=flush)
    t.start()
    held.wait()
    dbt_cycle.run_cycle(cfg, Errors())
    t.join()
    assert dbt_cycle.status["cutoff"] >= released["at"]


def test_skip_when_unchanged_except_first_cycle(cfg, monkeypatch):
    fake = FakeDbt()
    monkeypatch.setattr(dbt_cycle.subprocess, "run", fake)
    assert dbt_cycle.run_cycle(cfg, Errors()) == "ok"  # first cycle always runs
    assert dbt_cycle.run_cycle(cfg, Errors()) == "skipped"
    seed = os.path.join(cfg.dbt_dir, "seeds", "model_pricing.csv")
    t = time.time() + 5
    os.utime(seed, (t, t))
    assert dbt_cycle.run_cycle(cfg, Errors()) == "ok"


def test_freshness_lag(cfg):
    art = cfg.artifacts_dir
    pub = datetime(2026, 11, 1, 10, 5, 0)
    assert dbt_cycle.freshness_lag(datetime(2026, 11, 1, 10, 0, 0), pub, "v1", art) == 300.0
    assert dbt_cycle.freshness_lag(datetime(2026, 11, 1, 10, 0, 0), pub + timedelta(minutes=5), "v2", art) is None
    with open(os.path.join(art, "freshness.ndjson")) as f:
        lines = [json.loads(ln) for ln in f]
    assert lines == [{"published": "v1", "publish_at": "2026-11-01T10:05:00Z", "max_ts": "2026-11-01 10:00:00.000000",
                      "lag_seconds": 300.0}]


def test_purge_spill_dir(tmp_path, monkeypatch):
    db = str(tmp_path / "aura.duckdb")
    assert dbt_cycle.purge_duckdb_spill_dir(db) == (0, 0)  # missing dir is a no-op
    spill = tmp_path / "aura.duckdb.tmp" / "sub"
    spill.mkdir(parents=True)
    (spill / "a.block").write_bytes(b"x" * 10)
    (spill.parent / "b.block").write_bytes(b"y" * 5)
    real = os.remove

    def stuck(p):
        if p.endswith("b.block"):
            raise PermissionError("locked")
        real(p)

    monkeypatch.setattr(dbt_cycle.os, "remove", stuck)
    assert dbt_cycle.purge_duckdb_spill_dir(db) == (1, 10)  # one stuck file never aborts the walk
    assert not spill.exists()
