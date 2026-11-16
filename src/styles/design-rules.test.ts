// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The UI brief (CLAUDE.md, docs/UI_SPEC.md §1) as checks on the source:
// token colours only, no shadows, gradients or blur, fades only.

const SRC = fileURLToPath(new URL('..', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(tsx?|css)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : []
  })
}

const files = sourceFiles(SRC).map(path => ({
  name: relative(SRC, path).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}))

function offenders(pattern: RegExp, skip: (name: string) => boolean) {
  return files
    .filter(file => !skip(file.name))
    .flatMap(file =>
      [...file.text.matchAll(pattern)].map(match => `${file.name}: ${match[0]}`)
    )
}

const never = () => false

describe('design rules', () => {
  it('keeps colour literals in tokens.css', () => {
    const colour = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\(/g
    expect(offenders(colour, name => name === 'styles/tokens.css')).toEqual([])
  })

  it('uses no shadows, gradients or blur', () => {
    const effect =
      /\b(?:shadow|drop-shadow|backdrop-blur|blur|bg-gradient-to|bg-linear-to|bg-radial|bg-conic)-[\w[]|\b(?:box-shadow|text-shadow|backdrop-filter)\s*:|\b(?:linear|radial|conic)-gradient\(/g
    // app.css resets Tailwind's --shadow-* and --blur-* theme keys.
    expect(offenders(effect, never)).toEqual([])
  })

  it('animates opacity only, never position or size', () => {
    const motion =
      /\b(?:animate-(?:bounce|spin|ping|pulse)|transition-(?:all|transform)|slide-in|slide-out|zoom-in|zoom-out)\b/g
    expect(offenders(motion, never)).toEqual([])
  })

  it('uses our token names, not shadcn/ui semantic colours', () => {
    // `text-secondary` is our type-scale step and `text-text-muted` our
    // colour, so `secondary` and `muted` are only flagged as fills and borders.
    const shadcn =
      /\b(?:bg|text|border|ring|outline|fill|stroke)-(?:background|foreground|primary|destructive|popover|card|input|ring|sidebar)\b|\b(?:bg|border)-(?:muted|secondary)\b|-foreground\b/g
    expect(offenders(shadcn, never)).toEqual([])
  })

  it('uses the two weights in the spec', () => {
    const weight =
      /\bfont-(?:thin|extralight|light|medium|bold|extrabold|black)\b/g
    expect(offenders(weight, never)).toEqual([])
  })
})
