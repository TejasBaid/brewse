import type { Answer, Jev } from './client'

// Sizing up a request before Claude starts. Most requests to a browser are one
// lookup, and Claude answers those just as well, and sooner, with little
// deliberation. Jev can tell which kind a request is in a fraction of a second;
// Claude would have to start thinking to find out.

export type Size = 'quick' | 'standard' | 'deep'

const CRITERIA: Record<Size, string> = {
  quick: 'One lookup, one page to read or open, or a single simple question. A couple of tool calls at most.',
  standard: 'A task with several steps on one or two sites: searching, filling a form, navigating to find one thing.',
  deep: 'Research across several sources, a comparison of several things, a long multi-part job, or making a file, document or site.',
}

/** Jev must be this sure a request is quick before Claude is told to spend less on it. Measured: no hard request passed this bar. */
export const QUICK_BAR = 0.9

export interface Sized {
  size: Size
  /** True when the request is quick with enough certainty to act on. */
  quick: boolean
  p: Record<Size, number>
  ms: number
}

export async function sizeUp(jev: Jev, request: string, before?: string): Promise<Sized> {
  const res = await jev.ask(
    {},
    {
      size: {
        type: 'choice',
        instructions: { task: 'Classify how much work this request to a browsing assistant needs.', request: request.slice(0, 1500), ...(before ? { earlier_request_in_this_conversation: before.slice(0, 300) } : {}) },
        criteria: CRITERIA,
      },
    },
    2500,
  )
  const a = res.answers['size'] as Extract<Answer, { type: 'choice' }> | undefined
  if (!a || a.type !== 'choice') throw new Error('no answer')
  const p = { quick: a.probabilities?.['quick'] ?? 0, standard: a.probabilities?.['standard'] ?? 0, deep: a.probabilities?.['deep'] ?? 0 }
  const size = (['quick', 'standard', 'deep'] as Size[]).sort((x, y) => p[y] - p[x])[0]
  return { size, quick: size === 'quick' && p.quick >= QUICK_BAR, p, ms: res.ms }
}
