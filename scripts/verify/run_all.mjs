// run_all.mjs — headless number-map integrity runner.
//
// Checks number-map invariants against the READ DuckDB (opened READ-ONLY) and
// writes a JSON report to <AURA_ARTIFACTS_DIR>/number_verify.json. This file is
// the contract the /observability frontend reads — DO NOT rename its fields.
//
// Invoked by the watcher's dbt cycle (dbt_worker) right after `dbt test`. The
// frontend/API is NOT running during that cycle, so every check is DB-only
// (no HTTP fetch). Each check is wrapped in its own try/catch: a query error
// (e.g. a column missing on an old snapshot before the dbt drift fix lands)
// records pass:false with actual="error: <msg>" instead of crashing the run.
//
// Uses the same @duckdb/node-api client + version (1.5.3-r.1) as the frontend
// (frontend/lib/db.ts), proven against the 1.5.x read DB.

import { DuckDBInstance } from '@duckdb/node-api';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DB_PATH = process.env.AURA_READ_DB_PATH || '/data/read/aura.duckdb';
const ARTIFACTS_DIR = process.env.AURA_ARTIFACTS_DIR || '/data/artifacts';

// Reconciliation tolerance: pass if abs(Δ) < 0.01 OR relΔ < 0.005.
const ABS_TOL = 0.01;
const REL_TOL = 0.005;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// BigInt → Number so SUM()/COUNT() results (which node-api returns as BigInt
// for HUGEINT/BIGINT columns) participate in normal JS arithmetic. Values
// outside the safe-integer range fall back to Number(String) (the counts and
// dollar sums we deal with are well within range).
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function reconciles(a, b) {
  const x = num(a) ?? 0;
  const y = num(b) ?? 0;
  const delta = Math.abs(x - y);
  if (delta < ABS_TOL) return true;
  const denom = Math.max(Math.abs(x), Math.abs(y));
  if (denom === 0) return true;
  return delta / denom < REL_TOL;
}

function fmt(n) {
  const v = num(n) ?? 0;
  return v.toFixed(4);
}

// runOne returns the first row object (or null) for a single-row query.
async function runOne(conn, sql) {
  const result = await conn.runAndReadAll(sql);
  const rows = result.getRowObjectsJS();
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Check definitions. Each returns { actual, pass }. Any throw inside is caught
// by the runner and turned into { actual: "error: <msg>", pass: false }.
// ---------------------------------------------------------------------------

const CHECKS = [
  {
    check: 'session_cost_reconciles',
    page: 'sessions',
    expected_source: 'fact_model_calls.calculated_cost',
    run: async (conn) => {
      const a = num((await runOne(conn,
        'SELECT SUM(total_cost) AS v FROM dim_sessions'))?.v) ?? 0;
      const b = num((await runOne(conn,
        'SELECT SUM(calculated_cost) AS v FROM fact_model_calls'))?.v) ?? 0;
      return {
        actual: `sessions=$${fmt(a)} model_calls=$${fmt(b)} Δ=$${fmt(Math.abs(a - b))}`,
        pass: reconciles(a, b),
      };
    },
  },
  {
    check: 'daily_spend_reconciles',
    page: 'dashboard',
    expected_source: 'fact_daily_spend.daily_cost',
    run: async (conn) => {
      const a = num((await runOne(conn,
        'SELECT SUM(daily_cost) AS v FROM fact_daily_spend'))?.v) ?? 0;
      const b = num((await runOne(conn,
        'SELECT SUM(calculated_cost) AS v FROM fact_model_calls'))?.v) ?? 0;
      return {
        actual: `daily_spend=$${fmt(a)} model_calls=$${fmt(b)} Δ=$${fmt(Math.abs(a - b))}`,
        pass: reconciles(a, b),
      };
    },
  },
  {
    check: 'agent_entity_spend_reconciles',
    page: 'agents',
    expected_source: 'int_entity_spend.total_cost',
    run: async (conn) => {
      const a = num((await runOne(conn,
        "SELECT SUM(total_cost) AS v FROM int_entity_spend WHERE entity_type = 'agent'"))?.v) ?? 0;
      const b = num((await runOne(conn,
        'SELECT SUM(daily_cost) AS v FROM fact_daily_spend'))?.v) ?? 0;
      return {
        actual: `agent_entity=$${fmt(a)} daily_spend=$${fmt(b)} Δ=$${fmt(Math.abs(a - b))}`,
        pass: reconciles(a, b),
      };
    },
  },
  {
    check: 'priced_models_have_cost',
    page: 'models',
    expected_source: 'fact_model_calls.calculated_cost',
    run: async (conn) => {
      const c = num((await runOne(conn,
        'SELECT COUNT(*) AS v FROM fact_model_calls ' +
        'WHERE calculated_cost IS NULL ' +
        'AND model IN (SELECT model FROM model_pricing)'))?.v) ?? 0;
      return {
        actual: `${c} priced rows with NULL calculated_cost`,
        pass: c === 0,
      };
    },
  },
  {
    check: 'no_negative_cost',
    page: 'dashboard',
    expected_source: 'fact_model_calls.calculated_cost',
    run: async (conn) => {
      const c = num((await runOne(conn,
        'SELECT COUNT(*) AS v FROM fact_model_calls WHERE calculated_cost < 0'))?.v) ?? 0;
      return {
        actual: `${c} rows with calculated_cost < 0`,
        pass: c === 0,
      };
    },
  },
  {
    check: 'cache_hit_rate_bounded',
    page: 'session-detail',
    expected_source: 'fact_prompts.cache_hit_rate',
    run: async (conn) => {
      const c = num((await runOne(conn,
        'SELECT COUNT(*) AS v FROM fact_prompts ' +
        'WHERE cache_hit_rate < 0 OR cache_hit_rate > 1'))?.v) ?? 0;
      return {
        actual: `${c} prompts with cache_hit_rate out of [0,1]`,
        pass: c === 0,
      };
    },
  },
  {
    check: 'session_status_accepted',
    page: 'sessions',
    expected_source: 'dim_sessions.session_status',
    run: async (conn) => {
      const c = num((await runOne(conn,
        'SELECT COUNT(*) AS v FROM dim_sessions ' +
        "WHERE session_status NOT IN " +
        "('completed','budget_killed','interrupted','error','unknown')"))?.v) ?? 0;
      return {
        actual: `${c} sessions with unexpected session_status`,
        pass: c === 0,
      };
    },
  },
  {
    check: 'sdk_verbatim_cost',
    page: 'sessions',
    expected_source: 'fact_model_calls.reported_cost_usd',
    run: async (conn) => {
      const n = num((await runOne(conn,
        "SELECT COUNT(*) AS v FROM fact_model_calls WHERE source = 'sdk_trace'"))?.v) ?? 0;
      if (n === 0) {
        return { actual: 'no sdk_trace sessions', pass: true };
      }
      const a = num((await runOne(conn,
        "SELECT SUM(calculated_cost) AS v FROM fact_model_calls WHERE source = 'sdk_trace'"))?.v) ?? 0;
      const b = num((await runOne(conn,
        'SELECT SUM(reported_cost_usd) AS v FROM fact_model_calls ' +
        "WHERE source = 'sdk_trace' AND reported_cost_usd IS NOT NULL"))?.v) ?? 0;
      return {
        actual: `sdk_calculated=$${fmt(a)} sdk_reported=$${fmt(b)} Δ=$${fmt(Math.abs(a - b))}`,
        pass: reconciles(a, b),
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const checks = [];
  let instance;
  let conn;
  try {
    instance = await DuckDBInstance.create(DB_PATH, { access_mode: 'READ_ONLY' });
    conn = await instance.connect();
  } catch (err) {
    // The DB itself could not be opened. Record every check as an error so the
    // observability page shows the failure rather than an empty report, and
    // still write the file. This is the only place we fan a single failure out
    // across all checks (every check shares the same broken precondition).
    const msg = err && err.message ? err.message : String(err);
    for (const def of CHECKS) {
      checks.push({
        check: def.check,
        page: def.page,
        expected_source: def.expected_source,
        actual: `error: ${msg}`,
        pass: false,
      });
    }
    writeReport(checks);
    console.log(`number-verify: DB open failed (${msg}) — wrote ${checks.length} error checks`);
    process.exit(1);
  }

  for (const def of CHECKS) {
    let actual;
    let pass;
    try {
      const r = await def.run(conn);
      actual = r.actual;
      pass = r.pass;
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      actual = `error: ${msg}`;
      pass = false;
    }
    checks.push({
      check: def.check,
      page: def.page,
      expected_source: def.expected_source,
      actual,
      pass,
    });
  }

  try { conn?.closeSync?.(); } catch { /* best-effort */ }
  try { instance?.closeSync?.(); } catch { /* best-effort */ }

  const failCount = writeReport(checks);
  process.exit(failCount > 0 ? 1 : 0);
}

function writeReport(checks) {
  const passCount = checks.filter((c) => c.pass).length;
  const failCount = checks.length - passCount;
  const report = {
    generated_at: new Date().toISOString(),
    total: checks.length,
    pass: passCount,
    fail: failCount,
    checks,
  };

  try {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  } catch { /* dir may already exist */ }
  const outPath = join(ARTIFACTS_DIR, 'number_verify.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log(
    `number-verify: ${passCount}/${checks.length} passed, ${failCount} failed -> ${outPath}`,
  );
  return failCount;
}

main().catch((err) => {
  // Last-resort guard: an unexpected error in main() itself (not a per-check
  // error) must still leave a report and a non-zero exit.
  const msg = err && err.message ? err.message : String(err);
  console.error(`number-verify: fatal: ${msg}`);
  try {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    writeFileSync(
      join(ARTIFACTS_DIR, 'number_verify.json'),
      JSON.stringify({
        generated_at: new Date().toISOString(),
        total: 0,
        pass: 0,
        fail: 0,
        checks: [],
        error: msg,
      }, null, 2),
    );
  } catch { /* nothing more we can do */ }
  process.exit(1);
});
