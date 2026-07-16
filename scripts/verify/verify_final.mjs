import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
const PAGES = [
  { name: 'dashboard', path: '/' },
  { name: 'sessions',  path: '/sessions' },
  { name: 'agents',    path: '/agents' },
  { name: 'apps',      path: '/apps' },
  { name: 'people',    path: '/people' },
  { name: 'errors',    path: '/errors' },
];

const RAW_TAG_RX = /<command-name>|<command-message>|<command-args>|<local-command-stdout>/i;

async function checkPage(browser, p) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageerrors = [];
  const consoleerrs = [];
  page.on('pageerror', e => pageerrors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') consoleerrs.push(m.text()); });

  const url = BASE + p.path;
  const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  const status = res ? res.status() : 0;
  const body = await page.content();
  const hasRawTags = RAW_TAG_RX.test(body);

  let detail = null;
  if (p.name === 'sessions') {
    const firstRow = page.locator('table tbody tr').first();
    if (await firstRow.count() > 0) {
      const a = firstRow.locator('a').first();
      if (await a.count() > 0) await a.click();
      else await firstRow.click();
      await page.waitForLoadState('networkidle', { timeout: 15000 });
      const dBody = await page.content();
      detail = {
        url: page.url(),
        pageerrors: pageerrors.length,
        consoleerrs: consoleerrs.length,
        hasRawTags: RAW_TAG_RX.test(dBody),
      };
    }
  }

  await ctx.close();
  return {
    name: p.name,
    status,
    pageerrors: pageerrors.length,
    pageerrorSample: pageerrors[0] || null,
    consoleerrs: consoleerrs.length,
    consoleerrSample: consoleerrs[0] || null,
    hasRawTags,
    detail,
  };
}

const browser = await chromium.launch({ headless: true });
const results = [];
for (const p of PAGES) {
  try {
    results.push(await checkPage(browser, p));
  } catch (e) {
    results.push({ name: p.name, error: e.message });
  }
}
await browser.close();

let allPass = true;
console.log('\n=== RESULTS ===');
for (const r of results) {
  if (r.error) { console.log(`✗ ${r.name}: ERROR ${r.error}`); allPass = false; continue; }
  const ok = r.status === 200 && r.pageerrors === 0 && r.consoleerrs === 0 && !r.hasRawTags;
  console.log(`${ok ? '✓' : '✗'} ${r.name}  status=${r.status}  pageerrors=${r.pageerrors}  consoleerrs=${r.consoleerrs}  rawTags=${r.hasRawTags}`);
  if (r.pageerrorSample) console.log(`    first pageerror: ${r.pageerrorSample.slice(0, 200)}`);
  if (r.consoleerrSample) console.log(`    first consoleerr: ${r.consoleerrSample.slice(0, 200)}`);
  if (r.detail) {
    const dok = r.detail.pageerrors === r.pageerrors && r.detail.consoleerrs === r.consoleerrs && !r.detail.hasRawTags;
    console.log(`  ${dok ? '✓' : '✗'} session detail  pageerrors=${r.detail.pageerrors}  consoleerrs=${r.detail.consoleerrs}  rawTags=${r.detail.hasRawTags}`);
    if (!dok) allPass = false;
  }
  if (!ok) allPass = false;
}
console.log(`\nOVERALL: ${allPass ? 'PASS' : 'FAIL'}`);
process.exit(allPass ? 0 : 1);
