import playwright from 'playwright';

(async () => {
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();

  const pageErrors = [];
  const consoleErrors = [];

  page.on('pageerror', err => {
    pageErrors.push(err.message);
  });

  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  try {
    const response = await page.goto('http://localhost:3000/', {
      waitUntil: 'networkidle',
      timeout: 20000
    });

    const status = response.status();

    // Screenshot
    await page.screenshot({ path: 'verify_page_dashboard.png', fullPage: true });

    // Count error text
    const errorTextCount = await page.evaluate(() => {
      const text = document.body.innerText;
      const matches = text.match(/error|failed|undefined|NaN|no data/gi);
      return matches ? matches.length : 0;
    });

    // Count SVGs
    const svgCount = await page.evaluate(() => {
      return document.querySelectorAll('svg').length;
    });

    // Count tables
    const tableCount = await page.evaluate(() => {
      return document.querySelectorAll('table').length;
    });

    // Count cards/metrics/stats
    const cardCount = await page.evaluate(() => {
      return document.querySelectorAll('[class*="card"], [class*="metric"], [class*="stat"]').length;
    });

    console.log(`STATUS=${status}`);
    console.log(`PAGEERRORS=${pageErrors.length}`);
    console.log(`CONSOLEERRORS=${consoleErrors.length}`);
    console.log(`ERRTEXT=${errorTextCount}`);
    console.log(`CARDS=${cardCount}`);
    console.log(`SVGS=${svgCount}`);
    console.log(`TABLES=${tableCount}`);

    if (consoleErrors.length > 0) {
      console.log('Console errors:', consoleErrors.join('; '));
    }
    if (pageErrors.length > 0) {
      console.log('Page errors:', pageErrors.join('; '));
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
  } finally {
    await browser.close();
  }
})();
