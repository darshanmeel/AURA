import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const pageErrors = [];
  const consoleErrors = [];

  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  try {
    // Sessions page
    await page.goto('http://localhost:3000/sessions', {
      waitUntil: 'networkidle',
      timeout: 20000,
    });

    await page.screenshot({ path: 'verify_page_sessions.png', fullPage: true });

    const pageContent = await page.content();
    const errorMatches = pageContent.match(/error|failed|undefined|NaN|no data/gi) || [];
    const errorCount = errorMatches.length;

    const rowCount = await page.locator('table tbody tr').count();

    console.log('PAGE: sessions');
    console.log('STATUS:', pageErrors.length === 0 && consoleErrors.length === 0 ? 'PASS' : 'FAIL');
    console.log('PAGEERRORS:', pageErrors.length, pageErrors.join('; '));
    console.log('CONSOLEERRORS:', consoleErrors.length, consoleErrors.join('; '));
    console.log('ERRTEXT:', errorCount);
    console.log('ROWS:', rowCount);

    // Click first session if available
    let detailPageErrors = [];
    let detailConsoleErrors = [];
    let detailUrl = 'N/A';
    let detailErrorCount = 0;

    if (rowCount > 0) {
      const detailPage = await browser.newPage();
      detailPage.on('pageerror', (err) => detailPageErrors.push(err.message));
      detailPage.on('console', (msg) => {
        if (msg.type() === 'error') detailConsoleErrors.push(msg.text());
      });

      try {
        // Try clicking link in first row
        const firstLink = page.locator('table tbody tr a').first();
        const linkHref = await firstLink.getAttribute('href');

        if (linkHref) {
          await detailPage.goto(`http://localhost:3000${linkHref}`, {
            waitUntil: 'networkidle',
            timeout: 20000,
          });

          detailUrl = detailPage.url();
          await detailPage.screenshot({ path: 'verify_page_session_detail.png', fullPage: true });

          const detailContent = await detailPage.content();
          const detailMatches = detailContent.match(/error|failed|undefined|NaN|no data/gi) || [];
          detailErrorCount = detailMatches.length;
        }
      } catch (e) {
        detailPageErrors.push(`Click/nav failed: ${e.message}`);
      }

      await detailPage.close();
    }

    console.log('DETAIL_URL:', detailUrl);
    console.log('DETAIL_PAGEERRORS:', detailPageErrors.length, detailPageErrors.join('; '));
    console.log('DETAIL_CONSOLEERRORS:', detailConsoleErrors.length, detailConsoleErrors.join('; '));
    console.log('DETAIL_ERRTEXT:', detailErrorCount);
  } catch (e) {
    console.error('Script error:', e.message);
  } finally {
    await browser.close();
  }
})();
