import { chromium } from 'playwright'

const BASE = 'http://localhost:3000'

const PAGES = [
  { name: 'dashboard',  path: '/?range=7d' },
  { name: 'agents',     path: '/agents?range=7d' },
  { name: 'sessions',   path: '/sessions?range=7d' },
  { name: 'apps',       path: '/apps?range=all' },
  { name: 'errors',     path: '/errors?range=today' },
  { name: 'people',     path: '/people?range=7d' },
]

async function check(page, url) {
  const errors = []
  const consoleErrors = []
  page.removeAllListeners('console')
  page.removeAllListeners('pageerror')
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => errors.push(e.message))
  const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 })
  const visibleErrText = await page.locator('text=/Application error|server-side exception/i').count()
  return { status: res.status(), pageErrors: errors, consoleErrors, visibleErr: visibleErrText }
}

async function run() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  try {
    console.log('\n=== Pages ===')
    for (const p of PAGES) {
      const r = await check(page, BASE + p.path)
      const rangePillActive = await page.locator('.range-pill.is-active').count()
      const ok = r.status === 200 && r.pageErrors.length === 0 && r.visibleErr === 0
      console.log(`${ok ? '✅' : '❌'} ${p.name.padEnd(10)} ${r.status}  rangePill=${rangePillActive}  pageErrors=${r.pageErrors.length}  visibleErr=${r.visibleErr}`)
      if (r.pageErrors.length) r.pageErrors.forEach(e => console.log('   ERR:', e))
      if (r.consoleErrors.length) console.log('   console errs:', r.consoleErrors.length)
      await page.screenshot({ path: `verify_${p.name}.png`, fullPage: true })
    }

    // Open one session detail
    console.log('\n=== Session detail ===')
    await page.goto(BASE + '/sessions', { waitUntil: 'networkidle' })
    const firstRow = page.locator('table.ledger-sessions tbody tr.clickable').first()
    if (await firstRow.count() > 0) {
      const sessionLink = firstRow.locator('a').first()
      const href = await sessionLink.getAttribute('href')
      if (href) {
        const r = await check(page, BASE + href)
        console.log(`detail status=${r.status} pageErrors=${r.pageErrors.length}`)
        const promptsSection = await page.locator('text=/Prompts/i').count()
        const turnDetailsCount = await page.locator('details').count()
        console.log(`prompts section visible=${promptsSection}  turn details=${turnDetailsCount}`)
        if (r.pageErrors.length) r.pageErrors.forEach(e => console.log('   ERR:', e))
        await page.screenshot({ path: 'verify_session_detail.png', fullPage: true })
      }
    } else {
      console.log('No session rows to click')
    }
  } finally {
    await browser.close()
  }
}

run().catch(e => { console.error('FATAL:', e); process.exit(1) })
