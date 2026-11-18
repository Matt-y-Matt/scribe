// `pnpm exec tsx scripts/shot.ts <name> <url-query> [step ...]`
// One screenshot of a screen state after a few steps, for looking at a
// change while building it. Needs `vite dev` on 127.0.0.1:4173 (`pnpm e2e`
// uses the same port). Steps: `click:<css>`, `hover:<css>`, `type:<text>`,
// `press:<key>`, `fill:<css>=<text>`, `wait:<ms>`.
// Example: tsx scripts/shot.ts edit "screen=live" "hover:[data-card-id]"
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium } from '@playwright/test'

const [name, query, ...steps] = process.argv.slice(2)
if (!name || !query) {
  console.error('usage: shot.ts <name> <url-query> [step ...]')
  process.exit(1)
}

const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  })
  page.on('pageerror', error => console.error(`page error: ${error.message}`))
  page.on('console', message => {
    if (message.type() === 'error') console.error(`console: ${message.text()}`)
  })
  await page.goto(`http://127.0.0.1:4173/?${query}`, {
    waitUntil: 'networkidle',
  })
  await page.evaluate(() => document.fonts.ready)
  for (const step of steps) {
    const [verb, ...rest] = step.split(':')
    const arg = rest.join(':')
    if (verb === 'click') await page.locator(arg).first().click()
    else if (verb === 'hover') await page.locator(arg).first().hover()
    else if (verb === 'type') await page.keyboard.type(arg)
    else if (verb === 'press') await page.keyboard.press(arg)
    else if (verb === 'fill') {
      const at = arg.indexOf('=')
      await page
        .locator(arg.slice(0, at))
        .first()
        .fill(arg.slice(at + 1))
    } else if (verb === 'wait') await page.waitForTimeout(Number(arg))
    else throw new Error(`unknown step: ${step}`)
  }
  await page.waitForTimeout(200)
  await mkdir('.screenshots', { recursive: true })
  const path = resolve('.screenshots', `${name}.png`)
  await page.screenshot({ path })
  console.log(path)
} finally {
  await browser.close()
}
