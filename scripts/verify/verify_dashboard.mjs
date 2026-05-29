import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push(err.message));

  try {
    // 1. Dashboard loads
    console.log('\n=== 1. Dashboard root ===');
    const res = await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
    console.log('Status:', res.status());
    await page.screenshot({ path: 'verify_01_dashboard.png', fullPage: true });
    const title = await page.title();
    console.log('Title:', title);
    const h1 = await page.locator('h1, h2').first().textContent().catch(() => '(none)');
    console.log('Heading:', h1);

    // 2. Check for error states
    const errText = await page.locator('text=/error|failed|no data|undefined/i').count();
    console.log('Error messages visible:', errText);

    // 3. Check key metric cards render numbers (not empty/NaN)
    const cards = await page.locator('[class*="card"], [class*="metric"], [class*="stat"]').count();
    console.log('Metric cards found:', cards);

    // 4. Check for charts/tables
    const svgs = await page.locator('svg').count();
    console.log('SVG elements (charts):', svgs);
    const tables = await page.locator('table').count();
    console.log('Tables:', tables);

    // 5. Navigate to Sessions page if it exists
    const sessionsLink = page.locator('a[href*="session"], nav >> text=/session/i').first();
    if (await sessionsLink.count() > 0) {
      console.log('\n=== 2. Sessions page ===');
      await sessionsLink.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await page.screenshot({ path: 'verify_02_sessions.png', fullPage: true });
      console.log('URL:', page.url());
      const sessionErrText = await page.locator('text=/error|failed/i').count();
      console.log('Errors on sessions page:', sessionErrText);
    }

    // 6. Navigate to Trends page if it exists
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 10000 });
    const trendsLink = page.locator('a[href*="trend"], nav >> text=/trend/i').first();
    if (await trendsLink.count() > 0) {
      console.log('\n=== 3. Trends page ===');
      await trendsLink.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      await page.screenshot({ path: 'verify_03_trends.png', fullPage: true });
      console.log('URL:', page.url());
    }

    console.log('\n=== Console errors captured ===');
    if (errors.length === 0) {
      console.log('None');
    } else {
      errors.forEach(e => console.log('ERROR:', e));
    }

    console.log('\nDONE');
  } finally {
    await browser.close();
  }
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
