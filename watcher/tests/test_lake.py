"""Lake: schemas, coercion, atomic writes, empty schema files, compaction."""
import glob
import os

import duckdb
import pytest

from aura_watcher import lake

TS = "2026-11-01 10:00:00.000000"


def _event(uuid, **kw):
    return lake.coerce_row("raw_events", {"tenant_id": "local", "uuid": uuid, "session_id": "s", "agent": "claude",
                                          "event_type": "user", "ts": "2026-11-01T10:00:00Z", "file_path": "claude/p/s",
                                          "byte_offset": 0, "source": "claude", "payload": "{}", **kw})


def _describe(path):
    con = duckdb.connect()
    cols = con.execute(f"DESCRIBE SELECT * FROM read_parquet('{path}', hive_partitioning = false)").fetchall()
    con.close()
    return {c[0]: c[1] for c in cols}


def test_all_null_columns_keep_declared_types(tmp_path):
    files = lake.write_rows(str(tmp_path), "raw_events", [_event("u1")], TS, str(tmp_path / "f.ndjson"))
    types = _describe(files[0])
    assert types == {c: t for c, t in lake.SCHEMAS["raw_events"]}
    assert all(cols[-1] == ("ingested_at", "TIMESTAMP") for cols in lake.SCHEMAS.values())


def test_coerce_row_required_and_defaults():
    with pytest.raises(ValueError):
        lake.coerce_row("raw_events", {"uuid": "u", "tenant_id": "local"})
    row = _event("u1", is_sidechain=None, input_tokens="12", context_pct="x", ts="2026-11-01T12:00:00+02:00")
    assert row["is_sidechain"] is False
    assert row["input_tokens"] == 12
    assert row["context_pct"] is None  # optional column that fails coercion -> NULL
    assert row["ts"] == "2026-11-01 10:00:00.000000"  # Q2: offset normalised to naive UTC
    assert _event("u2", output_tokens=2**40)["output_tokens"] is None  # INTEGER overflow -> NULL, not a poison row


def test_lone_surrogate_does_not_poison_the_write(tmp_path):
    rows = [_event("u1", cwd="bad\ud800path")]
    files = lake.write_rows(str(tmp_path), "raw_events", rows, TS, str(tmp_path / "f.ndjson"))
    assert len(files) == 1


def test_atomic_write_leaves_no_parquet_on_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(lake, "_ndjson_columns", lambda t: "{not valid}")
    with pytest.raises(duckdb.Error):
        lake.write_rows(str(tmp_path), "raw_events", [_event("u1")], TS, str(tmp_path / "f.ndjson"))
    assert glob.glob(str(tmp_path / "raw_events" / "*" / "*")) == []


def test_ensure_tables_creates_readable_empty_files(tmp_path):
    lake.ensure_tables(str(tmp_path))
    con = duckdb.connect()
    for t in lake.SCHEMAS:
        path = f"{tmp_path}/{t}/*/*.parquet".replace("\\", "/")
        assert con.execute(f"SELECT count(*) FROM read_parquet('{path}')").fetchone()[0] == 0
    con.close()


def _three_files(tmp_path):
    root = str(tmp_path)
    scratch = str(tmp_path / "f.ndjson")
    lake.write_rows(root, "raw_events", [_event("u1", model="old"), _event("u2")], "2026-11-01 11:00:00.000000", scratch)
    lake.write_rows(root, "raw_events", [_event("u1", model="new")], "2026-11-01 12:00:00.000000", scratch)
    lake.write_rows(root, "raw_events", [_event("u3")], "2026-11-01 13:00:00.000000", scratch)
    return os.path.join(root, "raw_events", "date=2026-11-01")


def test_compaction_dedups_latest_wins_and_deletes_inputs(tmp_path):
    part = _three_files(tmp_path)
    errors = []
    assert lake.compact(str(tmp_path), "2026-11-02", str(tmp_path / "work"), 50, lambda *a: errors.append(a))
    files = glob.glob(os.path.join(part, "*.parquet"))
    assert len(files) == 1 and os.path.basename(files[0]).startswith("compacted-")
    assert "date" not in _describe(files[0].replace("\\", "/"))
    con = duckdb.connect()
    rows = dict(con.execute(f"SELECT uuid, model FROM read_parquet('{files[0]}')".replace("\\", "/")).fetchall())
    assert rows == {"u1": "new", "u2": None, "u3": None}
    assert errors == []


def test_compaction_skips_today_below_threshold(tmp_path):
    part = _three_files(tmp_path)
    lake.compact(str(tmp_path), "2026-11-01", str(tmp_path / "work"), 50, print)
    assert len(glob.glob(os.path.join(part, "*.parquet"))) == 3


def test_compaction_verify_mismatch_keeps_inputs(tmp_path, monkeypatch):
    part = _three_files(tmp_path)
    errors = []
    monkeypatch.setattr(lake, "parquet_rows", lambda con, path: -1)
    monkeypatch.setattr(lake, "_bad_partitions", set())
    lake.compact(str(tmp_path), "2026-11-02", str(tmp_path / "work"), 50, lambda *a: errors.append(a))
    names = [os.path.basename(f) for f in glob.glob(os.path.join(part, "*.parquet"))]
    assert len(names) == 3 and not any(n.startswith("compacted-") for n in names)
    assert errors and errors[0][0] == "compaction"


def test_compaction_does_nothing_while_lake_lock_is_held(tmp_path):
    part = _three_files(tmp_path)
    with lake.lake_lock:
        assert lake.compact(str(tmp_path), "2026-11-02", str(tmp_path / "work"), 50, print) is False
    assert len(glob.glob(os.path.join(part, "*.parquet"))) == 3


def test_clean_tmp(tmp_path):
    d = tmp_path / "raw_events" / "date=2026-11-01"
    d.mkdir(parents=True)
    (d / "part-x.parquet.tmp").write_text("x")
    assert lake.clean_tmp(str(tmp_path)) == 1
    assert list(d.iterdir()) == []
