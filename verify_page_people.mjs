import { chromium } from 'playwright';

(async () => {
  let browser, page;
  const results = {
    STATUS: 'UNKNOWN',
    PAGEERRORS: [],
    CONSOLEERRORS: [],
    ERRTEXT: [],
    ROWS: 0,
    DETAIL_URL: null,
    DETAIL_PAGEERRORS: [],
    DETAIL_ERRTEXT: [],
  };

  try {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();

    // Capture page errors
    page.on('pageerror', err => {
      results.PAGEERRORS.push(err.message);
    });

    // Capture console errors
    page.on('console', msg => {
      if (msg.type() === 'error') {
        results.CONSOLEERRORS.push(msg.text());
      }
    });

    // Navigate to people page
    console.log('Navigating to /people...');
    await page.goto('http://localhost:3000/people', { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(500);

    // Take screenshot
    await page.screenshot({ path: 'verify_page_people.png', fullPage: true });
    console.log('Screenshot saved: verify_page_people.png');

    // Count error text in page content
    const pageContent = await page.content();
    const errorMatches = pageContent.match(/error|failed|undefined|NaN|no data/gi) || [];
    results.ERRTEXT = errorMatches.length;

    // Count person cards (look for link elements or clickable cards with person names)
    const personCards = await page.locator('a[href*="/people/"]').count();
    results.ROWS = personCards;
    console.log(`Found ${personCards} person cards/links`);

    // Click first person card if exists
    if (personCards > 0) {
      const firstCard = page.locator('a[href*="/people/"]').first();
      const href = await firstCard.getAttribute('href');
      results.DETAIL_URL = href;
      console.log(`Clicking first person card, navigating to: ${href}`);
      await firstCard.click();
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 });
      await page.waitForTimeout(500);

      // Screenshot detail page
      await page.screenshot({ path: 'verify_page_person_detail.png', fullPage: true });
      console.log('Screenshot saved: verify_page_person_detail.png');

      // Capture detail page errors
      const detailContent = await page.content();
      const detailErrorMatches = detailContent.match(/error|failed|undefined|NaN|no data/gi) || [];
      results.DETAIL_ERRTEXT = detailErrorMatches.length;
    }

    results.STATUS = 'COMPLETED';
  } catch (err) {
    results.STATUS = `ERROR: ${err.message}`;
    console.error('Test error:', err);
  } finally {
    if (browser) {
      await browser.close();
    }

    console.log('\n=== RESULTS ===');
    console.log(`STATUS: ${results.STATUS}`);
    console.log(`PAGEERRORS: ${results.PAGEERRORS.length}`);
    console.log(`CONSOLEERRORS: ${results.CONSOLEERRORS.length}`);
    console.log(`ERRTEXT: ${results.ERRTEXT} matches`);
    console.log(`ROWS: ${results.ROWS}`);
    console.log(`DETAIL_URL: ${results.DETAIL_URL}`);
    console.log(`DETAIL_ERRTEXT: ${results.DETAIL_ERRTEXT} matches`);
  }
})();
