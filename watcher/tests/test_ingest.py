"""Ingest: incremental reads, truncation/rotation, SDK priming, paths, mode guard."""
import json
import os
import time

import pytest

from aura_watcher import ingest, main
from aura_watcher.adapters.claude import ClaudeAdapter
from aura_watcher.adapters.sdk_trace import SdkTraceAdapter

from .conftest import event


def _ingest(ctx, lp):
    ingest.process_file(ctx, lp)
    assert ingest.flush(ctx)


def test_torn_line_is_not_consumed_until_complete(env):
    full = json.dumps(event("u3"))
    lp = env.write("p/s1.jsonl", [event("u1"), event("u2"), full[:20]], newline=False)
    ctx = env.ctx()
    _ingest(ctx, lp)
    assert sorted(r["uuid"] for r in env.rows("raw_events")) == ["u1", "u2"]
    line2_end = len((json.dumps(event("u1")) + "\n" + json.dumps(event("u2")) + "\n").encode())
    assert ctx.checkpoints[lp]["last_offset"] == line2_end

    env.append("p/s1.jsonl", full[20:] + "\n")
    _ingest(ctx, lp)
    assert sorted(r["uuid"] for r in env.rows("raw_events")) == ["u1", "u2", "u3"]


def test_unterminated_complete_json_is_consumed(env):
    lp = env.write("p/s1.jsonl", [event("u1"), event("u2")], newline=False)
    ctx = env.ctx()
    _ingest(ctx, lp)
    assert len(env.rows("raw_events")) == 2
    assert ctx.checkpoints[lp]["last_offset"] == os.path.getsize(env.logs / "p/s1.jsonl")


def test_truncation_resets_offset_and_stats(env):
    lp = env.write("p/s1.jsonl", [event("u1")])
    ctx = env.ctx()
    head = (env.logs / "p/s1.jsonl").read_bytes()
    ctx.checkpoints[lp] = {"last_offset": 1000, "head_len": len(head), "head_hash": ingest._sha1(head),
                           "last_line_uuid": "x", "sdk_anchor_ts": None, "last_seen_at": "t"}
    ingest.process_file(ctx, lp)
    p = ctx.pending[lp]
    assert p["last_offset"] == len(head)
    assert p["stats"]["reset"] is True and p["stats"]["events_kept"] == 1


def test_rotation_with_same_size_rereads_from_zero(env):
    lp = env.write("p/s1.jsonl", [event("u1")])
    ctx = env.ctx()
    _ingest(ctx, lp)
    size = os.path.getsize(env.logs / "p/s1.jsonl")
    env.write("p/s1.jsonl", [event("x1")])  # same length, different first bytes
    assert os.path.getsize(env.logs / "p/s1.jsonl") == size
    _ingest(ctx, lp)
    assert sorted(r["uuid"] for r in env.rows("raw_events")) == ["u1", "x1"]
    assert ctx.stats[lp]["lines_total"] == 1  # reset, not 2


def test_sdk_priming_keeps_model_and_merges_result(env):
    run_start = {"t": 0.0, "turn": 0, "kind": "run_start", "model": "claude-sonnet-4-6", "cwd": "/w"}
    message = {"t": 1.0, "turn": 1, "kind": "message", "content": "hi"}
    lp = env.write("sdk/run42.jsonl", [run_start, message])
    _ingest(env.ctx(), lp)

    env.append("sdk/run42.jsonl", json.dumps({"t": 2.0, "turn": 1, "kind": "result",
                                              "raw": {"total_cost_usd": 0.5, "usage": {"input_tokens": 3}}}) + "\n")
    ctx = env.ctx()  # restart: fresh adapter, offset > 0
    _ingest(ctx, lp)
    assert isinstance(ctx.adapters[lp], SdkTraceAdapter)
    rows = {r["byte_offset"]: r for r in env.rows("raw_events")}
    msg_off = len((json.dumps(run_start) + "\n").encode())
    res = rows[max(rows)]
    assert res["model"] == "claude-sonnet-4-6"
    assert res["message_id"] == rows[msg_off]["message_id"] == f"run42:{msg_off}"
    # S3: one anchor per file, so ts = anchor + t on every read.
    assert (res["ts"] - rows[msg_off]["ts"]).total_seconds() == 1.0


def test_session_id_fallback_uses_file_stem(env):
    lp = env.write("proj/abc-123.jsonl", [event("u1")])
    _ingest(env.ctx(), lp)
    assert env.rows("raw_events")[0]["session_id"] == "abc-123"


def test_logical_paths_round_trip_both_separators(tmp_path):
    root = str(tmp_path / "logs")
    roots = ingest.make_roots(root, [str(tmp_path / "trace")])
    win = root.replace("/", "\\") + "\\proj\\s.jsonl"
    posix = root.replace("\\", "/") + "/proj/s.jsonl"
    if os.name == "nt":
        assert ingest.logical_path(win, roots) == "claude/proj/s.jsonl"
    assert ingest.logical_path(posix, roots) == "claude/proj/s.jsonl"
    assert ingest.logical_path(str(tmp_path / "trace" / "a" / "b.jsonl"), roots) == "trace1/a/b.jsonl"
    assert ingest.logical_path(str(tmp_path / "elsewhere.jsonl"), roots) is None
    assert ingest.physical_path("claude/proj/s.jsonl", roots) == os.path.join(root, "proj", "s.jsonl")


def test_list_files_oldest_first_and_skips_journals(env):
    old = env.write("p/old.jsonl", [event("a")])
    new = env.write("p/new.jsonl", [event("b")])
    env.write("p/s/subagents/workflows/wf_1/journal.jsonl", ['{"type":"started"}'])
    os.utime(env.logs / "p/old.jsonl", (time.time() - 100, time.time() - 100))
    assert [f[0] for f in ingest.list_files(env.roots)] == [old, new]


def test_adapter_sniffing(env):
    env.write("p/c.jsonl", ["", json.dumps(event("u"))])
    env.write("p/t.jsonl", [{"t": 0, "kind": "run_start"}])
    env.write("p/e.jsonl", [])
    assert isinstance(ingest.adapter_for_file(str(env.logs / "p/c.jsonl")), ClaudeAdapter)
    assert isinstance(ingest.adapter_for_file(str(env.logs / "p/t.jsonl")), SdkTraceAdapter)
    assert isinstance(ingest.adapter_for_file(str(env.logs / "p/e.jsonl")), ClaudeAdapter)


def test_bad_row_is_dropped_and_logged_not_blocking(env):
    """S1: a row that fails a required column is counted and logged; the rest of the file ingests."""
    lp = env.write("p/s1.jsonl", [event("u1"), event("u2", ts="not a time"), event("u3")])
    ctx = env.ctx()
    _ingest(ctx, lp)
    assert sorted(r["uuid"] for r in env.rows("raw_events")) == ["u1", "u3"]
    assert ctx.stats[lp]["parse_errors"] == 1
    assert ingest.flush(ctx) and len(env.rows("watcher_errors")) == 1


def test_mid_file_flush_bounds_memory(env):
    """S12: with AURA_FLUSH_MAX_ROWS=2 a 5-line file is flushed in pieces."""
    lp = env.write("p/s1.jsonl", [event(f"u{i}") for i in range(5)])
    ctx = env.ctx(flush_max_rows=2)
    _ingest(ctx, lp)
    assert len(env.rows("raw_events")) == 5
    assert len(list((env.tmp / "lake" / "raw_events").glob("date=2026-11-01/*.parquet"))) >= 2
    assert ctx.stats[lp]["events_kept"] == 5


def test_fixture_sessions_end_to_end(env):
    env.copy_fixtures()
    ctx = env.ctx()
    queued = []
    ingest.sweep(ctx, queued.append)
    for lp in queued:
        ingest.process_file(ctx, lp)
    assert ingest.flush(ctx)
    events = env.rows("raw_events")
    assert len(events) == 22  # 14 + 4 sidechain + 4; control records carry no uuid
    assert {r["file_path"].split("/")[0] for r in events} == {"claude"}
    assert any(r["file_path"].endswith("subagents/agent-a1b2c3d4e5f60718.jsonl") and r["is_sidechain"] for r in events)
    assert {r["skill_name"] for r in env.rows("raw_session_skills")} == {"docs-writer"}
    assert {r["mcp_server"] for r in env.rows("raw_session_mcps")} == {"plugin:context7:context7"}
    meta = env.rows("session_meta")
    assert {"README run modes section", None} >= {m["session_title"] for m in meta if m["permission_mode"]}
    assert any(m["mode"] == "plan" for m in meta)
    # A second sweep finds nothing new.
    again = []
    ingest.sweep(ctx, again.append)
    assert again == []


def _status(art, mode, age):
    os.makedirs(art, exist_ok=True)
    p = os.path.join(art, main.STATUS_FILE)
    with open(p, "w") as f:
        json.dump({"mode": mode, "host": "box"}, f)
    os.utime(p, (time.time() - age, time.time() - age))


def test_mode_guard(tmp_path, monkeypatch):
    art = str(tmp_path / "artifacts")
    _status(art, "compose", 10)
    assert "compose on box" in main.mode_guard(art, "native")
    assert main.mode_guard(art, "compose") is None
    _status(art, "compose", 200)
    assert main.mode_guard(art, "native") is None

    _status(art, "compose", 10)
    monkeypatch.setenv("AURA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AURA_RUN_MODE", "native")
    with pytest.raises(SystemExit) as e:
        main.startup(main.load_config())
    assert e.value.code == 2
