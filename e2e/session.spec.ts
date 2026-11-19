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
  if (screen !== 'end') await expect(indicator(page)).toBeVisible()
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

  test('M keeps the last twenty seconds at once, as a quote on the map', async ({
    page,
  }) => {
    await open(page, 'live')
    const before = (await session(page)).highlights?.length ?? 0
    await page.keyboard.press('m')

    await expect(page.getByRole('region', { name: 'Timeline' })).toContainText(
      'as a quote on the map'
    )
    const now = await session(page)
    expect(now.highlights).toHaveLength(before + 1)
    const [t0, t1] = now.highlights?.at(-1) ?? [0, 0]
    expect(Number(t1) - Number(t0)).toBe(20_000)
    expect(t1).toBe(now.elapsedMs)
    await expect(page.locator('[data-kind=quote]').last()).toContainText(
      "I'll message the landlord"
    )

    // The button does the same, and Ctrl+Z takes a card back.
    await page.getByRole('button', { name: 'Mark' }).click()
    expect((await session(page)).highlights).toHaveLength(before + 2)
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

test.describe('the end of a meeting', () => {
  test('Stop goes to the end screen; unticking a row takes it out of the summary', async ({
    page,
  }) => {
    const errors = await open(page, 'live')
    await page.getByRole('button', { name: 'Stop' }).click()

    const summary = page.getByRole('textbox', { name: 'Summary text' })
    await expect(summary).toHaveValue(/## Decisions/)
    await expect(summary).toHaveValue(/Platform setup fee 7,500/)
    await expect(
      page.getByText('Nothing is sent from this screen.')
    ).toBeVisible()

    await page
      .getByRole('checkbox', {
        name: 'In the summary: Platform setup fee 7,500, one-time',
      })
      .uncheck()
    await expect(summary).not.toHaveValue(/Platform setup fee/)
    // Ctrl+Z takes back what the host did, not the ticks the screen opened with.
    await page.keyboard.press('Control+z')
    await expect(summary).toHaveValue(/Platform setup fee 7,500/)

    // An action with no owner is pointed out, and gets a draft once it has one.
    const actions = page.getByRole('region', { name: 'Actions' })
    const owner = actions.getByLabel('Owner of: Write the CLA quote')
    await owner.fill('')
    await owner.blur()
    await expect(actions).toContainText('1 has no owner')
    await owner.fill('Kabs')
    await owner.press('Enter')
    await expect(actions).not.toContainText('no owner')
    await expect(page.getByLabel('Draft for Kabs')).toHaveValue(
      /Write the CLA quote/
    )
    expect(errors).toEqual([])
  })

  test('Read back goes through the actions one person at a time', async ({
    page,
  }) => {
    await open(page, 'end')
    await page.getByRole('button', { name: 'Read back' }).click()
    const reading = page.getByRole('dialog', { name: 'Read back' })
    await expect(reading).toContainText('1 of 4')
    await expect(reading.getByRole('heading', { level: 3 })).toContainText(
      'Matt'
    )

    await page.keyboard.press('ArrowRight')
    await expect(reading.getByRole('heading', { level: 3 })).toContainText(
      'Kabs'
    )
    // Not Kabs's after all: one click, and it is in Ant's draft.
    await reading
      .getByRole('group', { name: 'Who owns: Get the Pantone from Ross' })
      .getByRole('button', { name: 'Ant' })
      .click()
    await expect(reading.getByRole('heading', { level: 3 })).toContainText(
      '2 actions'
    )
    await page.keyboard.press('Escape')
    await expect(reading).toHaveCount(0)
    await expect(page.getByLabel('Draft for Ant')).toHaveValue(
      /Get the Pantone from Ross/
    )
  })

  test('the map and the recording are one click away, and Summary comes back', async ({
    page,
  }) => {
    await open(page, 'end')
    await page.getByRole('button', { name: 'Map and recording' }).click()
    await expect(indicator(page)).toContainText('REVIEW')
    await expect(page.getByTestId('map')).toBeVisible()

    await page.getByRole('button', { name: 'Summary', exact: true }).click()
    await expect(
      page.getByRole('textbox', { name: 'Summary text' })
    ).toBeVisible()
  })
})

test.describe('actions that carry over', () => {
  test('last time’s open actions lead the rail, and a tick marks one done', async ({
    page,
  }) => {
    const errors = await open(page, 'live-last-time')
    const rail = page.getByRole('region', { name: /FROM LAST TIME/ })
    await expect(rail).toContainText('3 open')
    await rail
      .getByRole('checkbox', { name: 'Done: Chase UDO for the signed PO' })
      .check()
    await expect(rail).toContainText('2 open')
    await expect(rail.getByText('Chase UDO for the signed PO')).toHaveCSS(
      'text-decoration-line',
      'line-through'
    )
    // The pins and the transcript are still there under it.
    await expect(page.getByRole('region', { name: /^PINS/ })).toBeVisible()
    await expect(transcript(page)).toBeVisible()
    expect(errors).toEqual([])
  })

  test('Home lists what is owed by person; New meeting like this fills the sheet', async ({
    page,
  }) => {
    await page.goto('/?screen=home-list')
    await page.getByRole('tab', { name: 'Open actions (11)' }).click()
    const zach = page.getByRole('region', { name: 'Zach' })
    await expect(zach).toContainText('3 open')
    await zach
      .getByRole('checkbox', { name: 'Done: Draft the two options for UDO' })
      .check()
    await expect(zach).toContainText('2 open')
    await expect(
      page.getByRole('tab', { name: 'Open actions (10)' })
    ).toBeVisible()

    await page
      .getByRole('button', { name: /Custore weekly team meeting/ })
      .click()
    await page.getByRole('button', { name: 'New meeting like this' }).click()
    const sheet = page.getByRole('dialog', { name: 'New meeting' })
    await expect(sheet.getByPlaceholder('Weekly team meeting')).toHaveValue(
      'Custore weekly team meeting'
    )
    await sheet.getByRole('button', { name: '+ Office aircon' }).click()
    await expect(
      sheet.getByRole('list', { name: 'Agenda headers' })
    ).toContainText('Office aircon')
  })
})

test.describe('meetings on Home', () => {
  test('a meeting is renamed in place, and deleted after a confirmation', async ({
    page,
  }) => {
    await page.goto('/?screen=home-list')
    const list = page.getByRole('list', { name: 'Meetings' })
    await list.getByRole('button', { name: /BNI one-to-one/ }).click()

    await page.getByRole('button', { name: 'More for BNI one-to-one' }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const box = page.getByRole('textbox', { name: 'Meeting title' })
    await expect(box).toBeFocused()
    await box.fill('BNI: Priya')
    await box.press('Enter')
    await expect(list).toContainText('BNI: Priya')

    await page.getByRole('button', { name: 'More for BNI: Priya' }).click()
    await page.getByRole('menuitem', { name: 'Delete…' }).click()
    const asking = page.getByRole('dialog', { name: 'Delete this meeting?' })
    await expect(asking).toContainText('This cannot be undone.')
    // Escape is "no".
    await page.keyboard.press('Escape')
    await expect(asking).toHaveCount(0)
    await expect(list).toContainText('BNI: Priya')

    await page.getByRole('button', { name: 'More for BNI: Priya' }).click()
    await page.getByRole('menuitem', { name: 'Delete…' }).click()
    await asking.getByRole('button', { name: 'Delete meeting' }).click()
    await expect(asking).toHaveCount(0)
    await expect(list).not.toContainText('BNI: Priya')
    await expect(list.getByRole('button')).toHaveCount(3)
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

  test('with the local model silent the screen says the map is behind', async ({
    page,
  }) => {
    await open(page, 'notes-off')
    await expect(page.getByText('The map is not being written.')).toBeVisible()
    await expect(indicator(page)).toContainText('REC')
    // The transcript carries on.
    await expect(transcript(page).getByRole('listitem').first()).toBeVisible()
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
