import type { ElNode, Snapshot } from './types'

/** One control as one line: `[12] button "Sign in" (disabled)`. */
export function formatElement(n: ElNode, mark = true): string {
  let line = `${mark && n.isNew ? '*' : ''}[${n.id}] ${n.role}`
  if (n.type && n.role === 'textbox' && n.type !== 'text') line += `:${n.type}`
  if (n.name) line += ` "${n.name.replace(/"/g, "'")}"`
  if (n.value !== undefined) line += ` = "${n.value}"`
  if (n.states?.length) line += ` (${n.states.join(', ')})`
  if (n.href) line += ` -> ${n.href}`
  if (n.options) line += ` options: ${n.options.join(' | ')}${n.moreOptions ? ` | +${n.moreOptions} more` : ''}`
  return line
}

export interface StateOptions {
  /** 'near' keeps what is in or closest to the viewport when over budget; 'viewport' drops everything else; 'all' adds visible text. */
  mode?: 'near' | 'viewport' | 'all'
  maxChars?: number
  dialog?: string | null
  notes?: string[]
}

export function formatHeader(s: Snapshot, opts: StateOptions = {}): string {
  const bottom = Math.min(s.scrollMax, s.scrollY + s.vh)
  const parts = [`viewport ${s.scrollY}-${bottom} of ${s.scrollMax}px`]
  if (s.ready !== 'complete') parts.push('still loading')
  if (s.stats.modal) parts.push(`dialog open: "${s.stats.modal}"`)
  if (opts.dialog) parts.push(`javascript dialog waiting: ${opts.dialog}`)
  return `${s.title || '(untitled)'} | ${s.url}\n${parts.join(' | ')}`
}

/** Render a snapshot as text for the model, within a character budget. */
export function formatState(s: Snapshot, opts: StateOptions = {}): string {
  const mode = opts.mode ?? 'near'
  const budget = opts.maxChars ?? 6000
  const centre = s.vh / 2

  const entries = s.nodes.map((n, index) => {
    let line: string
    let inView: boolean
    let y: number
    if (n.k === 'e') {
      line = formatElement(n)
      inView = n.inView
      y = n.y + n.h / 2
    } else if (n.k === 'h') {
      line = `${'#'.repeat(Math.min(4, n.level))} ${n.text}`
      inView = n.inView
      y = n.y
    } else {
      line = `[frame] ${n.name || 'embedded frame'}${n.src ? ` (${n.src})` : ''}: contents not listed; use browser_look and click by x,y`
      inView = n.y < s.vh && n.y + n.h > 0
      y = n.y + n.h / 2
    }
    return { index, line, inView, distance: inView ? 0 : Math.abs(y - centre), kind: n.k }
  })

  let candidates = mode === 'viewport' ? entries.filter((e) => e.inView) : entries
  const total = candidates.reduce((sum, e) => sum + e.line.length + 1, 0)
  let omitted = 0
  if (total > budget) {
    // Keep what is in view, then what is nearest to it, and say how much was cut.
    const ranked = [...candidates].sort((a, b) => a.distance - b.distance)
    const keep = new Set<number>()
    let used = 0
    for (const e of ranked) {
      if (used + e.line.length + 1 > budget) continue
      used += e.line.length + 1
      keep.add(e.index)
    }
    omitted = candidates.length - keep.size
    candidates = candidates.filter((e) => keep.has(e.index))
  }

  const lines = [formatHeader(s, opts), ...candidates.map((e) => e.line)]
  const hidden = mode === 'viewport' ? entries.filter((e) => !e.inView && e.kind === 'e').length : 0
  if (omitted) lines.push(`… ${omitted} more lines outside this budget (scroll, raise max_chars, or use browser_find)`)
  if (hidden) lines.push(`… ${hidden} more controls outside the viewport`)
  if (s.truncated) lines.push('… page has more controls than can be listed; use browser_find')
  if (mode === 'all' && s.text) lines.push('', '--- visible text ---', s.text)
  for (const note of opts.notes ?? []) lines.push(note)
  return lines.join('\n')
}

/** Lines added (+), removed (-) or changed (~) between two snapshots of the same document. */
export function diffSnapshots(a: Snapshot, b: Snapshot, maxLines = 40): string {
  const before = new Map<number, string>()
  for (const n of a.nodes) if (n.k === 'e') before.set(n.id, formatElement(n, false))
  const out: string[] = []
  const seen = new Set<number>()
  for (const n of b.nodes) {
    if (n.k !== 'e') continue
    seen.add(n.id)
    const line = formatElement(n, false)
    const old = before.get(n.id)
    if (old === undefined) out.push(`+ ${line}`)
    else if (old !== line) out.push(`~ ${line}`)
  }
  for (const [id, line] of before) if (!seen.has(id)) out.push(`- ${line}`)
  if (b.stats.modal && b.stats.modal !== a.stats.modal) out.unshift(`! dialog opened: "${b.stats.modal}"`)
  if (!out.length) return '(no visible change to controls)'
  if (out.length > maxLines) return [...out.slice(0, maxLines), `… ${out.length - maxLines} more changes; call browser_state for the full list`].join('\n')
  return out.join('\n')
}
