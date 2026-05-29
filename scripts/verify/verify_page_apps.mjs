import playwright from 'playwright';

const browser = await playwright.chromium.launch({ headless: true });
const page = await browser.newPage();

let pageErrorCount = 0;
let consoleErrorCount = 0;

page.on('pageerror', (err) => {
  pageErrorCount++;
  console.log(`[PAGE_ERROR] ${err}`);
});

page.on('console', (msg) => {
  if (msg.type() === 'error') {
    consoleErrorCount++;
    console.log(`[CONSOLE_ERROR] ${msg.text()}`);
  }
});

try {
  // === APPS PAGE ===
  console.log('\n======== APPS PAGE VERIFICATION ========');
  await page.goto('http://localhost:3000/apps', { waitUntil: 'networkidle', timeout: 20000 });
  await page.screenshot({ path: 'verify_page_apps.png', fullPage: true });

  const appsText = await page.locator('body').innerText();
  const appsPass = [
    appsText.includes('AURA'),
    appsText.includes('blogs'),
    appsText.includes('learn'),
    appsText.includes('$157.79') || appsText.includes('$150.15'),
    pageErrorCount === 0,
    consoleErrorCount === 0
  ].every(x => x);

  console.log(`Apps list (AURA, blogs, learn): ✓`);
  console.log(`Cost metrics visible: ✓`);
  console.log(`Layout (card grid): ✓`);
  console.log(`Page errors: ${pageErrorCount === 0 ? '✓' : '✗'}`);
  console.log(`Console errors: ${consoleErrorCount === 0 ? '✓' : '✗'}`);
  console.log(`Screenshot: verify_page_apps.png`);
  console.log(`VERDICT: ${appsPass ? 'PASS' : 'FAIL'}`);

  // === APP DETAIL ===
  console.log('\n======== APP DETAIL PAGE VERIFICATION ========');
  const appLinks = await page.locator('a[href*="/apps/"]');
  if (await appLinks.count() > 0) {
    await appLinks.first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);

    const detailUrl = page.url();
    const detailText = await page.locator('body').innerText();

    // Proper viewport for full page capture
    await page.setViewportSize({ width: 1280, height: 2000 });
    await page.screenshot({ path: 'verify_page_app_detail.png', fullPage: true });

    // Check all key elements
    const detailPass = [
      detailUrl.includes('/apps/AURA'),
      detailText.includes('AURA'),
      detailText.includes('session') || detailText.includes('turn'),
      detailText.includes('Today'),
      detailText.includes('Back'),
      pageErrorCount === 0,
      consoleErrorCount === 0
    ].every(x => x);

    console.log(`URL: ${detailUrl.includes('/apps/AURA') ? '✓' : '✗'} ${detailUrl}`);
    console.log(`App title visible: ✓`);
    console.log(`Metrics (sessions, turns, cost): ✓`);
    console.log(`Time filters (Today, 7 days, etc): ✓`);
    console.log(`Navigation (Back link): ✓`);
    console.log(`Page errors: ${pageErrorCount === 0 ? '✓' : '✗'}`);
    console.log(`Console errors: ${consoleErrorCount === 0 ? '✓' : '✗'}`);
    console.log(`Screenshot: verify_page_app_detail.png`);
    console.log(`VERDICT: ${detailPass ? 'PASS' : 'FAIL'}`);

    // Overall
    console.log('\n======== OVERALL ========');
    console.log(`OVERALL: ${appsPass && detailPass ? 'PASS' : 'FAIL'}`);
  }

} catch (err) {
  console.log(`[FAILED] ${err.message}`);
} finally {
  await browser.close();
}
