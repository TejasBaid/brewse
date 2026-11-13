import { formatElement } from '../browser/format'
import type { ElNode, Snapshot } from '../browser/types'
import type { Answer, Jev, Question } from './client'

// Grounding: turning a description written by Claude ("the Sign in button in the
// header") into one element. The split follows the evidence: a small model given
// an explicit description and a short candidate list is accurate, while one given
// the whole task and fifty candidates is not. So the candidates are cut to a few
// first: by shared words when the description names the control's label, and by
// Jev itself, rating every control on screen separately, when it does not ("the
// magnifying glass", "where I type the city"). Jev then picks among those few
// plus "none", and a gate decides whether the pick can be used.

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'and', 'or', 'with', 'that', 'this', 'is', 'it', 'by', 'from', 'page', 'element', 'control', 'near', 'next', 'top', 'bottom', 'left', 'right', 'first', 'main'])
const ROLE_WORDS: Record<string, string[]> = {
  button: ['button', 'btn'],
  link: ['link'],
  textbox: ['field', 'input', 'box', 'textbox', 'textarea', 'text'],
  searchbox: ['search', 'field', 'input', 'box'],
  checkbox: ['checkbox', 'check', 'tick'],
  radio: ['radio', 'option'],
  combobox: ['dropdown', 'select', 'menu', 'combobox', 'picker'],
  tab: ['tab'],
  menuitem: ['menu', 'item'],
  switch: ['switch', 'toggle'],
}

export const MAX_CANDIDATES = 5
export const NONE = 'none'

export interface GroundResult {
  /** Element chosen, when Jev named one. */
  id: number | null
  /** True when the pick passed every gate condition and may be acted on. */
  accepted: boolean
  reason: string
  candidates: ElNode[]
  margin: number
  agreement: number
  pNone: number
  pPresent: number
  ms: number
  options: number
  /** How the candidates were chosen: an exact quoted label (no model needed), shared words, or Jev rating every control. */
  via: 'label' | 'words' | 'meaning'
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w))

interface Scored {
  score: number
  /** How many words of the description are words of the control's own label. */
  hits: number
  exact: boolean
  n: ElNode
}

/** Score every element against the description by plain word overlap, best first. */
export function rank(description: string, snap: Snapshot, among?: Set<number>): Scored[] {
  const tokens = words(description)
  const quoted = Array.from(description.matchAll(/["'“]([^"'”]{2,})["'”]/g), (m) => m[1].toLowerCase())
  const scored: Scored[] = []
  for (const n of snap.nodes) {
    if (n.k !== 'e' || n.states?.includes('disabled')) continue
    if (among && !among.has(n.id)) continue
    const name = n.name.toLowerCase()
    const nameWords = new Set(words(n.name))
    const roleWords = ROLE_WORDS[n.role] ?? [n.role]
    let score = 0
    for (const t of tokens) {
      if (nameWords.has(t)) score += 3
      else if (name.includes(t)) score += 1.5
      else if (roleWords.includes(t)) score += 1.2
      else if (n.value?.toLowerCase().includes(t) || n.href?.toLowerCase().includes(t) || n.type === t) score += 1
    }
    let exact = false
    for (const q of quoted) {
      if (name === q) {
        score += 8
        exact = true
      } else if (name.includes(q)) score += 4
    }
    if (score <= 0) continue
    const hits = tokens.filter((t) => nameWords.has(t)).length
    if (n.inView) score += 0.6
    if (n.weak) score -= 0.5
    // Prefer a tight match: a short name fully covered by the description beats a long one that happens to share a word.
    score += Math.min(1.5, (3 * hits) / Math.max(1, nameWords.size))
    scored.push({ score, hits, exact, n })
  }
  return scored.sort((a, b) => b.score - a.score)
}

/**
 * How many controls Jev rates when words are not enough: the whole page, for
 * nearly every page, so that one scrolled to its foot still has its header
 * rated. They go in requests of BATCH, sent side by side, so the number costs
 * little time.
 */
export const POOL = 720
const BATCH = 240

/**
 * Shortlist by meaning: Jev rates each control on its own ("is this the one
 * described?"), all in one request, and the best few go forward. Used when the
 * description shares too few words with any label for word overlap to be trusted.
 */
async function shortlistByMeaning(jev: Jev, description: string, snap: Snapshot, lexical: Scored[], among: Set<number> | undefined, context: string | undefined): Promise<{ nodes: ElNode[]; ms: number }> {
  const pool: ElNode[] = []
  const have = new Set<number>()
  const add = (n: ElNode) => {
    if (pool.length < POOL && !have.has(n.id)) {
      have.add(n.id)
      pool.push(n)
    }
  }
  for (const s of lexical.slice(0, 12)) add(s.n)
  const rest = snap.nodes.filter((n): n is ElNode => n.k === 'e' && !n.states?.includes('disabled') && (!among || among.has(n.id)))
  // What is on screen first, then what is nearest to it.
  for (const n of rest) if (n.inView) add(n)
  for (const n of [...rest].sort((a, b) => Math.abs(a.y - snap.vh / 2) - Math.abs(b.y - snap.vh / 2))) add(n)
  if (!pool.length) return { nodes: [], ms: 0 }

  const start = Date.now()
  const rated: { n: ElNode; p: number }[] = []
  const groups: ElNode[][] = []
  for (let i = 0; i < pool.length; i += BATCH) groups.push(pool.slice(i, i + BATCH))
  await Promise.all(
    groups.map(async (group) => {
      const questions: Record<string, Question> = {}
      for (const n of group) {
        questions[`c${n.id}`] = { type: 'noul', instructions: { statement: 'This page control is the one the description refers to.', description, ...(context ? { purpose: context } : {}), control: describeOption(n, snap) } }
      }
      const res = await jev.ask({ page: { title: snap.title, url: snap.url } }, questions)
      for (const n of group) {
        const a = res.answers[`c${n.id}`]
        rated.push({ n, p: a?.type === 'noul' ? a.noul : 0 })
      }
    }),
  )
  rated.sort((a, b) => b.p - a.p)
  const res = { ms: Date.now() - start }
  if (process.env['BREWSE_JEV_DEBUG']) console.log(`[jev] "${description}" pool ${pool.length}: ${rated.slice(0, 8).map((r) => `${r.p.toFixed(2)} ${formatElement(r.n, false).slice(0, 40)}`).join(' | ')}`)
  // Anything Jev gives almost no chance is not a candidate at all.
  return { nodes: rated.filter((r, i) => r.p >= 0.05 || i === 0).slice(0, MAX_CANDIDATES).map((r) => r.n), ms: res.ms }
}

function describeOption(n: ElNode, snap: Snapshot): Record<string, unknown> {
  // The nearest heading above an element is cheap context that separates look-alikes.
  let heading = ''
  for (const h of snap.nodes) if (h.k === 'h' && h.y <= n.y) heading = h.text
  const where = n.inView ? (n.y < snap.vh / 3 ? 'upper part of the screen' : n.y > (snap.vh * 2) / 3 ? 'lower part of the screen' : 'middle of the screen') : 'not currently on screen'
  // Controls that share a role and label (six "Add to cart" buttons) are told apart by their order on the page.
  const twins = snap.nodes.filter((x): x is ElNode => x.k === 'e' && x.role === n.role && x.name === n.name && !!n.name)
  const occurrence = twins.length > 1 ? `${twins.findIndex((x) => x.id === n.id) + 1} of ${twins.length} with this label` : undefined
  return { control: formatElement(n, false).replace(/^\[\d+\]\s*/, ''), section: heading || undefined, position: where, occurrence }
}

/**
 * Ask Jev which candidate matches the description. The question is repeated once
 * per rotation of the option order, in a single request, so every option sits in
 * every position once; probabilities are averaged in log space, which cancels
 * Jev's documented bias toward earlier options.
 */
export async function ground(jev: Jev, description: string, snap: Snapshot, context?: string, opts: { among?: Set<number> } = {}): Promise<GroundResult> {
  const lexical = rank(description, snap, opts.among)
  // A quoted label that exactly one control carries needs no model at all.
  const exact = lexical.filter((x) => x.exact)
  if (exact.length === 1) {
    return { id: exact[0].n.id, accepted: true, reason: 'the only control with exactly that label', candidates: [exact[0].n], margin: 1, agreement: 1, pNone: 0, pPresent: 1, ms: 0, options: 1, via: 'label' }
  }
  // Words are enough when the description quotes a label exactly, or shares two or more words with one.
  const byWords = !!lexical[0] && (lexical[0].exact || lexical[0].hits >= 2)
  let candidates = lexical.slice(0, MAX_CANDIDATES).map((s) => s.n)
  let spent = 0
  if (!byWords) {
    const meant = await shortlistByMeaning(jev, description, snap, lexical, opts.among, context)
    candidates = meant.nodes
    spent = meant.ms
  }
  const base: GroundResult = { id: null, accepted: false, reason: '', candidates, margin: 0, agreement: 0, pNone: 1, pPresent: 0, ms: spent, options: candidates.length + 1, via: byWords ? 'words' : 'meaning' }
  if (!candidates.length) return { ...base, reason: 'no control on the page resembles that description' }

  const keys = candidates.map((n) => `e${n.id}`)
  const options: [string, unknown][] = candidates.map((n) => [`e${n.id}`, describeOption(n, snap)])
  options.push([NONE, 'None of the listed controls matches the description'])
  const rotations = Math.min(options.length, 6)
  const instructions = {
    task: 'Choose the one page control that matches the description. Choose the "none" option if no listed control matches it.',
    description,
    ...(context ? { purpose: context } : {}),
  }
  const questions: Record<string, Question> = {}
  for (let r = 0; r < rotations; r++) {
    const rotated = [...options.slice(r), ...options.slice(0, r)]
    questions[`pick${r}`] = { type: 'choice', instructions, criteria: Object.fromEntries(rotated) }
  }
  questions['present'] = { type: 'noul', instructions: { statement: 'At least one of the listed controls matches the description.', description, controls: options.slice(0, -1).map(([, v]) => v) } }

  const res = await jev.ask({ page: { title: snap.title, url: snap.url } }, questions)
  const all = [...keys, NONE]
  const logSum: Record<string, number> = Object.fromEntries(all.map((k) => [k, 0]))
  const votes: Record<string, number> = {}
  let used = 0
  for (let r = 0; r < rotations; r++) {
    const a = res.answers[`pick${r}`] as Extract<Answer, { type: 'choice' }> | undefined
    if (!a || a.type !== 'choice' || !a.probabilities) continue
    used++
    votes[a.choice] = (votes[a.choice] ?? 0) + 1
    for (const k of all) logSum[k] += Math.log(Math.max(1e-6, a.probabilities[k] ?? 0))
  }
  if (!used) return { ...base, ms: spent + res.ms, reason: 'Jev returned no usable answer' }

  const raw = all.map((k) => Math.exp(logSum[k] / used))
  const z = raw.reduce((s, v) => s + v, 0) || 1
  const q: Record<string, number> = Object.fromEntries(all.map((k, i) => [k, raw[i] / z]))

  // Links to the same destination are one choice: add their probabilities and their votes together.
  const leader = new Map<string, string>()
  for (const n of candidates) {
    if (n.role !== 'link' || !n.href) continue
    const key = `e${n.id}`
    const first = leader.get(n.href)
    if (!first) leader.set(n.href, key)
    else {
      q[first] += q[key]
      q[key] = 0
      votes[first] = (votes[first] ?? 0) + (votes[key] ?? 0)
      votes[key] = 0
    }
  }

  const ranked = [...all].sort((a, b) => q[b] - q[a])
  if (process.env['BREWSE_JEV_DEBUG']) console.log(`[jev] choice: ${ranked.map((k) => `${k} ${q[k].toFixed(2)}`).join(', ')}`)
  const top = ranked[0]
  const second = q[ranked[1]]
  const margin = q[top] - second
  const agreement = (votes[top] ?? 0) / used
  const present = res.answers['present']
  const pPresent = present?.type === 'noul' ? present.noul : 0
  const result: GroundResult = { ...base, id: top === NONE ? null : Number(top.slice(1)), margin, agreement, pNone: q[NONE], pPresent, ms: spent + res.ms }

  // Order matters. Disagreement across option orders is a veto, not proof of correctness: confident
  // wrong picks survive it, so the pick must also be probable and clearly ahead of the runner-up.
  if (top === NONE) return { ...result, reason: 'Jev judged that none of the candidates matches' }
  if (agreement < 1) return { ...result, reason: `Jev's answer changed with option order (${Math.round(agreement * 100)}% agreement)` }
  if (q[top] < GATE.top) return { ...result, reason: `Jev was not confident enough (${q[top].toFixed(2)})` }
  if (second > 0 && q[top] / second < GATE.ratio) return { ...result, reason: `Jev was not decisive between candidates (${q[top].toFixed(2)} against ${second.toFixed(2)})` }
  if (q[NONE] > GATE.none) return { ...result, reason: `Jev gave real weight to "none of these" (${q[NONE].toFixed(2)})` }
  // The yes/no companion hedges on loosely worded descriptions, so it only vetoes when it is nearly sure nothing matches.
  if (pPresent < GATE.present) return { ...result, reason: `Jev doubted that any candidate matches (${pPresent.toFixed(2)})` }
  return { ...result, accepted: true, reason: 'accepted' }
}

/**
 * Gate thresholds, tuned against jev-1.14.0. Independent measurements put Jev's
 * grounding accuracy at about 93% when its top probability is 0.9 or more over
 * hundreds of raw candidates; here it chooses among five pre-filtered ones.
 * `bench/ground.mjs` measures the outcome on live pages.
 */
export const GATE = { top: 0.7, ratio: 2.5, none: 0.25, present: 0.25 }

/** Whether two elements are the same choice for scoring purposes (same node, or same link target and label). */
export function equivalent(a: ElNode | undefined, b: ElNode | undefined): boolean {
  if (!a || !b) return false
  if (a.id === b.id) return true
  if (a.role !== b.role) return false
  if (a.href && a.href === b.href) return true
  return !!a.name && a.name === b.name && a.role === b.role && !a.href && !b.href && a.tag === b.tag && a.type === b.type
}
