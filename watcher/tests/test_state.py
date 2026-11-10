"""SQLite state and the flush/checkpoint ordering (at-least-once, C5)."""
import duckdb

from aura_watcher import ingest, lake, state

from .conftest import event


def test_commit_flush_upserts_and_adds_stats(tmp_path):
    con = state.open_state(str(tmp_path / "s.sqlite"))
    stats = {"reset": False, "lines_total": 2, "events_kept": 1, "dropped_known": 1, "dropped_unknown": 0,
             "parse_errors": 0, "last_error": None}
    cp = {"last_offset": 10, "head_len": 5, "head_hash": "h", "last_line_uuid": "u", "sdk_anchor_ts": None}
    state.commit_flush(con, {"claude/a": {**cp, "stats": stats}})
    state.commit_flush(con, {"claude/a": {**cp, "last_offset": 20, "stats": {**stats, "last_error": "e"}}})
    assert state.load_checkpoints(con)["claude/a"]["last_offset"] == 20
    assert state.load_file_stats(con)["claude/a"]["lines_total"] == 4
    state.commit_flush(con, {"claude/a": {**cp, "stats": {**stats, "reset": True}}})
    s = state.load_file_stats(con)["claude/a"]
    assert (s["lines_total"], s["last_error"]) == (2, None)
    state.set_meta(con, "k", "v")
    assert state.get_meta(con, "k") == "v"


def test_crash_between_flush_and_checkpoint_dedups(env, monkeypatch):
    lp = env.write("p/s1.jsonl", [event("u1"), event("u2")])
    ctx = env.ctx()
    ingest.process_file(ctx, lp)

    def boom(con, pending):
        raise RuntimeError("killed")

    monkeypatch.setattr(state, "commit_flush", boom)
    assert ingest.flush(ctx) is False
    monkeypatch.undo()

    restarted = env.ctx()  # the checkpoint never committed, so the same range is re-read
    assert lp not in restarted.checkpoints
    ingest.process_file(restarted, lp)
    assert ingest.flush(restarted)
    assert len(env.rows("raw_events")) == 4

    # stg_lake_event_dups logic (spec §3.2) leaves each uuid once.
    con = duckdb.connect()
    path = f"{env.lake}/raw_events/*/*.parquet".replace("\\", "/")
    con.execute(f"CREATE VIEW src AS SELECT * FROM read_parquet('{path}', hive_partitioning = true, "
                "union_by_name = true, filename = true, file_row_number = true)")
    dedup = con.execute("""
        WITH losers AS (SELECT tenant_id, uuid, filename, file_row_number FROM src
                        QUALIFY row_number() OVER (PARTITION BY tenant_id, uuid
                                                   ORDER BY ingested_at DESC, filename DESC, file_row_number DESC) > 1)
        SELECT uuid FROM src ANTI JOIN losers USING (tenant_id, uuid, filename, file_row_number) ORDER BY uuid
    """).fetchall()
    assert dedup == [("u1",), ("u2",)]


def test_failed_table_write_keeps_buffers_and_retries_only_that_table(env, monkeypatch):
    lp = env.write("p/s1.jsonl", [event("u1")])
    ctx = env.ctx()
    ingest.process_file(ctx, lp)
    real = lake.write_rows

    def flaky(root, table, rows, ingested_at, scratch, prefix="part"):
        if table == "raw_events":
            raise OSError("disk full")
        return real(root, table, rows, ingested_at, scratch, prefix)

    monkeypatch.setattr(lake, "write_rows", flaky)
    assert ingest.flush(ctx) is False
    assert lp not in ctx.checkpoints and lp in ctx.pending
    assert len(ctx.buffers["raw_events"]) == 1 and ctx.buffers["session_meta"] == []

    written = []
    monkeypatch.setattr(lake, "write_rows", lambda root, table, *a, **k: written.append(table) or real(root, table, *a, **k))
    assert ingest.flush(ctx)
    assert "raw_events" in written and "session_meta" not in written
    assert ctx.checkpoints[lp]["last_offset"] > 0
    meta_stamp = env.rows("session_meta")[0]["ingested_at"]
    assert env.rows("raw_events")[0]["ingested_at"] > meta_stamp  # re-stamped at the retry
