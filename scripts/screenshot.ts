// `pnpm screenshot [screen-id ...]`
// Renders every screen state in src/screens/screens.ts, light and dark, under
// `vite dev` and writes `.screenshots/<screen>.<theme>.png`. Look at the
// images against docs/UI_SPEC.md §2 and §5 before calling UI work done.
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import { chromium } from '@playwright/test'
import { isScreenId, SCREEN_IDS, type ScreenId } from '../src/screens/screens'

const OUT_DIR = resolve('.screenshots')
const THEMES = ['light', 'dark'] as const
// The minimum window (UI_SPEC §2), at 2× so text is legible in review.
const VIEWPORT = { width: 1280, height: 800 }

const requested = process.argv.slice(2).filter(arg => arg !== '--')
const unknown = requested.filter(id => !isScreenId(id))
if (unknown.length > 0) {
  console.error(
    `Unknown screen: ${unknown.join(', ')}. Known: ${SCREEN_IDS.join(', ')}`
  )
  process.exit(1)
}
const screens: readonly ScreenId[] =
  requested.length > 0 ? requested.filter(isScreenId) : SCREEN_IDS

function freePort(): Promise<number> {
  return new Promise((done, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address
          ? done(address.port)
          : reject(new Error('no free port'))
      )
    })
  })
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`vite dev did not start: ${url}`)
    await new Promise(wait => setTimeout(wait, 150))
  }
}

// Vite runs as its own process, as it does under `pnpm dev`: loading it inside
// this tsx process breaks the React Compiler preset (import.meta.resolve).
const viteBin = resolve(
  dirname(createRequire(import.meta.url).resolve('vite/package.json')),
  'bin/vite.js'
)
const port = await freePort()
const baseUrl = `http://127.0.0.1:${port}/`
const server = spawn(
  process.execPath,
  [viteBin, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { stdio: ['ignore', 'ignore', 'inherit'] }
)

const problems: string[] = []
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

try {
  await waitForServer(baseUrl, 30_000)
  browser = await chromium.launch()
  await mkdir(OUT_DIR, { recursive: true })
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  })

  for (const screen of screens) {
    for (const theme of THEMES) {
      const name = `${screen}.${theme}`
      const page = await context.newPage()
      page.on('pageerror', error => problems.push(`${name}: ${error.message}`))
      page.on('console', message => {
        if (message.type() === 'error') {
          problems.push(`${name}: ${message.text()}`)
        }
      })

      await page.goto(`${baseUrl}?screen=${screen}&theme=${theme}`, {
        waitUntil: 'networkidle',
      })
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: resolve(OUT_DIR, `${name}.png`) })
      await page.close()
      console.log(`.screenshots/${name}.png`)
    }
  }
} finally {
  await browser?.close()
  server.kill()
}

if (problems.length > 0) {
  console.error(`\nThe page reported errors:\n${problems.join('\n')}`)
  process.exit(1)
}
