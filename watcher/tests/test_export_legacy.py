"""One-time legacy export (spec §4), on a tiny synthetic legacy DB."""
import glob
import json
import os

import duckdb
import pytest

from aura_watcher import export_legacy, lake

N = 25001  # > 2 batches of 10,000
SECRET_PW = "hunter2" + "hunter2"
SECRET_BEARER = "abcdefghijklm" + "nopqrstuvwxyz"
PAYLOADS = {
    5: json.dumps({"password": SECRET_PW}),
    12345: json.dumps({"message": {"content": "Authorization: Bearer " + SECRET_BEARER}}),
    25000: "{not json",
}

LEGACY_DDL = """
CREATE TABLE raw_events (tenant_id TEXT NOT NULL DEFAULT 'local', uuid TEXT NOT NULL, session_id TEXT NOT NULL,
  project_id TEXT, agent TEXT NOT NULL, event_type TEXT NOT NULL, ts TIMESTAMP NOT NULL, file_path TEXT NOT NULL,
  byte_offset BIGINT NOT NULL, parent_uuid TEXT, request_id TEXT, message_id TEXT,
  is_sidechain BOOLEAN NOT NULL DEFAULT FALSE, stop_reason TEXT, cwd TEXT, git_branch TEXT, claude_version TEXT,
  model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_creation_input_tokens INTEGER,
  ephemeral_5m_input_tokens INTEGER, ephemeral_1h_input_tokens INTEGER, cache_read_input_tokens INTEGER,
  context_pct DOUBLE, source TEXT DEFAULT 'claude', reported_cost_usd DOUBLE, payload VARCHAR NOT NULL,
  PRIMARY KEY (tenant_id, uuid));
CREATE TABLE ingest_checkpoints (tenant_id TEXT NOT NULL DEFAULT 'local', file_path TEXT NOT NULL,
  last_offset BIGINT NOT NULL, last_line_uuid TEXT, last_seen_at TIMESTAMP NOT NULL, PRIMARY KEY (tenant_id, file_path));
CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'local', person_id TEXT,
  person_name TEXT, commits INTEGER DEFAULT 0, session_title TEXT, ingested_at TIMESTAMP DEFAULT now(),
  permission_mode TEXT, mode TEXT);
CREATE TABLE raw_session_skills (tenant_id TEXT NOT NULL DEFAULT 'local', session_id TEXT NOT NULL,
  skill_name TEXT NOT NULL, is_initial BOOLEAN DEFAULT FALSE, PRIMARY KEY (tenant_id, session_id, skill_name));
CREATE TABLE raw_session_mcps (tenant_id TEXT NOT NULL DEFAULT 'local', session_id TEXT NOT NULL,
  mcp_server TEXT NOT NULL, first_seen_at TIMESTAMP DEFAULT now(), PRIMARY KEY (tenant_id, session_id, mcp_server));
CREATE TABLE watcher_errors (ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP, source VARCHAR, file_path VARCHAR,
  error_message VARCHAR, stack_trace VARCHAR);
CREATE TABLE session_verdicts (session_id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT 'local',
  verdict TEXT NOT NULL, note TEXT, created_at TIMESTAMP NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id, session_id));
"""


@pytest.fixture
def legacy(tmp_path):
    src = str(tmp_path / "legacy" / "aura.duckdb")
    os.makedirs(os.path.dirname(src))
    con = duckdb.connect(src)
    con.execute(LEGACY_DDL)
    con.execute(f"""
        INSERT INTO raw_events (uuid, session_id, agent, event_type, ts, file_path, byte_offset, payload)
        SELECT 'u' || i, 's' || (i % 7), 'claude', 'user', TIMESTAMP '2026-05-01' + to_minutes(i),
               '/logs/claude/-home-dev-p/s' || (i % 7) || '.jsonl', i, '{{"i": ' || i || '}}'
        FROM range({N}) t(i)""")
    for i, p in PAYLOADS.items():
        con.execute("UPDATE raw_events SET payload = ? WHERE uuid = ?", [p, f"u{i}"])
    con.execute("""
        INSERT INTO session_meta VALUES
          ('s1', 'local', 'dev', 'Dev', 0, 'rotate token=abcdefgh12345678 please', TIMESTAMP '2026-05-03 09:00',
           'default', NULL),
          ('s2', 'local', 'dev', 'Dev', 0, 'plain title', TIMESTAMP '2026-06-01 09:00', NULL, 'plan');
        INSERT INTO raw_session_skills VALUES ('local', 's1', 'docs', TRUE);
        INSERT INTO raw_session_mcps VALUES ('local', 's1', 'plugin:ctx:ctx', TIMESTAMP '2026-05-02 10:00');
        INSERT INTO watcher_errors VALUES (TIMESTAMP '2026-06-01 10:00', 'x', NULL, 'boom', NULL);
        INSERT INTO session_verdicts VALUES ('s1', 'local', 'accepted', 'good', TIMESTAMP '2026-06-02 10:00');
        INSERT INTO ingest_checkpoints VALUES ('local', '/logs/claude/-home-dev-p/s1.jsonl', 10, 'u1', now());
    """)
    con.close()
    data = tmp_path / "data"
    lake.ensure_tables(str(data / "lake"))
    return src, str(data)


def _run(src, data, force=False):
    return export_legacy.export(src, data, os.path.join(data, "lake"), os.path.join(data, "inbox", "v.jsonl"), force)


def _lake_rows(data, table, sql="SELECT *"):
    path = f"{data}/lake/{table}/*/*.parquet".replace("\\", "/")
    con = duckdb.connect()
    cur = con.execute(f"{sql} FROM read_parquet('{path}', hive_partitioning = true, union_by_name = true)")
    cols = [d[0] for d in cur.description]
    out = [dict(zip(cols, r)) for r in cur.fetchall()]
    con.close()
    return out


def test_export_counts_paths_redaction_and_report(legacy):
    src, data = legacy
    before = (os.path.getsize(src), os.path.getmtime(src))
    assert _run(src, data) == 0
    assert (os.path.getsize(src), os.path.getmtime(src)) == before  # legacy DB never written

    events = _lake_rows(data, "raw_events")
    assert len(events) == N == len({e["uuid"] for e in events})
    assert all(e["file_path"].startswith("claude/-home-dev-p/") for e in events)
    assert {str(e["ingested_at"]) for e in events} == {export_legacy.LEGACY_TS}
    by = {e["uuid"]: e["payload"] for e in events}
    assert json.loads(by["u5"]) == {"password": "«REDACTED»"}
    assert SECRET_BEARER not in by["u12345"] and json.loads(by["u12345"])
    assert by["u25000"] == "{not json"
    assert by["u7"] == '{"i": 7}'
    assert all(os.path.basename(f).startswith("legacy-")
               for f in glob.glob(os.path.join(data, "lake", "*", "date=2*", "*.parquet")))

    meta = {m["session_id"]: m for m in _lake_rows(data, "session_meta")}
    assert "abcdefgh12345678" not in meta["s1"]["session_title"]
    assert str(meta["s1"]["date"]) == "2026-05-03" and meta["s2"]["mode"] == "plan"
    assert len(_lake_rows(data, "raw_session_skills")) == len(_lake_rows(data, "raw_session_mcps")) == 1
    assert len(_lake_rows(data, "watcher_errors")) == 1

    with open(os.path.join(data, "artifacts", "export_legacy.json")) as f:
        report = json.load(f)
    assert report["ok"] and report["raw_events"]["invalid_json"] == 1 and report["raw_events"]["redacted"] == 2
    assert report["raw_events"]["batches"] == 3
    assert report["uuids_missing"] == report["uuids_extra"] == 0
    with open(os.path.join(data, "inbox", "v.jsonl")) as f:
        assert json.loads(f.readline())["verdict"] == "accepted"
    assert not os.path.exists(os.path.join(data, "lake.export"))
    assert not os.path.exists(os.path.join(data, "state"))  # checkpoints are not exported


def test_refuses_non_legacy_lake_and_force_keeps_live_files(legacy):
    src, data = legacy
    live = lake.write_rows(os.path.join(data, "lake"), "raw_events", [lake.coerce_row("raw_events", {
        "tenant_id": "local", "uuid": "live1", "session_id": "s", "agent": "claude", "event_type": "user",
        "ts": "2026-11-01T10:00:00Z", "file_path": "claude/p/s.jsonl", "byte_offset": 0, "source": "claude",
        "payload": "{}"})], "2026-11-01 10:00:00.000000", os.path.join(data, "f.ndjson"))
    assert _run(src, data) == 1
    assert _run(src, data, force=True) == 0
    assert os.path.exists(live[0])
    assert len(_lake_rows(data, "raw_events")) == N + 1
    assert _run(src, data, force=True) == 0  # re-export replaces only legacy-* files
    assert len(_lake_rows(data, "raw_events")) == N + 1


def test_staging_mismatch_leaves_lake_untouched(legacy, monkeypatch):
    src, data = legacy
    real = export_legacy.stage

    def drop_one_uuid(con, stage_dir, work_dir):
        out = real(con, stage_dir, work_dir)
        f = export_legacy._files(stage_dir, "raw_events")[0].replace("\\", "/")
        c = duckdb.connect()
        c.execute(f"COPY (SELECT * FROM read_parquet('{f}') LIMIT (SELECT count(*) - 1 FROM read_parquet('{f}'))) "
                  f"TO '{f}.x' (FORMAT parquet)")
        c.close()
        os.replace(f + ".x", f)
        return out

    monkeypatch.setattr(export_legacy, "stage", drop_one_uuid)
    assert _run(src, data) == 1
    assert glob.glob(os.path.join(data, "lake", "*", "*", "legacy-*.parquet")) == []
    with open(os.path.join(data, "artifacts", "export_legacy.json")) as f:
        assert json.load(f)["uuids_missing"] == 1


def test_redaction_off_keeps_payloads(legacy, monkeypatch):
    src, data = legacy
    monkeypatch.setenv("AURA_REDACT_PAYLOAD", "0")
    assert _run(src, data) == 0
    by = {e["uuid"]: e["payload"] for e in _lake_rows(data, "raw_events", "SELECT uuid, payload")}
    assert by["u5"] == PAYLOADS[5] and by["u12345"] == PAYLOADS[12345]
