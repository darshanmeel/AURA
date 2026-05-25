import duckdb from 'duckdb';
import fetch from 'node-fetch';

const Database = duckdb.Database;
const DB_PATH = process.env.AURA_READ_DB_PATH || 'D:/darshanmeel/AURA/data/aura_read.duckdb';
const API_URL = 'http://localhost:3000/api/dashboard?range=all';

let db;
let conn;

async function initDB() {
  try {
    db = new Database(DB_PATH, { access_mode: 'READ_ONLY' });
    conn = db.connect();
    return true;
  } catch (err) {
    console.error(`Failed to open database at ${DB_PATH}:`, err.message);
    return false;
  }
}

function runQuery(sql) {
  return new Promise((resolve, reject) => {
    try {
      conn.all(sql, (err, result) => {
        if (err) reject(err);
        else resolve(result || []);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function fetchAPI() {
  try {
    const res = await fetch(API_URL);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`Failed to fetch API: ${err.message}`);
    return null;
  }
}

function compareValues(label, apiValue, dbValue, tolerance = 0.01) {
  if (apiValue === null && dbValue === null) {
    console.log(`${label.padEnd(40)} api=null        db=null        MATCH`);
    return true;
  }

  if (typeof apiValue === 'number' && typeof dbValue === 'number') {
    const delta = Math.abs(apiValue - dbValue);
    const relDelta = dbValue !== 0 ? Math.abs((apiValue - dbValue) / dbValue) : 0;
    if (delta < 0.01 || relDelta < tolerance) {
      console.log(`${label.padEnd(40)} api=${apiValue}        db=${dbValue}        MATCH`);
      return true;
    } else {
      console.log(`${label.padEnd(40)} api=${apiValue}        db=${dbValue}        MISMATCH (delta=${delta.toFixed(6)})`);
      return false;
    }
  }

  if (apiValue === dbValue) {
    console.log(`${label.padEnd(40)} api=${apiValue}  db=${dbValue}  MATCH`);
    return true;
  }

  console.log(`${label.padEnd(40)} api=${apiValue}        db=${dbValue}        MISMATCH`);
  return false;
}

async function main() {
  console.log(`Database path: ${DB_PATH}`);
  console.log(`API endpoint: ${API_URL}\n`);

  const dbReady = await initDB();
  if (!dbReady) {
    console.log('\nWARNING: Database not available.\n');
  }

  const api = await fetchAPI();
  if (!api) {
    console.error('\nFATAL: Could not fetch API response');
    process.exit(1);
  }

  console.log('Verifying dashboard numbers...\n');

  let matches = 0;
  let mismatches = 0;

  const hasData = api.kpis !== null && api.topApps && api.topApps.length > 0;
  if (!hasData) {
    console.log('API returned null/empty. Database file may not be initialized.\n');
    process.exit(0);
  }

  if (api.kpis && dbReady) {
    const kpi = api.kpis;
    console.log('=== KPIs ===');

    let result = await runQuery(`SELECT COUNT(DISTINCT session_id) AS cnt FROM dim_sessions`);
    if (compareValues('total_sessions', kpi.total_sessions, result[0]?.cnt)) matches++; else mismatches++;

    result = await runQuery(`SELECT SUM(total_cost) AS cost FROM dim_sessions`);
    if (compareValues('total_cost', kpi.total_cost, result[0]?.cost)) matches++; else mismatches++;

    result = await runQuery(`SELECT SUM(turn_count) AS turns FROM dim_sessions`);
    if (compareValues('total_turns', kpi.total_turns, result[0]?.turns)) matches++; else mismatches++;

    result = await runQuery(`SELECT SUM(tools_used) AS tools FROM dim_sessions`);
    if (compareValues('total_tool_calls', kpi.total_tool_calls, result[0]?.tools)) matches++; else mismatches++;

    result = await runQuery(`SELECT SUM(commits) AS commits FROM dim_sessions`);
    if (compareValues('total_commits', kpi.total_commits, result[0]?.commits)) matches++; else mismatches++;

    result = await runQuery(`SELECT COUNT(DISTINCT cwd) AS apps FROM dim_sessions`);
    if (compareValues('total_apps', kpi.total_apps, result[0]?.apps)) matches++; else mismatches++;

    result = await runQuery(`SELECT COUNT(DISTINCT person_id) AS people FROM dim_sessions`);
    if (compareValues('total_people', kpi.total_people, result[0]?.people)) matches++; else mismatches++;

    result = await runQuery(`SELECT COUNT(DISTINCT CASE WHEN status = 'active' THEN session_id END) AS active FROM dim_sessions`);
    if (compareValues('active_sessions', kpi.active_sessions, result[0]?.active)) matches++; else mismatches++;

    result = await runQuery(`SELECT SUM(cache_read_total) / NULLIF(SUM(cache_read_total + ephemeral_5m_total + ephemeral_1h_total), 0) AS rate FROM dim_sessions`);
    if (compareValues('cache_hit_rate', kpi.cache_hit_rate, result[0]?.rate, 0.001)) matches++; else mismatches++;

    console.log();
  }

  if (api.topApps && api.topApps.length > 0 && dbReady) {
    console.log('=== Top Apps ===');
    if (api.topApps[0]) {
      const app = api.topApps[0];
      const result = await runQuery(`SELECT SUM(ds.total_cost) AS cost FROM dim_sessions ds LEFT JOIN int_app_cwd_lookup al ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id LEFT JOIN dim_apps da ON da.app_id = al.app_id WHERE COALESCE(da.app_id, ds.cwd) = '${app.app_id}'`);
      if (compareValues(`topApps[0].cost`, app.total_cost, result[0]?.cost)) matches++; else mismatches++;
    }
    console.log();
  }

  if (api.topAgents && api.topAgents.length > 0 && dbReady) {
    console.log('=== Top Agents ===');
    if (api.topAgents[0]) {
      const agent = api.topAgents[0];
      const result = await runQuery(`SELECT SUM(ds.total_cost) AS cost FROM dim_sessions ds WHERE ds.agent = '${agent.agent}'`);
      if (compareValues(`topAgents[0].cost`, agent.total_cost, result[0]?.cost)) matches++; else mismatches++;
    }
    console.log();
  }

  if (api.toolMix && api.toolMix.length > 0 && dbReady) {
    console.log('=== Tool Mix ===');
    if (api.toolMix[0]) {
      const tool = api.toolMix[0];
      const result = await runQuery(`SELECT COUNT(*) AS cnt FROM fact_tool_executions WHERE tool_name = '${tool.tool_name}'`);
      if (compareValues(`toolMix[0].count`, tool.call_count, result[0]?.cnt)) matches++; else mismatches++;
    }
    console.log();
  }

  if (api.providers && api.providers.length > 0 && dbReady) {
    console.log('=== Providers ===');
    if (api.providers[0]) {
      const prov = api.providers[0];
      const result = await runQuery(`SELECT SUM(total_cost) AS cost FROM dim_sessions WHERE provider = '${prov.provider}'`);
      if (compareValues(`providers[0].cost`, prov.cost, result[0]?.cost)) matches++; else mismatches++;
    }
    console.log();
  }

  if (api.models && api.models.length > 0 && dbReady) {
    console.log('=== Models ===');
    if (api.models[0]) {
      const mod = api.models[0];
      const result = await runQuery(`SELECT SUM(total_cost) AS cost FROM dim_sessions WHERE model = '${mod.model}'`);
      if (compareValues(`models[0].cost`, mod.cost, result[0]?.cost)) matches++; else mismatches++;
    }
    console.log();
  }

  if (api.topFiles && api.topFiles.length > 0 && dbReady) {
    console.log('=== Top Files ===');
    if (api.topFiles[0]) {
      const file = api.topFiles[0];
      const result = await runQuery(`SELECT SUM(edit_count) AS edits FROM fact_session_files WHERE file_path = '${file.file_path.replace(/'/g, "''")}'`);
      if (compareValues(`topFiles[0].edits`, file.edits, result[0]?.edits)) matches++; else mismatches++;
    }
    console.log();
  }

  if (api.topPeople && api.topPeople.length > 0 && dbReady) {
    console.log('=== Top People ===');
    if (api.topPeople[0]) {
      const person = api.topPeople[0];
      const result = await runQuery(`SELECT SUM(total_cost) AS cost FROM dim_sessions WHERE person_id = '${person.person_id}'`);
      if (compareValues(`topPeople[0].cost`, person.total_cost, result[0]?.cost)) matches++; else mismatches++;
    }
    console.log();
  }

  const total = matches + mismatches;
  if (total === 0) {
    console.log('OVERALL: INCONCLUSIVE (No data or database unavailable)\n');
    process.exit(0);
  }

  console.log(`\nOVERALL: ${mismatches === 0 ? 'ALL MATCH' : `${mismatches} MISMATCH(ES) of ${total} checks`}`);

  if (dbReady && conn) {
    try { conn.close(); } catch (e) {}
  }

  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
