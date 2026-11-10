import json
import os
import shutil

import duckdb
import pytest

from aura_watcher import ingest, lake, state

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


class Env:
    """A watcher layout under tmp_path: logs root, lake, SQLite state."""

    def __init__(self, tmp_path):
        self.tmp = tmp_path
        self.logs = tmp_path / "logs"
        self.logs.mkdir()
        self.lake = str(tmp_path / "lake")
        self.state_db = str(tmp_path / "state" / "aura_state.sqlite")
        lake.ensure_tables(self.lake)
        self.roots = ingest.make_roots(str(self.logs), [])

    def ctx(self, flush_max_rows=20000):
        con = state.open_state(self.state_db)
        return ingest.new_context(con, self.roots, self.lake, str(self.tmp / "state" / "flush.ndjson"), flush_max_rows)

    def write(self, rel, lines, newline=True):
        p = self.logs / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        text = "".join((ln if isinstance(ln, str) else json.dumps(ln)) + "\n" for ln in lines)
        p.write_bytes((text if newline else text.rstrip("\n")).encode("utf-8"))
        return "claude/" + rel

    def append(self, rel, text):
        with open(self.logs / rel, "ab") as f:
            f.write(text.encode("utf-8"))

    def copy_fixtures(self):
        shutil.copytree(os.path.join(FIXTURES, "claude"), self.logs, dirs_exist_ok=True)

    def rows(self, table, where="true"):
        con = duckdb.connect()
        path = f"{self.lake}/{table}/*/*.parquet".replace("\\", "/")
        sql = f"SELECT * FROM read_parquet('{path}', hive_partitioning = true, union_by_name = true) WHERE {where}"
        cur = con.execute(sql)
        cols = [d[0] for d in cur.description]
        out = [dict(zip(cols, r)) for r in cur.fetchall()]
        con.close()
        return out


@pytest.fixture
def env(tmp_path):
    return Env(tmp_path)


def event(uuid, ts="2026-11-01T10:00:00.000Z", sid=None, **kw):
    d = {"type": "user", "uuid": uuid, "timestamp": ts, "message": {"content": f"line {uuid}"}, **kw}
    if sid:
        d["sessionId"] = sid
    return d
