import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const pageerrors = [];
  const consoleerrors = [];

  page.on('pageerror', (err) => pageerrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleerrors.push(msg.text());
    }
  });

  try {
    // Navigate to agents page
    console.log('Navigating to agents page...');
    await page.goto('http://localhost:3000/agents', { waitUntil: 'networkidle', timeout: 20000 });

    // Wait a bit for rendering
    await page.waitForTimeout(1000);

    // Take screenshot of agents list
    await page.screenshot({ path: 'verify_page_agents.png', fullPage: true });

    // Count error text
    const allText = await page.textContent('body');
    const errorMatches = (allText.match(/error|failed|undefined|NaN|no data/gi) || []).length;

    // Count table rows
    const rows = await page.locator('table tbody tr').count();

    console.log(`\n=== AGENTS PAGE ===`);
    console.log(`STATUS: Page loaded`);
    console.log(`PAGEERRORS: ${pageerrors.length}`);
    if (pageerrors.length > 0) console.log(`  ${pageerrors.join('\n  ')}`);
    console.log(`CONSOLEERRORS: ${consoleerrors.length}`);
    if (consoleerrors.length > 0) console.log(`  ${consoleerrors.join('\n  ')}`);
    console.log(`ERRTEXT_COUNT: ${errorMatches}`);
    console.log(`TABLE_ROWS: ${rows}`);

    // Click first row if exists
    if (rows > 0) {
      console.log(`\nClicking first agent row...`);
      const firstRowLink = page.locator('table tbody tr a').first();
      const href = await firstRowLink.getAttribute('href');
      console.log(`DETAIL_URL: ${href}`);

      await firstRowLink.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);

      // Take screenshot of detail page
      await page.screenshot({ path: 'verify_page_agent_detail.png', fullPage: true });

      // Clear errors for detail page
      const detailPageErrors = [];
      const detailConsoleErrors = [];

      page.on('pageerror', (err) => detailPageErrors.push(err.message));
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          detailConsoleErrors.push(msg.text());
        }
      });

      const detailText = await page.textContent('body');
      const detailErrorMatches = (detailText.match(/error|failed|undefined|NaN|no data/gi) || []).length;

      console.log(`\n=== AGENT DETAIL PAGE ===`);
      console.log(`DETAIL_PAGEERRORS: ${detailPageErrors.length}`);
      if (detailPageErrors.length > 0) console.log(`  ${detailPageErrors.join('\n  ')}`);
      console.log(`DETAIL_CONSOLEERRORS: ${detailConsoleErrors.length}`);
      if (detailConsoleErrors.length > 0) console.log(`  ${detailConsoleErrors.join('\n  ')}`);
      console.log(`DETAIL_ERRTEXT_COUNT: ${detailErrorMatches}`);
    }

  } catch (error) {
    console.error('Error during verification:', error.message);
  } finally {
    await browser.close();
  }
})();
