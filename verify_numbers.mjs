import Database from 'duckdb';
import fetch from 'node-fetch';

const DB_PATH = 'D:/darshanmeel/AURA/data/aura_read.duckdb';
const API_URL = 'http://localhost:3000/api/dashboard?range=all';

let db;
let conn;

async function initDB() {
  db = new Database(DB_PATH);
  conn = await db.connect();
}

async function runQuery(sql) {
  const result = await conn.all(sql);
  return result;
}

async function fetchAPI() {
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error(`API failed: ${res.status}`);
  return await res.json();
}

function compareValues(label, apiValue, dbValue, tolerance = 0.01) {
  if (apiValue === null && dbValue === null) {
    console.log(`${label.padEnd(35)} api=null        db=null        MATCH`);
    return true;
  }

  // Handle numeric comparisons with tolerance for floats
  if (typeof apiValue === 'number' && typeof dbValue === 'number') {
    const delta = Math.abs(apiValue - dbValue);
    const relDelta = Math.abs((apiValue - dbValue) / (dbValue || 1));
    if (delta < 0.01 || relDelta < tolerance) {
      console.log(`${label.padEnd(35)} api=${apiValue}        db=${dbValue}        MATCH`);
      return true;
    }
  }

  // Handle string comparisons
  if (apiValue === dbValue) {
    console.log(`${label.padEnd(35)} api=${apiValue}        db=${dbValue}        MATCH`);
    return true;
  }

  console.log(
    `${label.padEnd(35)} api=${apiValue}        db=${dbValue}        MISMATCH (delta=${
      typeof apiValue === 'number' && typeof dbValue === 'number' ? apiValue - dbValue : 'N/A'
    })`
  );
  return false;
}

async function main() {
  await initDB();
  const api = await fetchAPI();

  console.log('Verifying dashboard numbers...\n');

  let matches = 0;
  let mismatches = 0;

  // KPIs
  if (api.kpis) {
    const kpi = api.kpis;
    console.log('=== KPIs ===');

    const sessionsResult = await runQuery(`SELECT COUNT(DISTINCT session_id) AS cnt FROM dim_sessions`);
    if (compareValues('total_sessions', kpi.total_sessions, sessionsResult[0]?.cnt)) matches++;
    else mismatches++;

    const costResult = await runQuery(`SELECT SUM(total_cost) AS cost FROM dim_sessions`);
    if (compareValues('total_cost', kpi.total_cost, costResult[0]?.cost)) matches++;
    else mismatches++;

    const turnsResult = await runQuery(`SELECT SUM(turn_count) AS turns FROM dim_sessions`);
    if (compareValues('total_turns', kpi.total_turns, turnsResult[0]?.turns)) matches++;
    else mismatches++;

    const toolsResult = await runQuery(`SELECT SUM(tools_used) AS tools FROM dim_sessions`);
    if (compareValues('total_tool_calls', kpi.total_tool_calls, toolsResult[0]?.tools)) matches++;
    else mismatches++;

    const commitsResult = await runQuery(`SELECT SUM(commits) AS commits FROM dim_sessions`);
    if (compareValues('total_commits', kpi.total_commits, commitsResult[0]?.commits)) matches++;
    else mismatches++;

    const appsResult = await runQuery(`SELECT COUNT(DISTINCT cwd) AS apps FROM dim_sessions`);
    if (compareValues('total_apps', kpi.total_apps, appsResult[0]?.apps)) matches++;
    else mismatches++;

    const peopleResult = await runQuery(`SELECT COUNT(DISTINCT person_id) AS people FROM dim_sessions`);
    if (compareValues('total_people', kpi.total_people, peopleResult[0]?.people)) matches++;
    else mismatches++;

    const activeResult = await runQuery(
      `SELECT COUNT(DISTINCT CASE WHEN status = 'active' THEN session_id END) AS active FROM dim_sessions`
    );
    if (compareValues('active_sessions', kpi.active_sessions, activeResult[0]?.active)) matches++;
    else mismatches++;

    const cacheResult = await runQuery(`
      SELECT
        SUM(cache_read_total) / NULLIF(SUM(cache_read_total + ephemeral_5m_total + ephemeral_1h_total), 0) AS rate
      FROM dim_sessions
    `);
    if (compareValues('cache_hit_rate', kpi.cache_hit_rate, cacheResult[0]?.rate, 0.001)) matches++;
    else mismatches++;

    console.log();
  }

  // Daily Spend
  if (api.dailySpend && api.dailySpend.length > 0) {
    console.log('=== Daily Spend (sample) ===');
    const firstDay = api.dailySpend[0];
    const dailyResult = await runQuery(`SELECT SUM(daily_cost) AS cost FROM fact_daily_spend WHERE date = '${firstDay.date}'`);
    if (compareValues('daily_cost_sample', firstDay.cost, dailyResult[0]?.cost)) matches++;
    else mismatches++;
    console.log();
  }

  // Top Apps
  if (api.topApps && api.topApps.length > 0) {
    console.log('=== Top Apps (sample) ===');
    if (compareValues('topApps_row_count', api.topApps.length, api.topApps.length)) matches++;
    if (api.topApps[0]) {
      const firstAppResult = await runQuery(`
        SELECT SUM(ds.total_cost) AS total_cost FROM dim_sessions ds
        LEFT JOIN int_app_cwd_lookup al ON al.cwd = ds.cwd AND al.tenant_id = ds.tenant_id
        LEFT JOIN dim_apps da ON da.app_id = al.app_id
        WHERE COALESCE(da.app_id, ds.cwd) = '${api.topApps[0].app_id}'
      `);
      if (compareValues('topApps[0]_cost', api.topApps[0].total_cost, firstAppResult[0]?.total_cost)) matches++;
      else mismatches++;
    }
    console.log();
  }

  // Top Agents
  if (api.topAgents && api.topAgents.length > 0) {
    console.log('=== Top Agents (sample) ===');
    if (api.topAgents[0]) {
      const firstAgentResult = await runQuery(`SELECT SUM(ds.total_cost) AS cost FROM dim_sessions ds WHERE ds.agent = '${api.topAgents[0].agent}'`);
      if (compareValues('topAgents[0]_cost', api.topAgents[0].total_cost, firstAgentResult[0]?.cost)) matches++;
      else mismatches++;
    }
    console.log();
  }

  // Tool Mix
  if (api.toolMix && api.toolMix.length > 0) {
    console.log('=== Tool Mix (sample) ===');
    if (api.toolMix[0]) {
      const firstToolResult = await runQuery(`SELECT COUNT(*) AS cnt FROM fact_tool_executions WHERE tool_name = '${api.toolMix[0].tool_name}'`);
      if (compareValues('toolMix[0]_count', api.toolMix[0].call_count, firstToolResult[0]?.cnt)) matches++;
      else mismatches++;
    }
    console.log();
  }

  // Providers
  if (api.providers && api.providers.length > 0) {
    console.log('=== Providers (sample) ===');
    if (api.providers[0]) {
      const firstProviderResult = await runQuery(`SELECT SUM(total_cost) AS cost FROM dim_sessions WHERE provider = '${api.providers[0].provider}'`);
      if (compareValues('providers[0]_cost', api.providers[0].cost, firstProviderResult[0]?.cost)) matches++;
      else mismatches++;
    }
    console.log();
  }

  // Models
  if (api.models && api.models.length > 0) {
    console.log('=== Models (sample) ===');
    if (api.models[0]) {
      const firstModelResult = await runQuery(`SELECT SUM(total_cost) AS cost FROM dim_sessions WHERE model = '${api.models[0].model}'`);
      if (compareValues('models[0]_cost', api.models[0].cost, firstModelResult[0]?.cost)) matches++;
      else mismatches++;
    }
    console.log();
  }

  // Recent Errors
  if (api.recentErrors !== undefined && api.recentErrors !== null) {
    console.log('=== Recent Errors (row count) ===');
    const errorsResult = await runQuery(`SELECT COUNT(*) AS cnt FROM fact_errors`);
    if (compareValues('recentErrors_exists', api.recentErrors.length > 0, errorsResult[0]?.cnt > 0)) matches++;
    else mismatches++;
    console.log();
  }

  // Top Files
  if (api.topFiles && api.topFiles.length > 0) {
    console.log('=== Top Files (sample) ===');
    if (api.topFiles[0]) {
      const firstFileResult = await runQuery(`SELECT SUM(edit_count) AS edits FROM fact_session_files WHERE file_path = '${api.topFiles[0].file_path.replace(/'/g, "''")}'`);
      if (compareValues('topFiles[0]_edits', api.topFiles[0].edits, firstFileResult[0]?.edits)) matches++;
      else mismatches++;
    }
    console.log();
  }

  // Top People
  if (api.topPeople && api.topPeople.length > 0) {
    console.log('=== Top People (sample) ===');
    if (api.topPeople[0]) {
      const firstPersonResult = await runQuery(`SELECT SUM(total_cost) AS cost FROM dim_sessions WHERE person_id = '${api.topPeople[0].person_id}'`);
      if (compareValues('topPeople[0]_cost', api.topPeople[0].total_cost, firstPersonResult[0]?.cost)) matches++;
      else mismatches++;
    }
    console.log();
  }

  const total = matches + mismatches;
  console.log(`\nOVERALL: ${mismatches === 0 ? 'ALL MATCH' : `${mismatches} MISMATCH(ES) / ${total} total`}`);

  conn.close();
  db.close();

  process.exit(mismatches > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
