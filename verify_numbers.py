"""Reconciliation: compare /api/dashboard against DuckDB direct queries.

Run inside the watcher container (has python+duckdb+/data mount,
can reach frontend at http://frontend:3000 via the compose network).
"""
import json
import sys
import urllib.request

import duckdb

DB_PATH = "/data/read/aura.duckdb"
API_URL = "http://frontend:3000/api/dashboard?range=all"
TOL_ABS = 0.01
TOL_REL = 0.01


def fetch_api():
    with urllib.request.urlopen(API_URL, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def close(a, b):
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    try:
        af = float(a)
        bf = float(b)
    except (TypeError, ValueError):
        return a == b
    if abs(af - bf) <= TOL_ABS:
        return True
    base = max(abs(af), abs(bf), 1.0)
    return abs(af - bf) / base <= TOL_REL


def show(label, api_v, db_v):
    ok = close(api_v, db_v)
    mark = "MATCH" if ok else "MISMATCH"
    print(f"{label:<40} api={api_v!s:<25} db={db_v!s:<25} {mark}")
    return ok


def one(con, sql):
    row = con.sql(sql).fetchone()
    return row[0] if row else None


def main():
    api = fetch_api()
    if not api or not api.get("kpis"):
        print("API returned empty payload — cannot reconcile.")
        sys.exit(2)

    con = duckdb.connect(DB_PATH, read_only=True)
    fails = 0

    print("=== KPIs ===")
    kp = api["kpis"]
    checks = [
        ("kpis.total_sessions",  kp.get("total_sessions"),
            one(con, "select count(distinct session_id) from dim_sessions")),
        ("kpis.total_cost",      kp.get("total_cost"),
            one(con, "select coalesce(sum(total_cost), 0) from dim_sessions")),
        ("kpis.total_turns",     kp.get("total_turns"),
            one(con, "select coalesce(sum(turn_count), 0) from dim_sessions")),
        ("kpis.total_apps",      kp.get("total_apps"),
            one(con, "select count(distinct cwd) from dim_sessions")),
        ("kpis.total_people",    kp.get("total_people"),
            one(con, "select count(distinct person_id) from dim_sessions where person_id is not null")),
        ("kpis.total_tool_calls", kp.get("total_tool_calls"),
            one(con, "select sum(tools_used) from dim_sessions")),
    ]
    for label, a, b in checks:
        if not show(label, a, b):
            fails += 1

    print("\n=== Section sizes (row counts) ===")
    section_checks = [
        ("topApps.rows",    len(api.get("topApps", []))),
        ("topAgents.rows",  len(api.get("topAgents", []))),
        ("toolMix.rows",    len(api.get("toolMix", []))),
        ("providers.rows",  len(api.get("providers", []))),
        ("models.rows",     len(api.get("models", []))),
        ("topFiles.rows",   len(api.get("topFiles", []))),
        ("topPeople.rows",  len(api.get("topPeople", []))),
        ("dailySpend.rows", len(api.get("dailySpend", []))),
        ("recentErrors.rows", len(api.get("recentErrors", []))),
    ]
    for label, n in section_checks:
        print(f"{label:<40} api={n}")

    print("\n=== Top-of-list spot checks ===")
    top_apps = api.get("topApps", [])
    if top_apps:
        a0 = top_apps[0]
        db_top_app = con.sql(
            "select app_id, sum(total_cost) as c from dim_sessions "
            "where app_id is not null group by 1 order by c desc limit 1"
        ).fetchone()
        if db_top_app:
            if not show("topApps[0].app_id", a0.get("app_id"), db_top_app[0]):
                fails += 1
            if not show("topApps[0].cost",   a0.get("total_cost"), db_top_app[1]):
                fails += 1

    top_agents = api.get("topAgents", [])
    if top_agents:
        a0 = top_agents[0]
        db_top_agent = con.sql(
            "select ds.agent, al.app_id, al.project_id, sum(ds.total_cost) as c "
            "from dim_sessions ds "
            "left join int_app_cwd_lookup al on al.cwd = ds.cwd and al.tenant_id = ds.tenant_id "
            "group by ds.agent, al.app_id, al.project_id "
            "order by c desc nulls last limit 1"
        ).fetchone()
        if db_top_agent:
            if not show("topAgents[0].agent", a0.get("agent"), db_top_agent[0]):
                fails += 1
            if not show("topAgents[0].cost",  a0.get("total_cost"), db_top_agent[3]):
                fails += 1

    daily = api.get("dailySpend", [])
    if daily:
        api_total = sum(float(d.get("cost") or 0) for d in daily)
        db_total = one(con, "select coalesce(sum(cost),0) from ("
                            "  select sum(daily_cost) as cost from fact_daily_spend "
                            "  group by date order by date desc limit 14"
                            ")")
        if not show("dailySpend.sum(cost) (14d)", api_total, db_total):
            fails += 1

    print()
    if fails == 0:
        print("OVERALL: ALL MATCH")
        sys.exit(0)
    else:
        print(f"OVERALL: {fails} MISMATCH(ES)")
        sys.exit(1)


if __name__ == "__main__":
    main()
