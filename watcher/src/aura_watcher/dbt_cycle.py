"""The dbt cycle (spec §3.1 step 5) and the read-DB publish (§2.2).

``run_cycle`` runs on the dbt thread: seed + run under ``lake_lock``, then
``publish`` builds a fresh read DB holding only the dashboard tables of
``read_tables.sql`` and swaps ``read/CURRENT`` to it.
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
from importlib.resources import files
from pathlib import Path

import duckdb

from aura_watcher import lake
from aura_watcher.adapters.claude import _unknown_models_pending

READ_TABLES_SQL = files("aura_watcher").joinpath("read_tables.sql").read_text(encoding="utf-8")
STAMP_FORMAT = "v%Y%m%dT%H%M%SZ"
SKIP_MAX_SECONDS = 3600

# Shared with main.py's status JSON; only the dbt thread writes it.
status: dict = {"last_start": None, "last_end": None, "status": None, "cutoff": None, "published": None,
                "publish_seconds": None, "read_db_bytes": None, "read_dir_bytes": None,
                "freshness_lag_seconds": None, "error": None}
_cycle = {"first_done": False, "fingerprint": None, "last_publish": None, "last_max_ts": None}


def _iso(dt=None) -> str:
    return (dt or lake.utcnow()).strftime("%Y-%m-%dT%H:%M:%SZ")


def purge_duckdb_spill_dir(db_path: str) -> tuple[int, int]:
    """Delete the contents of DuckDB's spill dir ``{db_path}.tmp``.

    A process killed mid-spill leaves files there, and on the next start
    DuckDB 1.5.4's temp-size accounting underflows ("16383.9 PiB used") and
    refuses every later spill, i.e. a spurious OOM. Only safe while no DuckDB
    process has the DB open (startup, or before a dbt command). One stuck
    file never aborts the walk.
    """
    files_purged = bytes_purged = 0
    spill_dir = f"{db_path}.tmp"
    if os.path.isdir(spill_dir):
        for root, dirs, names in os.walk(spill_dir, topdown=False):
            for name in names:
                fp = os.path.join(root, name)
                try:
                    size = os.path.getsize(fp)
                    os.remove(fp)
                    files_purged += 1
                    bytes_purged += size
                except OSError as e:
                    print(f"[spill] failed to purge {fp}: {e}")
            for name in dirs:
                try:
                    os.rmdir(os.path.join(root, name))
                except OSError:
                    pass
    if files_purged:
        print(f"[spill] purged {files_purged} file(s) ({bytes_purged} bytes) from {spill_dir}")
    return files_purged, bytes_purged


def dbt_exe() -> str:
    p = Path(sys.executable).parent / ("dbt.exe" if os.name == "nt" else "dbt")
    return str(p) if p.exists() else "dbt"


def dbt_env(cfg) -> dict:
    return {**os.environ, "AURA_DB_PATH": cfg.db_path, "AURA_LAKE_DIR": cfg.lake_dir,
            "AURA_VERDICTS_INBOX": cfg.verdicts_inbox, "TZ": "UTC"}


def dbt(cmd: list[str], cfg, cutoff: str) -> tuple[str, str]:
    """Run one dbt command; returns ``(ok|failed|timeout, output tail)``."""
    argv = [dbt_exe(), *cmd, "--profiles-dir", ".", "--no-partial-parse",
            "--vars", json.dumps({"aura_cutoff": cutoff})]
    print(f"[dbt] {' '.join(cmd)}", flush=True)
    try:
        res = subprocess.run(argv, cwd=cfg.dbt_dir, env=dbt_env(cfg), timeout=cfg.dbt_timeout,
                             capture_output=True, text=True, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return "timeout", f"dbt {' '.join(cmd)} timed out after {cfg.dbt_timeout}s"
    except OSError as e:  # dbt executable missing or not startable
        return "failed", str(e)
    out = (res.stdout or "") + (res.stderr or "")
    print(out[-4000:], flush=True)
    return ("ok" if res.returncode == 0 else "failed"), out[-2000:]


def fingerprint(cfg) -> tuple:
    """Changes whenever dbt could produce different output (C2)."""
    parquet = glob.glob(os.path.join(cfg.lake_dir, "*", "*", "*.parquet"))
    lake_fp = (len(parquet), max((os.path.getmtime(p) for p in parquet if os.path.exists(p)), default=0))
    try:
        st = os.stat(cfg.verdicts_inbox)
        inbox = (st.st_size, st.st_mtime)
    except OSError:
        inbox = None
    code = [os.path.join(cfg.dbt_dir, "dbt_project.yml")]
    for sub in ("models", "seeds", "macros"):
        code += glob.glob(os.path.join(cfg.dbt_dir, sub, "**", "*"), recursive=True)
    code_mtime = max((os.path.getmtime(p) for p in code if os.path.exists(p)), default=0)
    return lake_fp, inbox, cfg.lake_dir, code_mtime


def _retry(fn, *args) -> None:
    """Windows: a reader, Defender or the indexer may hold the file briefly."""
    for i in range(10):
        try:
            return fn(*args)
        except PermissionError:
            if i == 9:
                raise
            time.sleep(0.2)


def _sql_path(p: str) -> str:
    return p.replace("\\", "/").replace("'", "''")


def _dir_bytes(path: str) -> int:
    total = 0
    for root, _, names in os.walk(path):
        for n in names:
            try:
                total += os.path.getsize(os.path.join(root, n))
            except OSError:
                pass
    return total


def read_table_names(sql: str = READ_TABLES_SQL) -> list[str]:
    return [line.split()[2] for line in sql.splitlines() if line.upper().startswith("CREATE TABLE ")]


def _new_stamp(read_dir: str) -> str:
    t = time.time()
    while True:
        stamp = time.strftime(STAMP_FORMAT, time.gmtime(t))
        if not os.path.exists(os.path.join(read_dir, stamp)):
            return stamp
        t += 1  # two publishes within one second (tests): take the next free name


def publish(work_db: str, read_dir: str, artifacts_dir: str, log_error) -> dict | None:
    """Build ``read/<stamp>/aura.duckdb`` from read_tables.sql and point CURRENT
    at it. Published whole or not at all; returns the publish record or None."""
    if os.path.exists(work_db + ".wal"):
        log_error("publish", work_db, "work DB has a .wal after dbt exited; not publishing this cycle")
        return None
    t0 = time.time()
    os.makedirs(read_dir, exist_ok=True)
    stamp = _new_stamp(read_dir)
    dst_dir = os.path.join(read_dir, stamp)
    os.makedirs(dst_dir)
    build = os.path.join(dst_dir, "build.duckdb")
    spill = os.path.join(os.path.dirname(work_db), "publish.tmp")
    shutil.rmtree(spill, ignore_errors=True)
    con = duckdb.connect()
    try:
        con.execute("SET TimeZone = 'UTC'")
        con.execute(f"SET memory_limit = '2GB'; SET temp_directory = '{_sql_path(spill)}'")
        # dbt bakes the catalog "aura" into view SQL, so the work DB must be attached as "aura".
        con.execute(f"ATTACH '{_sql_path(work_db)}' AS aura (READ_ONLY)")
        con.execute(f"ATTACH '{_sql_path(build)}' AS dst")
        con.execute("USE dst")
        con.execute(READ_TABLES_SQL)
        tables = {t: con.execute(f"SELECT count(*) FROM dst.main.{t}").fetchone()[0] for t in read_table_names()}
        max_ts = con.execute("SELECT max(ts) FROM dst.main.fact_model_calls").fetchone()[0]
    except Exception as e:
        con.close()
        shutil.rmtree(dst_dir, ignore_errors=True)
        log_error("publish", work_db, f"read DB build failed: {e}", traceback.format_exc())
        return None
    finally:
        shutil.rmtree(spill, ignore_errors=True)
    con.close()
    target = os.path.join(dst_dir, "aura.duckdb")
    pointer = os.path.join(read_dir, "CURRENT")
    try:
        _retry(os.replace, build, target)
        with open(pointer + ".tmp", "w", encoding="utf-8") as f:
            f.write(stamp + "\n")
        _retry(os.replace, pointer + ".tmp", pointer)
    except OSError as e:
        log_error("publish", target, f"swap failed, previous version stays live: {e}", traceback.format_exc())
        return None
    publish_dt = lake.utcnow()
    prune(read_dir, stamp)
    rec = {"published": stamp, "publish_at": _iso(publish_dt), "publish_seconds": round(time.time() - t0, 3),
           "read_db_bytes": os.path.getsize(target), "tables": tables}
    _append_ndjson(os.path.join(artifacts_dir, "publish.ndjson"), rec)
    rec["read_dir_bytes"] = sum(_dir_bytes(d) for d in glob.glob(os.path.join(read_dir, "v*")))
    rec["max_ts"] = max_ts
    rec["publish_dt"] = publish_dt
    return rec


def read_current(read_dir: str) -> str | None:
    try:
        with open(os.path.join(read_dir, "CURRENT"), encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def prune(read_dir: str, current: str) -> None:
    """Keep CURRENT and the newest older version; anything else goes when no
    reader holds it (PermissionError -> retried next cycle, D5)."""
    versions = sorted(os.path.basename(d) for d in glob.glob(os.path.join(read_dir, "v*")) if os.path.isdir(d))
    older = [v for v in versions if v < current]
    keep = {current, *older[-1:]}
    for v in versions:
        d = os.path.join(read_dir, v)
        if v not in keep:
            shutil.rmtree(d, ignore_errors=True)
            continue
        for stray in ("build.duckdb", "build.duckdb.wal"):
            try:
                os.remove(os.path.join(d, stray))
            except OSError:
                pass


def _append_ndjson(path: str, rec: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, default=str) + "\n")


def _last_ndjson(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            lines = [ln for ln in f if ln.strip()]
        return json.loads(lines[-1]) if lines else None
    except (OSError, ValueError):
        return None


def freshness_lag(max_ts, publish_dt, published: str, artifacts_dir: str) -> float | None:
    """publish time - max(fact_model_calls.ts), or None when max_ts did not
    advance since the previous publish (no new data, so no measurement, F1)."""
    path = os.path.join(artifacts_dir, "freshness.ndjson")
    if _cycle["last_max_ts"] is None:
        last = _last_ndjson(path)
        _cycle["last_max_ts"] = last["max_ts"] if last else ""
    if max_ts is None or max_ts.strftime(lake.TS_FORMAT) <= _cycle["last_max_ts"]:
        return None
    lag = round((publish_dt - max_ts).total_seconds(), 1)
    _cycle["last_max_ts"] = max_ts.strftime(lake.TS_FORMAT)
    _append_ndjson(path, {"published": published, "publish_at": _iso(publish_dt),
                          "max_ts": _cycle["last_max_ts"], "lag_seconds": lag})
    return lag


def copy_artifacts(cfg) -> None:
    os.makedirs(cfg.artifacts_dir, exist_ok=True)
    target = os.path.join(cfg.dbt_dir, "target")
    for name in ("run_results.json", "sources.json", "manifest.json"):
        src = os.path.join(target, name)
        if os.path.exists(src):
            try:
                shutil.copy2(src, os.path.join(cfg.artifacts_dir, name))
            except OSError as e:
                print(f"[dbt] artifact copy failed for {name}: {e}")
    rr = os.path.join(target, "run_results.json")
    if os.path.exists(rr):
        hist = os.path.join(cfg.artifacts_dir, "history")
        os.makedirs(hist, exist_ok=True)
        try:
            shutil.copy2(rr, os.path.join(hist, time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + ".json"))
            for stale in sorted(f for f in os.listdir(hist) if f.endswith(".json"))[:-20]:
                os.remove(os.path.join(hist, stale))
        except OSError as e:
            print(f"[dbt] history archival failed: {e}")


def number_verify(cfg) -> None:
    if shutil.which("node") is None or not os.path.exists(cfg.verify_script):
        return
    env = {**os.environ, "AURA_READ_DIR": cfg.read_dir, "AURA_ARTIFACTS_DIR": cfg.artifacts_dir}
    try:
        res = subprocess.run(["node", cfg.verify_script], env=env, capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=60)
        print(f"[number-verify] rc={res.returncode} {(res.stdout + res.stderr).strip()[-2000:]}", flush=True)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"[number-verify] failed (non-blocking): {e}")


def run_cycle(cfg, log_error, force: bool = False) -> str:
    """One dbt cycle. Returns the status: ok, failed, timeout or skipped."""
    fp = fingerprint(cfg)
    recent = _cycle["last_publish"] is not None and time.time() - _cycle["last_publish"] < SKIP_MAX_SECONDS
    if not force and _cycle["first_done"] and fp == _cycle["fingerprint"] and recent:
        status["status"] = "skipped"
        return "skipped"

    for m in list(_unknown_models_pending):
        _unknown_models_pending.discard(m)
        log_error("unknown_model", None, f"model '{m}' not in MODEL_CONTEXT_WINDOWS / model_pricing.csv; "
                  "add a row to dbt/seeds/model_pricing.csv")

    status.update(last_start=_iso(), last_end=None, error=None)
    purge_duckdb_spill_dir(cfg.db_path)
    with lake.flush_lock:
        cutoff = lake.utcnow().strftime(lake.TS_FORMAT)
    status["cutoff"] = cutoff

    rec = None
    with lake.lake_lock:
        seed, seed_out = dbt(["seed"], cfg, cutoff)
        if seed != "ok":
            log_error("dbt_seed", None, f"dbt seed {seed}: {seed_out[-500:]}")
        run, run_out = dbt(["run"], cfg, cutoff)
        if run == "ok":
            rec = publish(cfg.db_path, cfg.read_dir, cfg.artifacts_dir, log_error)
        else:
            log_error("dbt_run", None, f"dbt run {run}: {run_out[-500:]}")
            status["error"] = run_out[-500:]

    if rec:
        _cycle["last_publish"] = time.time()
        lag = freshness_lag(rec["max_ts"], rec["publish_dt"], rec["published"], cfg.artifacts_dir)
        status.update(published=rec["published"], publish_seconds=rec["publish_seconds"],
                      read_db_bytes=rec["read_db_bytes"], read_dir_bytes=rec["read_dir_bytes"],
                      freshness_lag_seconds=lag)
    result = run
    if run == "ok" and not rec:
        status["error"] = "publish failed"
        result = "failed"
    if run == "ok":
        test, _ = dbt(["test"], cfg, cutoff)
        if test != "ok":
            print("[dbt] tests failed (non-blocking)")
        dbt(["source", "freshness"], cfg, cutoff)

    copy_artifacts(cfg)
    number_verify(cfg)
    _cycle["first_done"] = True
    _cycle["fingerprint"] = fp
    status.update(last_end=_iso(), status=result)
    return result
