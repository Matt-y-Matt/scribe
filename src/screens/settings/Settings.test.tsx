import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelDownload } from '@/ipc'
import { BackendContext, type Backend } from '@/lib/backend'
import {
  fixtureBackend,
  FIXTURE_MODELS,
  type FixtureData,
} from '@/lib/fixture-backend'
import { DEFAULT_PREFS, usePrefs } from '@/lib/prefs'
import { Settings } from './Settings'

afterEach(() => usePrefs.setState(DEFAULT_PREFS))

function show(
  tab: 'audio' | 'speech',
  data: Partial<FixtureData> = {},
  patch: Partial<Backend> = {}
) {
  const backend = { ...fixtureBackend(data), ...patch }
  const onClose = vi.fn()
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BackendContext value={backend}>
        <Settings tab={tab} onTab={() => undefined} onClose={onClose} />
      </BackendContext>
    </QueryClientProvider>
  )
  return { onClose }
}

describe('Settings, Audio', () => {
  it('lists the microphones and remembers the one chosen', async () => {
    show('audio')
    const select = await screen.findByRole('combobox')
    expect(select).toHaveTextContent('Default (Microphone (USB Audio Device))')
    fireEvent.change(select, { target: { value: 'Headset (Jabra Evolve2)' } })
    expect(usePrefs.getState().microphone).toBe('Headset (Jabra Evolve2)')
    fireEvent.change(select, { target: { value: '' } })
    expect(usePrefs.getState().microphone).toBeNull()
  })

  it('turns system audio on and off', async () => {
    show('audio')
    const box = await screen.findByRole('checkbox')
    expect(box).not.toBeChecked()
    fireEvent.click(box)
    expect(usePrefs.getState().loopback).toBe(true)
  })

  it('says so when the PC has no microphone', async () => {
    show('audio', {
      devices: { microphones: [], default_microphone: null },
    })
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No microphone found.'
    )
  })

  it('closes on Escape', async () => {
    const { onClose } = show('audio')
    await screen.findByRole('combobox')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('Settings, Speech', () => {
  it('shows each model with its size and licence, and which are installed', async () => {
    show('speech')
    const rows = await screen.findAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveTextContent('Parakeet-TDT 0.6B v3')
    expect(rows[0]).toHaveTextContent('671 MB · CC-BY-4.0')
    expect(rows[0]).toHaveTextContent('Installed')
    expect(rows[1]).toHaveTextContent('1037 MB · MIT')
    // A model that is not on disk cannot be chosen.
    expect(
      screen.getByRole('radio', { name: 'Use Whisper large-v3-turbo' })
    ).toBeDisabled()
  })

  it('starts a download, shows its progress, and can cancel it', async () => {
    let announce: (event: ModelDownload) => void = () => undefined
    const downloadModel = vi.fn(async () => undefined)
    const cancelDownload = vi.fn(async () => undefined)
    show(
      'speech',
      {},
      {
        downloadModel,
        cancelDownload,
        onModelDownload: listener => {
          announce = listener
          return () => undefined
        },
      }
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))
    expect(downloadModel).toHaveBeenCalledWith('whisper-large-v3-turbo-int8')

    const event = {
      model_id: 'whisper-large-v3-turbo-int8',
      bytes: 518_306_895,
      total: 1_036_613_791,
      done: false,
      error: null,
    }
    act(() => announce(event))
    const bar = await screen.findByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText('518 MB / 1037 MB')).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancelDownload).toHaveBeenCalledWith('whisper-large-v3-turbo-int8')

    // Cancelled: what arrived is kept, and the button offers to carry on.
    act(() =>
      announce({ ...event, done: true, error: 'the download was cancelled' })
    )
    expect(
      await screen.findByRole('button', { name: 'Try again' })
    ).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('What arrived is kept')
  })

  it('says a meeting is still recorded when no model is installed', async () => {
    show('speech', {
      models: FIXTURE_MODELS.map(model => ({ ...model, installed: false })),
    })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Without a model a meeting is still recorded, with no transcript.'
    )
  })
})
