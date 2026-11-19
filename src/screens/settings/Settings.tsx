import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Sheet } from '@/components/Sheet'
import { Button } from '@/components/ui/button'
import type { ModelDownload, ModelInfo } from '@/ipc'
import type { SettingsTab } from '@/lib/app-state'
import { useBackend } from '@/lib/backend'
import { logger } from '@/lib/logger'
import { usePrefs } from '@/lib/prefs'
import { setThemePreference, useTheme, type ThemePreference } from '@/lib/theme'
import { cn } from '@/lib/utils'

// Settings, UI_SPEC §3.5, with the two tabs M2 needs, Audio and Speech, and
// Appearance for the light/dark switch of §1. The other tabs (AI, Scribe,
// Sending, Privacy, About) arrive with what they set.

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'audio', label: 'Audio' },
  { id: 'speech', label: 'Speech' },
  { id: 'appearance', label: 'Appearance' },
]

const THEMES: { id: ThemePreference; label: string; note: string }[] = [
  {
    id: 'system',
    label: 'Same as Windows',
    note: 'Follows the light or dark mode Windows is in.',
  },
  { id: 'light', label: 'Light', note: 'Always light.' },
  { id: 'dark', label: 'Dark', note: 'Always dark.' },
]

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`

function Audio() {
  const backend = useBackend()
  const microphone = usePrefs(prefs => prefs.microphone)
  const loopback = usePrefs(prefs => prefs.loopback)
  const change = usePrefs(prefs => prefs.change)
  const devices = useQuery({
    queryKey: ['devices'],
    queryFn: () => backend.listDevices(),
    staleTime: 0,
  })

  if (devices.isPending) {
    return <p className="text-body text-text-muted">Looking for microphones…</p>
  }
  if (devices.isError) {
    return (
      <p role="alert" className="text-body">
        The audio devices could not be listed.
      </p>
    )
  }
  const { microphones, default_microphone } = devices.data
  // A saved microphone that is unplugged falls back to the default.
  const chosen =
    microphone !== null && microphones.includes(microphone) ? microphone : ''

  return (
    <div className="flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="text-secondary font-semibold">Microphone</span>
        {microphones.length === 0 ? (
          <span role="alert" className="text-body">
            No microphone found. Plug one in and open this tab again.
          </span>
        ) : (
          <select
            value={chosen}
            onChange={event =>
              change({ microphone: event.target.value || null })
            }
            className="h-7 rounded-md border bg-surface px-2 text-body outline-none focus:border-accent"
          >
            <option value="">
              Default{default_microphone ? ` (${default_microphone})` : ''}
            </option>
            {microphones.map(name => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
      </label>

      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={loopback}
          onChange={event => change({ loopback: event.target.checked })}
          className="mt-0.5 size-3.5 accent-accent"
        />
        <span>
          <span className="block text-body">
            Also record what this PC plays
          </span>
          <span className="block text-meta text-text-muted">
            For online calls: the other side is transcribed as “System audio”.
            Use headphones if you can: from speakers, some of the call can reach
            the microphone and show up a second time as “Room”.
          </span>
        </span>
      </label>
      <p className="text-meta text-text-muted">
        Changes apply to the next meeting you start.
      </p>
    </div>
  )
}

function ModelRow({
  model,
  download,
  selected,
  onSelect,
}: {
  model: ModelInfo
  download: ModelDownload | undefined
  selected: boolean
  /** Null for a model that is not chosen: it is used whenever installed. */
  onSelect: (() => void) | null
}) {
  const backend = useBackend()
  const running = (download && !download.done) || model.downloading
  const share =
    download && download.total > 0 ? download.bytes / download.total : 0

  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-start gap-3">
        {onSelect && (
          <input
            type="radio"
            name="speech-model"
            aria-label={`Use ${model.title}`}
            checked={selected}
            disabled={!model.installed}
            onChange={onSelect}
            className="mt-1 size-3.5 accent-accent"
          />
        )}
        <div className="min-w-0 flex-1">
          <h3 className="text-body font-semibold">{model.title}</h3>
          <p className="text-secondary text-text-muted">{model.languages}</p>
          <p className="font-mono text-meta text-text-muted">
            {megabytes(model.bytes)} · {model.licence}
          </p>
        </div>
        {model.installed ? (
          <span className="text-secondary text-text-muted">Installed</span>
        ) : running ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void backend.cancelDownload(model.id)}
          >
            Cancel
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void backend.downloadModel(model.id)}
          >
            {download?.error ? 'Try again' : 'Download'}
          </Button>
        )}
      </div>
      {running && (
        <div className="flex items-center gap-2">
          <div
            role="progressbar"
            aria-label={`Downloading ${model.title}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(share * 100)}
            className="h-1 flex-1 overflow-hidden rounded-full bg-surface-2"
          >
            <div
              className="h-full bg-accent"
              style={{ width: `${share * 100}%` }}
            />
          </div>
          <span className="font-mono text-meta text-text-muted">
            {megabytes(download?.bytes ?? 0)} / {megabytes(model.bytes)}
          </span>
        </div>
      )}
      {!running && download?.error && (
        <p role="alert" className="text-secondary">
          The download stopped. What arrived is kept; Try again carries on from
          there.
        </p>
      )}
    </li>
  )
}

function Speech() {
  const backend = useBackend()
  const queryClient = useQueryClient()
  const modelId = usePrefs(prefs => prefs.modelId)
  const change = usePrefs(prefs => prefs.change)
  const models = useQuery({
    queryKey: ['models'],
    queryFn: () => backend.listModels(),
    staleTime: 0,
  })
  const [downloads, setDownloads] = useState<Record<string, ModelDownload>>({})

  useEffect(
    () =>
      backend.onModelDownload(event => {
        setDownloads(known => ({ ...known, [event.model_id]: event }))
        // Installed, cancelled or failed: ask what is on disk now.
        if (event.done) {
          void queryClient.invalidateQueries({ queryKey: ['models'] })
        }
      }),
    [backend, queryClient]
  )

  if (models.isPending) {
    return <p className="text-body text-text-muted">Looking for models…</p>
  }
  if (models.isError) {
    return (
      <p role="alert" className="text-body">
        The speech models could not be listed.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body">
        Speech is transcribed on this PC. A model is downloaded once from
        Hugging Face and checked before it is used.
      </p>
      <ul aria-label="Live transcription" className="flex flex-col gap-2">
        {models.data
          .filter(model => model.live)
          .map(model => (
            <ModelRow
              key={model.id}
              model={model}
              download={downloads[model.id]}
              selected={model.id === modelId}
              onSelect={() => change({ modelId: model.id })}
            />
          ))}
      </ul>
      {models.data.some(model => !model.live) && (
        <>
          <h3 className="text-secondary font-semibold">
            Clean-up after the meeting
          </h3>
          <p className="text-secondary text-text-muted">
            Too slow to keep up live, but it hears whole sentences better. Once
            installed, it goes over every meeting&rsquo;s transcript after Stop,
            which takes several minutes; the live text is kept where it does
            better.
          </p>
          <ul aria-label="Clean-up" className="flex flex-col gap-2">
            {models.data
              .filter(model => !model.live)
              .map(model => (
                <ModelRow
                  key={model.id}
                  model={model}
                  download={downloads[model.id]}
                  selected={false}
                  onSelect={null}
                />
              ))}
          </ul>
        </>
      )}
      {models.data
        .filter(model => model.live)
        .every(model => !model.installed) && (
        <p role="status" className="text-secondary text-text-muted">
          Without a model a meeting is still recorded, with no transcript.
        </p>
      )}
    </div>
  )
}

function Appearance() {
  const preference = useTheme(theme => theme.preference)
  const choose = (next: ThemePreference) => {
    setThemePreference(next).catch((error: unknown) =>
      logger.warn('The theme was changed but could not be saved', {
        error: String(error),
      })
    )
  }

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-secondary font-semibold">Theme</legend>
      {THEMES.map(({ id, label, note }) => (
        <label key={id} className="flex items-start gap-2">
          <input
            type="radio"
            name="theme"
            checked={preference === id}
            onChange={() => choose(id)}
            className="mt-0.5 size-3.5 accent-accent"
          />
          <span>
            <span className="block text-body">{label}</span>
            <span className="block text-meta text-text-muted">{note}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

export function Settings({
  tab,
  onTab,
  onClose,
}: {
  tab: SettingsTab
  onTab: (tab: SettingsTab) => void
  onClose: () => void
}) {
  return (
    <Sheet title="Settings" onClose={onClose}>
      <div
        role="tablist"
        aria-label="Settings"
        className="flex gap-1 border-b px-3 pt-2"
      >
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={cn(
              '-mb-px h-8 border-b-2 px-2 text-body',
              tab === id
                ? 'border-accent font-semibold'
                : 'border-transparent text-text-muted'
            )}
            onClick={() => onTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="p-4">
        {tab === 'audio' ? (
          <Audio />
        ) : tab === 'speech' ? (
          <Speech />
        ) : (
          <Appearance />
        )}
      </div>
    </Sheet>
  )
}
