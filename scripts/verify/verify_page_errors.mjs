import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const pageErrors = [];
  const consoleErrors = [];

  page.on('pageerror', err => {
    pageErrors.push(err.toString());
  });

  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  try {
    await page.goto('http://localhost:3000/errors', { waitUntil: 'networkidle', timeout: 20000 });

    // Wait for content to render
    await page.waitForTimeout(3000);

    // Capture viewport screenshot with extended timeout
    await page.screenshot({ path: 'verify_page_errors.png', fullPage: false });

    // Count visible error/undefined/NaN/no data text (skip plain "error" topic)
    const bodyText = await page.evaluate(() => document.body.innerText);
    const errText = (bodyText.match(/\b(failed|undefined|NaN|no data)\b/gi) || []).length;

    // Count table rows and cards
    const rows = await page.locator('table tbody tr').count();
    const cards = await page.locator('[class*="card"], [class*="Card"]').count();

    // Get page title and first 500 chars of content for debugging
    const title = await page.title();
    const htmlSnapshot = await page.evaluate(() => document.body.innerHTML.substring(0, 500));

    console.log('STATUS: Page loaded');
    console.log(`TITLE: ${title}`);
    console.log(`PAGEERRORS: ${pageErrors.length}`);
    console.log(`CONSOLEERRORS: ${consoleErrors.length}`);
    console.log(`ERRTEXT: ${errText}`);
    console.log(`ROWS: ${rows}`);
    console.log(`CARDS: ${cards}`);

    if (pageErrors.length > 0) {
      console.log('PAGE ERRORS:', pageErrors);
    }
    if (consoleErrors.length > 0) {
      console.log('CONSOLE ERRORS:', consoleErrors);
    }
  } catch (err) {
    console.error('SCRIPT ERROR:', err.message);
  } finally {
    await browser.close();
  }
})();
