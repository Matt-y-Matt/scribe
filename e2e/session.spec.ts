import { expect, test, type Page } from '@playwright/test'

// The live screen around the map (UI_SPEC §2.1, §2.5, PRD F3.5, F8): the
// status strip's pause, the transcript that follows the meeting until the
// host scrolls away, and the timeline's seek and highlights.

const indicator = (page: Page) => page.getByTestId('indicator')
const transcript = (page: Page) => page.getByTestId('transcript')
const jump = (page: Page) => page.getByRole('button', { name: /Jump to live/ })
const waveform = (page: Page) => page.getByTestId('waveform')
const playhead = (page: Page) => page.getByTestId('playhead')

/** How far the transcript is from its end, in pixels. */
const fromBottom = (page: Page) =>
  transcript(page).evaluate(
    box => box.scrollHeight - box.scrollTop - box.clientHeight
  )

const session = (page: Page) =>
  page.evaluate(() => {
    const state = window.__scribe?.session.getState()
    return {
      rec: state?.rec,
      playing: state?.playback.playing,
      tMs: state?.playback.tMs,
      elapsedMs: state?.elapsedMs,
      highlights: state?.highlights.map(row => [
        row.t0_ms,
        row.t1_ms,
        row.label,
      ]),
    }
  })

async function open(page: Page, screen: string) {
  const errors: string[] = []
  page.on('pageerror', error => {
    // Chromium's note that a resize was delivered a frame late: harmless.
    if (!error.message.includes('ResizeObserver loop')) {
      errors.push(error.message)
    }
  })
  await page.goto(`/?screen=${screen}`)
  await expect(indicator(page)).toBeVisible()
  await page.waitForFunction(() => window.__scribe !== undefined)
  return errors
}

test.describe('status strip', () => {
  test('a hold of 300 ms pauses, and a click resumes', async ({ page }) => {
    const errors = await open(page, 'live')
    await expect(indicator(page)).toContainText('REC')

    // A click, however firm, does not pause a live recording.
    await indicator(page).click()
    await expect(indicator(page)).toContainText('REC')

    const box = await indicator(page).boundingBox()
    if (!box) throw new Error('no indicator')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForTimeout(400)
    await page.mouse.up()
    // Letting go does not undo the pause.
    await expect(indicator(page)).toContainText('PAUSED')
    expect((await session(page)).rec).toBe('paused')

    await indicator(page).click()
    await expect(indicator(page)).toContainText('REC')
    expect(errors).toEqual([])
  })

  test('an agenda chip brings its column to the left of the map', async ({
    page,
  }) => {
    await open(page, 'live')
    const transform = () =>
      page
        .locator('.react-flow__viewport')
        .evaluate(element => (element as HTMLElement).style.transform)
    const before = await transform()
    await page
      .getByRole('navigation', { name: 'Agenda' })
      .getByRole('button', { name: 'Designer hire' })
      .click()
    await expect.poll(transform).not.toBe(before)
    const heading = await page
      .getByText('Designer hire', { exact: true })
      .last()
      .boundingBox()
    expect(heading?.x).toBeLessThan(60)
  })
})

test.describe('transcript', () => {
  test('follows the live text until the host scrolls up, then offers Jump to live', async ({
    page,
  }) => {
    const errors = await open(page, 'live')
    // It opens at the end and stays there as lines arrive.
    expect(await fromBottom(page)).toBeLessThan(2)
    await expect(jump(page)).toBeHidden()
    await page.evaluate(() => window.__scribe?.say(3))
    await expect(transcript(page)).toContainText('Said line 3')
    expect(await fromBottom(page)).toBeLessThan(2)

    // The host scrolls up to read: new lines no longer move the view.
    await transcript(page).evaluate(box => (box.scrollTop = 200))
    await expect(jump(page)).toBeVisible()
    await page.evaluate(() => window.__scribe?.say(4))
    await expect(transcript(page)).toContainText('Said line 7')
    expect(await transcript(page).evaluate(box => box.scrollTop)).toBe(200)

    await jump(page).click()
    await expect(jump(page)).toBeHidden()
    expect(await fromBottom(page)).toBeLessThan(2)
    await page.evaluate(() => window.__scribe?.say(1))
    await expect(transcript(page)).toContainText('Said line 8')
    expect(await fromBottom(page)).toBeLessThan(2)
    expect(errors).toEqual([])
  })

  test('a click on a line plays that span', async ({ page }) => {
    await open(page, 'live')
    await transcript(page)
      .getByRole('button')
      .filter({ hasText: 'Pinned. I’ll message the landlord' })
      .or(transcript(page).getByRole('button').last())
      .first()
      .click()
    const state = await session(page)
    expect(state.playing).toBe(true)
    expect(state.tMs).toBeGreaterThan(0)
  })
})

test.describe('timeline', () => {
  test('a click on the waveform seeks to that moment', async ({ page }) => {
    const errors = await open(page, 'live')
    await expect(waveform(page).locator('canvas').first()).toBeVisible()
    // Live and not playing: no playhead, the clock reads the live edge.
    await expect(playhead(page)).toHaveCount(0)

    const box = await waveform(page).boundingBox()
    if (!box) throw new Error('no waveform')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)

    await expect(playhead(page)).toBeVisible()
    const state = await session(page)
    expect(state.playing).toBe(true)
    // Half way across is half way through, to within a second.
    const half = (state.elapsedMs ?? 0) / 2
    expect(Math.abs((state.tMs ?? 0) - half)).toBeLessThan(1_000)
    const line = await playhead(page).boundingBox()
    expect(Math.abs((line?.x ?? 0) - (box.x + box.width / 2))).toBeLessThan(4)
    expect(errors).toEqual([])
  })

  test('a drag marks a highlight, which becomes a quote card and can be undone', async ({
    page,
  }) => {
    const errors = await open(page, 'live')
    await expect(waveform(page).locator('canvas').first()).toBeVisible()
    const quotes = page.locator('[data-kind=quote]')
    const before = await quotes.count()

    const box = await waveform(page).boundingBox()
    if (!box) throw new Error('no waveform')
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + box.width * 0.4, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.45, y, { steps: 6 })
    await page.mouse.up()

    const name = page.getByLabel('Name this highlight')
    await expect(name).toBeFocused()
    await name.fill('Fallback plan')
    await name.press('Enter')

    await expect(quotes).toHaveCount(before + 1)
    await expect(quotes.last()).toContainText('Fallback plan')
    const state = await session(page)
    const added = state.highlights?.find(row => row[2] === 'Fallback plan')
    expect(added).toBeDefined()
    // The region covers what was dragged: 40% to 45% of the meeting.
    const elapsed = state.elapsedMs ?? 0
    expect(Math.abs(Number(added?.[0]) - elapsed * 0.4)).toBeLessThan(2_000)
    expect(Math.abs(Number(added?.[1]) - elapsed * 0.45)).toBeLessThan(2_000)
    await expect(waveform(page)).toContainText('Fallback plan')

    // The card is the host's doing: Ctrl+Z takes it back.
    await page.locator('body').press('Control+z')
    await expect(quotes).toHaveCount(before)
    expect(errors).toEqual([])
  })

  test('Escape drops a highlight that was not named', async ({ page }) => {
    await open(page, 'live')
    await expect(waveform(page).locator('canvas').first()).toBeVisible()
    const box = await waveform(page).boundingBox()
    if (!box) throw new Error('no waveform')
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + box.width * 0.6, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.7, y, { steps: 6 })
    await page.mouse.up()
    const name = page.getByLabel('Name this highlight')
    await expect(name).toBeVisible()
    const before = (await session(page)).highlights?.length
    await name.press('Escape')
    await expect(name).toBeHidden()
    expect((await session(page)).highlights?.length).toBe(before)
  })

  test('a card click plays what the card was made from and outlines it', async ({
    page,
  }) => {
    await open(page, 'live')
    const card = page
      .getByRole('listitem')
      .filter({ hasText: 'Platform setup fee 7,500' })
    await card.click()
    const state = await session(page)
    expect(state.playing).toBe(true)
    // The card's time link: 00:01:06.
    expect(Math.floor((state.tMs ?? 0) / 1000)).toBe(66)
    await expect(card).toHaveClass(/outline-accent/)
  })

  test('the keyboard seeks: ] forward ten seconds, [ back', async ({
    page,
  }) => {
    await open(page, 'live')
    const box = await waveform(page).boundingBox()
    if (!box) throw new Error('no waveform')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const start = (await session(page)).tMs ?? 0
    await page.locator('body').press(']')
    expect((await session(page)).tMs).toBe(start + 10_000)
    await page.locator('body').press('[')
    await page.locator('body').press('[')
    expect((await session(page)).tMs).toBe(start - 10_000)
  })
})

test.describe('states', () => {
  test('with no microphone the screen says so and offers a way out', async ({
    page,
  }) => {
    await page.goto('/?screen=nomic-error')
    await expect(indicator(page)).toContainText('NOT RECORDING')
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('No microphone found.')
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(
      alert.getByRole('button', { name: 'Audio settings' })
    ).toBeVisible()
  })

  test('with no speech model the meeting records and the transcript is off', async ({
    page,
  }) => {
    await page.goto('/?screen=model-missing')
    await expect(indicator(page)).toContainText('REC')
    await expect(page.getByRole('status').first()).toContainText(
      'No speech model is installed.'
    )
    await expect(transcript(page)).toContainText('The transcript is off')
    await expect(waveform(page).locator('canvas').first()).toBeVisible()
  })

  test('paused: the indicator is grey text and one click from recording', async ({
    page,
  }) => {
    await page.goto('/?screen=paused')
    await expect(indicator(page)).toContainText('PAUSED')
    await indicator(page).click()
    await expect(indicator(page)).toContainText('REC')
  })
})
