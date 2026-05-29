import { chromium } from 'playwright';

(async () => {
  let browser, page;

  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();

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

    console.log('=== PEOPLE PAGE ===');
    await page.goto('http://localhost:3000/people', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(500);

    await page.screenshot({ path: 'verify_page_people.png', fullPage: true });
    console.log('✓ Screenshot: verify_page_people.png');

    const pageHtml = await page.content();
    const pageErrorInstances = (pageHtml.match(/<div[^>]*error|<span[^>]*error|undefined|NaN/gi) || []).length;
    const personCardCount = await page.locator('a[href*="/people/"]').count();

    console.log(`✓ Person cards visible: ${personCardCount}`);
    console.log(`✓ Page errors (JS): ${pageErrors.length}`);
    console.log(`✓ Console errors: ${consoleErrors.length}`);
    console.log(`✓ HTML error elements: ${pageErrorInstances}`);

    // Click first person
    if (personCardCount > 0) {
      console.log('\n=== PERSON DETAIL PAGE ===');
      const firstCard = page.locator('a[href*="/people/"]').first();
      const href = await firstCard.getAttribute('href');
      console.log(`Navigating to: ${href}`);
      await firstCard.click();
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(500);

      await page.screenshot({ path: 'verify_page_person_detail.png', fullPage: true });
      console.log('✓ Screenshot: verify_page_person_detail.png');

      const detailHtml = await page.content();
      const detailErrorInstances = (detailHtml.match(/<div[^>]*error|<span[^>]*error|undefined|NaN/gi) || []).length;

      console.log(`✓ Page errors (JS): ${pageErrors.length}`);
      console.log(`✓ Console errors: ${consoleErrors.length}`);
      console.log(`✓ HTML error elements: ${detailErrorInstances}`);
      console.log(`✓ URL: ${page.url()}`);

      // Check for key content
      const hasTitle = await page.locator('h1, h2').count() > 0;
      const hasMetrics = await page.locator('[class*="metric"], [class*="stat"]').count() > 0;
      console.log(`✓ Has title/heading: ${hasTitle}`);
      console.log(`✓ Has visible metrics: ${hasMetrics}`);
    }

    console.log('\n=== VERDICT ===');
    const verdict = pageErrors.length === 0 && consoleErrors.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${verdict}`);

  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
})();
