import { expect, test, type Locator, type Page } from '@playwright/test'

// The live map's behaviour rules (UI_SPEC §4, TEST_PLAN §2): the viewport
// never moves by itself, nothing changes until a ghost is accepted, cards
// drag between topics, and everything a person does can be undone.

const topic = (page: Page, title: string) =>
  page.getByRole('region', { name: title, exact: true })
const card = (page: Page, text: string) =>
  page.getByRole('listitem').filter({ hasText: text })
const pinsRail = (page: Page) => page.getByRole('region', { name: /^PINS/ })

/** The canvas transform: pan and zoom. Only the host may change it. */
const viewport = (page: Page) =>
  page
    .locator('.react-flow__viewport')
    .evaluate(element => (element as HTMLElement).style.transform)

/** Every map node's position, by id, as React Flow placed it. */
const positions = (page: Page) =>
  page
    .locator('.react-flow__node')
    .evaluateAll(nodes =>
      Object.fromEntries(
        nodes.map(node => [
          node.getAttribute('data-id') ?? '',
          (node as HTMLElement).style.transform,
        ])
      )
    )

const nodeId = (locator: Locator) =>
  locator.evaluate(element => element.getAttribute('data-topic-id') ?? '')

const parentOf = (page: Page, topicId: string) =>
  page.evaluate(
    id => window.__scribe?.store.getState().topics[id]?.parent_id,
    topicId
  )

async function open(page: Page, screen: string) {
  const errors: string[] = []
  page.on('pageerror', error => {
    // Chromium's note that a resize was delivered a frame late: harmless.
    if (!error.message.includes('ResizeObserver loop')) {
      errors.push(error.message)
    }
  })
  // These tests are about the map. They were written when the map had the
  // whole 800 px of the minimum window; the status strip and the timeline
  // now take 168 px of it, so the window is that much taller here.
  await page.setViewportSize({ width: 1280, height: 968 })
  await page.goto(`/?screen=${screen}`)
  await expect(topic(page, 'Pricing')).toBeVisible()
  await page.waitForFunction(() => window.__scribe !== undefined)
  return errors
}

/** Presses on `from`, moves to `to` in steps, and lets go. */
async function drag(page: Page, from: Locator, to: Locator, dy = 0) {
  const start = await from.boundingBox()
  const end = await to.boundingBox()
  if (!start || !end) throw new Error('nothing to drag')
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + start.width / 2 + 8, start.y + 8, {
    steps: 4,
  })
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2 + dy, {
    steps: 12,
  })
  await page.mouse.up()
}

test.describe('viewport stability', () => {
  test('20 card inserts leave the viewport and the other topics alone', async ({
    page,
  }) => {
    const errors = await open(page, 'live')
    const before = {
      viewport: await viewport(page),
      nodes: await positions(page),
    }
    const names = await nodeId(topic(page, 'Name embroidery'))

    for (let n = 0; n < 20; n++) {
      const title = n % 2 === 0 ? 'Artwork' : 'Lead times'
      const [text] = await page.evaluate(
        where => window.__scribe?.insertCards(where, 1) ?? [],
        title
      )
      await expect(page.getByText(text ?? '', { exact: true })).toHaveCount(1)
    }
    await expect(topic(page, 'Artwork').getByLabel('13 cards')).toBeVisible()

    // No auto-pan and no auto-zoom: the transform is exactly what it was.
    expect(await viewport(page)).toBe(before.viewport)

    // Artwork grew, so the one topic under it moved down. Nothing else moved.
    await expect
      .poll(async () => (await positions(page))[names])
      .not.toBe(before.nodes[names])
    const after = await positions(page)
    const moved = Object.keys(before.nodes).filter(
      id => after[id] !== before.nodes[id]
    )
    expect(moved).toEqual([names])

    // Pushed down, not overlapped.
    const artwork = await topic(page, 'Artwork').boundingBox()
    const below = await topic(page, 'Name embroidery').boundingBox()
    expect(below?.x).toBeCloseTo(artwork?.x ?? 0, 0)
    expect(below?.y).toBeGreaterThanOrEqual(
      (artwork?.y ?? 0) + (artwork?.height ?? 0)
    )
    expect(errors).toEqual([])
  })

  test('cards that land out of sight raise a pill instead of panning', async ({
    page,
  }) => {
    await open(page, 'live')
    const before = await viewport(page)
    const pill = page.getByRole('button', { name: 'new cards' })
    await expect(pill).toHaveCount(0)

    await page.evaluate(() =>
      window.__scribe?.insertCards('Name embroidery', 8)
    )
    await expect(pill).toBeVisible()
    expect(await viewport(page)).toBe(before)

    // Pressing it is the host's choice, and only then does the map move.
    await pill.click()
    await expect(pill).toHaveCount(0)
    expect(await viewport(page)).not.toBe(before)
    await expect(card(page, 'Inserted card 8')).toBeInViewport()
  })

  test('a dragged topic keeps its place until tidy', async ({ page }) => {
    await open(page, 'live')
    const artwork = topic(page, 'Artwork')
    const id = await nodeId(artwork)
    const home = (await positions(page))[id]

    // Down and a little right, still inside the CLA column.
    const heading = artwork.getByRole('heading', { name: 'Artwork' })
    await drag(page, heading, heading, 260)
    const dropped = (await positions(page))[id]
    expect(dropped).not.toBe(home)

    // New cards do not pull it back into the stack.
    await page.evaluate(() => window.__scribe?.insertCards('Pricing', 3))
    await expect(card(page, 'Inserted card 3')).toHaveCount(1)
    expect((await positions(page))[id]).toBe(dropped)

    await page.keyboard.press('t')
    await expect.poll(async () => (await positions(page))[id]).not.toBe(dropped)
  })

  test('a topic dropped on another header moves to that column', async ({
    page,
  }) => {
    await open(page, 'live')
    const artwork = topic(page, 'Artwork')
    const id = await nodeId(artwork)
    const cla = await parentOf(page, id)

    await drag(
      page,
      artwork.getByRole('heading', { name: 'Artwork' }),
      page.getByRole('heading', { name: 'Supplier delays' }),
      300
    )
    await expect.poll(() => parentOf(page, id)).not.toBe(cla)

    await page.keyboard.press('Control+z')
    await expect.poll(() => parentOf(page, id)).toBe(cla)
  })

  test('fit and zoom happen only when asked, and zooming out collapses cards', async ({
    page,
  }) => {
    await open(page, 'live')
    const before = await viewport(page)

    await page.keyboard.press('f')
    await expect.poll(() => viewport(page)).not.toBe(before)

    const zoomOut = page.getByRole('button', { name: 'Zoom out' })
    await zoomOut.click()
    await zoomOut.click()
    // Below 0.7 the rows give way to kind counts; titles stay.
    await expect(card(page, 'Write the CLA quote')).toHaveCount(0)
    await expect(topic(page, 'Pricing').getByTitle('Decision')).toHaveText('2')
    await expect(
      topic(page, 'Pricing').getByRole('heading', { name: 'Pricing' })
    ).toBeVisible()
  })
})

test.describe('ghosts', () => {
  test('nothing moves until Accept, and undo puts it back', async ({
    page,
  }) => {
    await open(page, 'live-ghost')
    const pricing = topic(page, 'Pricing')
    const names = topic(page, 'Name embroidery')
    const moving = 'Ross may want names embroidered per person'
    const ghost = pricing
      .locator('[data-suggestion-id]')
      .filter({ hasText: 'Move here' })

    await expect(ghost).toContainText('from Name embroidery')
    await expect(
      names.getByRole('listitem').filter({ hasText: moving })
    ).toHaveCount(1)
    await expect(pricing.getByLabel('7 cards')).toBeVisible()

    await ghost.getByRole('button', { name: 'Accept' }).click()
    await expect(ghost).toHaveCount(0)
    await expect(
      pricing.getByRole('listitem').filter({ hasText: moving })
    ).toHaveCount(1)
    await expect(pricing.getByLabel('8 cards')).toBeVisible()
    await expect(names.getByLabel('2 cards')).toBeVisible()

    await page.keyboard.press('Control+z')
    await expect(
      names.getByRole('listitem').filter({ hasText: moving })
    ).toHaveCount(1)
    await expect(ghost).toBeVisible()

    await page.keyboard.press('Control+Shift+z')
    await expect(pricing.getByLabel('8 cards')).toBeVisible()
  })

  test('Dismiss removes the ghost and changes nothing else', async ({
    page,
  }) => {
    await open(page, 'live-ghost')
    const pricing = topic(page, 'Pricing')
    const ghost = pricing
      .locator('[data-suggestion-id]')
      .filter({ hasText: 'Merge' })
    await expect(ghost).toContainText('“Name embroidery” into this topic')

    await ghost.getByRole('button', { name: 'Dismiss' }).click()
    await expect(ghost).toHaveCount(0)
    await expect(topic(page, 'Name embroidery')).toBeVisible()
    await expect(pricing.getByLabel('7 cards')).toBeVisible()
    // The other ghost is still waiting.
    await expect(pricing.locator('[data-suggestion-id]')).toHaveCount(1)
  })

  test('accepting a merge folds the topic in', async ({ page }) => {
    await open(page, 'live-ghost')
    const pricing = topic(page, 'Pricing')
    await pricing
      .locator('[data-suggestion-id]')
      .filter({ hasText: 'Merge' })
      .getByRole('button', { name: 'Accept' })
      .click()

    await expect(topic(page, 'Name embroidery')).toHaveCount(0)
    await expect(pricing.getByLabel('10 cards')).toBeVisible()
    await page.keyboard.press('Control+z')
    await expect(topic(page, 'Name embroidery')).toBeVisible()
  })

  test('an off-agenda topic asks to be pinned, and Pin sends it to the rail', async ({
    page,
  }) => {
    await open(page, 'live-unplanned')
    await expect(pinsRail(page)).toContainText('Nothing pinned.')
    const aircon = topic(page, 'Office aircon')
    await expect(aircon).toContainText('New topic: Office aircon — Pin it?')

    await aircon.getByRole('button', { name: 'Pin', exact: true }).click()
    await expect(pinsRail(page)).toContainText('PINS (1)')
    await expect(pinsRail(page)).toContainText('pinned at 00:03:32 · 3 cards')
    // A small marker stays in the Unplanned column.
    await expect(page.locator('[data-pinned]')).toHaveText(
      /Office aircon.*pinned/
    )
  })
})

test.describe('cards', () => {
  test('drag a card to another topic, then undo and redo', async ({ page }) => {
    const errors = await open(page, 'live')
    const pricing = topic(page, 'Pricing')
    const artwork = topic(page, 'Artwork')
    const moving = 'Get the Pantone from Ross'
    const inPricing = pricing.getByRole('listitem').filter({ hasText: moving })
    const inArtwork = artwork.getByRole('listitem').filter({ hasText: moving })
    const before = await viewport(page)

    await drag(
      page,
      inArtwork,
      pricing.getByRole('heading', { name: 'Pricing' })
    )
    await expect(inPricing).toHaveCount(1)
    await expect(inArtwork).toHaveCount(0)
    // Dropped on the topic, it goes to the end of the list.
    await expect(pricing.getByRole('listitem').last()).toContainText(moving)
    expect(await viewport(page)).toBe(before)

    await page.keyboard.press('Control+z')
    await expect(inArtwork).toHaveCount(1)
    await expect(inPricing).toHaveCount(0)

    await page.keyboard.press('Control+Shift+z')
    await expect(inPricing).toHaveCount(1)
    expect(errors).toEqual([])
  })

  test('drop a card on another card to put it in front', async ({ page }) => {
    await open(page, 'live')
    const pricing = topic(page, 'Pricing')
    await drag(
      page,
      card(page, 'Vector logo and mockups'),
      card(page, 'Write the CLA quote')
    )
    const texts = await pricing.getByRole('listitem').allTextContents()
    const at = texts.findIndex(text => text.includes('Vector logo and mockups'))
    expect(at).toBeGreaterThanOrEqual(0)
    expect(texts[at + 1]).toContain('Write the CLA quote')
  })
})

test.describe('editing by hand', () => {
  test('a card is edited in place: owner and due, saved with Enter, undone with Ctrl+Z', async ({
    page,
  }) => {
    const errors = await open(page, 'live')
    const before = await viewport(page)
    // The transcript panel has list items too: look in the topic.
    const inTopic = (text: string) =>
      topic(page, 'Lead times').getByRole('listitem').filter({ hasText: text })
    const row = inTopic('Draft the two options for UDO')
    await row.hover()
    await row.getByRole('button', { name: 'Edit card' }).click()

    const form = page.getByRole('form', { name: 'Edit card' })
    await expect(form.getByLabel('Card text')).toBeFocused()
    await form.getByLabel('Due').fill('Thursday')
    // Typing in the form is not a key of the map: no pin, no tidy, no fit.
    await form.getByLabel('Card text').pressSequentially(' ptf')
    await form.getByLabel('Card text').press('Enter')

    await expect(form).toHaveCount(0)
    await expect(inTopic('Draft the two options for UDO ptf')).toContainText(
      'Zach · due Thursday'
    )
    await expect(pinsRail(page)).toContainText('PINS (2)')
    expect(await viewport(page)).toBe(before)

    await page.keyboard.press('Control+z')
    await expect(inTopic('Draft the two options for UDO ptf')).toHaveCount(0)
    await expect(inTopic('Draft the two options for UDO')).toBeVisible()
    expect(errors).toEqual([])
  })

  test('a card is added from the topic menu and deleted with an Undo toast', async ({
    page,
  }) => {
    await open(page, 'live')
    await page.getByRole('button', { name: 'Menu for Artwork' }).click()
    await page.getByRole('menuitem', { name: 'Add card' }).click()
    const form = page.getByRole('form', { name: 'New card' })
    await expect(form.getByLabel('Card text')).toBeFocused()
    await form.getByLabel('Card text').fill('Ask for the font name')
    await form.getByRole('radio', { name: 'Action' }).click()
    await form.getByLabel('Owner').fill('Ant')
    await form.getByRole('button', { name: 'Add' }).click()

    const added = card(page, 'Ask for the font name')
    await expect(added).toContainText('Ant')
    await expect(topic(page, 'Artwork').getByLabel('4 cards')).toBeVisible()

    await added.hover()
    await added.getByRole('button', { name: 'Edit card' }).click()
    await page
      .getByRole('form', { name: 'Edit card' })
      .getByRole('button', { name: 'Delete' })
      .click()
    await expect(added).toHaveCount(0)
    const toast = page.getByRole('status').filter({ hasText: 'Deleted' })
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect(added).toBeVisible()
  })
})

test.describe('search (Ctrl+K)', () => {
  test('finds a card and brings its topic into view; Escape leaves the map alone', async ({
    page,
  }) => {
    const errors = await open(page, 'live')
    const before = await viewport(page)

    // Opening, typing and closing moves nothing: P, T and F are text here.
    await page.keyboard.press('Control+k')
    const box = page.getByRole('combobox', { name: 'Search this meeting' })
    await expect(box).toBeFocused()
    await box.pressSequentially('ptf')
    await page.keyboard.press('Escape')
    await expect(box).toHaveCount(0)
    expect(await viewport(page)).toBe(before)
    await expect(pinsRail(page)).toContainText('PINS (2)')

    // Picking a result is the host asking: the map goes to that topic.
    await page.getByRole('button', { name: 'Search this meeting' }).click()
    await box.fill('job description')
    await expect(page.getByRole('option').first()).toContainText(
      'Write the job description'
    )
    await page.keyboard.press('Enter')
    await expect(box).toHaveCount(0)
    await expect(topic(page, 'Full-time or freelance')).toHaveAttribute(
      'data-active',
      'true'
    )
    expect(await viewport(page)).not.toBe(before)
    await expect(topic(page, 'Full-time or freelance')).toBeInViewport()
    expect(errors).toEqual([])
  })
})

test.describe('pins and the topic menu', () => {
  test('P pins the active topic; Revisit brings it back with the accent border', async ({
    page,
  }) => {
    await open(page, 'live')
    await topic(page, 'Lead times')
      .getByRole('heading', { name: 'Lead times' })
      .click()
    await expect(topic(page, 'Lead times')).toHaveAttribute(
      'data-active',
      'true'
    )

    await page.keyboard.press('p')
    await expect(pinsRail(page)).toContainText('PINS (3)')
    await expect(topic(page, 'Lead times')).toHaveCount(0)

    await pinsRail(page)
      .getByRole('listitem')
      .filter({ hasText: 'Lead times' })
      .getByRole('button', { name: 'Revisit now' })
      .click()
    await expect(topic(page, 'Lead times')).toHaveAttribute(
      'data-active',
      'true'
    )
    await expect(pinsRail(page)).toContainText('revisited')

    // Revisit, then the pin: two operations to take back.
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect(pinsRail(page)).toContainText('PINS (2)')
  })

  test('rename and delete from the menu, with an Undo toast', async ({
    page,
  }) => {
    await open(page, 'live')
    await page.getByRole('button', { name: 'Menu for Artwork' }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    const input = page.getByRole('textbox', { name: 'Topic title' })
    await input.fill('Logo artwork')
    await input.press('Enter')
    await expect(topic(page, 'Logo artwork')).toBeVisible()

    await page.getByRole('button', { name: 'Menu for Logo artwork' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await expect(topic(page, 'Logo artwork')).toHaveCount(0)

    const toast = page.getByRole('status').filter({ hasText: 'Deleted' })
    await expect(toast).toContainText('Deleted “Logo artwork”.')
    await toast.getByRole('button', { name: 'Undo' }).click()
    await expect(topic(page, 'Logo artwork')).toBeVisible()
    await expect(
      topic(page, 'Logo artwork').getByLabel('3 cards')
    ).toBeVisible()
  })
})
