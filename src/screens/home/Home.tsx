import { Button } from '@/components/ui/button'

// Home, docs/UI_SPEC.md §3.1. Left: New meeting, then the meetings list and
// search. Right: the selected meeting's summary preview. There is no meeting
// store before M2, so M0 renders the empty state only.
export function Home() {
  return (
    <main className="flex h-full bg-bg">
      <section
        aria-labelledby="home-title"
        className="flex w-[360px] shrink-0 flex-col gap-3 border-r bg-surface p-4"
      >
        <div className="flex items-center justify-between gap-3">
          <h1 id="home-title" className="text-title font-semibold">
            Meetings
          </h1>
          {/* Opens the pre-meeting sheet once that exists (docs/NOTES.md). */}
          <Button>New meeting</Button>
        </div>
        <p className="text-body text-text-muted">
          No meetings yet. Start one and Scribe keeps the notes.
        </p>
      </section>
      <section aria-label="Summary preview" className="min-w-0 flex-1" />
    </main>
  )
}
