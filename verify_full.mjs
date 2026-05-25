import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';

async function testPage(page, path, name, errors) {
  console.log(`\n=== ${name} ===`);
  const res = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 15000 });
  const status = res.status();
  console.log(`Status: ${status}`);
  const screenshotName = `verify_full_${name.toLowerCase().replace(/\s+/g, '_')}.png`;
  await page.screenshot({ path: screenshotName, fullPage: true });
  const errorText = await page.locator('text=/error|failed|undefined|NaN/i').count();
  console.log(`Visible error text: ${errorText}`);
  const cards = await page.locator('[class*="card"], [class*="metric"], [class*="stat"]').count();
  console.log(`Cards: ${cards}`);
  const svgs = await page.locator('svg').count();
  console.log(`SVG elements: ${svgs}`);
  const tables = await page.locator('table').count();
  console.log(`Tables: ${tables}`);
  return { status, errorText, cards, svgs, tables, screenshotName };
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const allErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') allErrors.push(msg.text()); });
  page.on('pageerror', err => allErrors.push(err.message));

  try {
    const results = {};

    results.dashboard = await testPage(page, '/', 'dashboard', allErrors);
    results.sessions = await testPage(page, '/sessions', 'sessions', allErrors);
    results.agents = await testPage(page, '/agents', 'agents', allErrors);
    results.apps = await testPage(page, '/apps', 'apps', allErrors);
    results.people = await testPage(page, '/people', 'people', allErrors);
    results.errors = await testPage(page, '/errors', 'errors', allErrors);

    console.log('\n=== session_detail ===');
    await page.goto(`${BASE}/sessions`, { waitUntil: 'networkidle', timeout: 15000 });
    const firstSessionRow = page.locator('table tbody tr').first();
    if (await firstSessionRow.count() > 0) {
      await firstSessionRow.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await page.screenshot({ path: 'verify_full_session_detail.png', fullPage: true });
      const errorText = await page.locator('text=/error|failed|undefined|NaN/i').count();
      console.log(`Error text: ${errorText}`);
      const promptSections = await page.locator('[class*="prompt"]').count();
      console.log(`Prompt sections: ${promptSections}`);
      results.session_detail = { errorText, promptSections };
    }

    console.log('\n=== agents_detail ===');
    await page.goto(`${BASE}/agents`, { waitUntil: 'networkidle', timeout: 15000 });
    const firstAgentRow = page.locator('table tbody tr').first();
    if (await firstAgentRow.count() > 0) {
      await firstAgentRow.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await page.screenshot({ path: 'verify_full_agents_detail.png', fullPage: true });
      const errorText = await page.locator('text=/error|failed/i').count();
      console.log(`Error text: ${errorText}`);
      results.agents_detail = { errorText };
    }

    console.log('\n=== apps_detail ===');
    await page.goto(`${BASE}/apps`, { waitUntil: 'networkidle', timeout: 15000 });
    const firstAppRow = page.locator('table tbody tr').first();
    if (await firstAppRow.count() > 0) {
      await firstAppRow.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await page.screenshot({ path: 'verify_full_apps_detail.png', fullPage: true });
      const errorText = await page.locator('text=/error|failed/i').count();
      console.log(`Error text: ${errorText}`);
      results.apps_detail = { errorText };
    }

    console.log('\n=== people_detail ===');
    await page.goto(`${BASE}/people`, { waitUntil: 'networkidle', timeout: 15000 });
    const firstPersonRow = page.locator('table tbody tr').first();
    if (await firstPersonRow.count() > 0) {
      await firstPersonRow.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await page.screenshot({ path: 'verify_full_people_detail.png', fullPage: true });
      const errorText = await page.locator('text=/error|failed/i').count();
      console.log(`Error text: ${errorText}`);
      results.people_detail = { errorText };
    }

    console.log('\n\n=== SUMMARY ===');
    const pageList = ['dashboard', 'sessions', 'agents', 'apps', 'people', 'errors', 'session_detail', 'agents_detail', 'apps_detail', 'people_detail'];
    let allPass = true;

    pageList.forEach(pageKey => {
      const result = results[pageKey];
      if (!result) return;
      const hasFail = result.status !== 200 || result.errorText > 0;
      const status = hasFail ? 'FAIL' : 'PASS';
      if (hasFail) allPass = false;
      const details = [];
      if (result.status && result.status !== 200) details.push(`HTTP ${result.status}`);
      if (result.errorText > 0) details.push(`${result.errorText} errors`);
      console.log(`${pageKey}: ${status}${details.length ? ' (' + details.join(', ') + ')' : ''}`);
    });

    console.log(`\nOVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
    console.log(`\nConsole/page errors total: ${allErrors.length}`);
    if (allErrors.length > 0) allErrors.slice(0, 5).forEach(e => console.log(`  - ${e}`));

  } finally {
    await browser.close();
  }
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
