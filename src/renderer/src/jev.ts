import type { JevShare } from '../../shared/protocol'

const count = (n: number, one: string, many: string) => `${n === 1 ? one : many.replace('#', String(n))}`

/** Jev's part in a request, as one plain sentence. */
export function jevLine(j: JevShare): string {
  const did: string[] = []
  if (j.size === 'quick') did.push('judged this a quick lookup')
  else if (j.size === 'deep') did.push('judged this a long job')
  if (j.reads) did.push(`${count(j.reads, 'read a page', 'read # pages')} and kept ${j.spared >= 1000 ? `${Math.round(j.spared / 1000)}k` : j.spared} characters from Claude`)
  if (j.grounded) did.push(count(j.grounded, 'found a control', 'found # controls'))
  if (j.cleared) did.push(count(j.cleared, 'closed a notice', 'closed # notices'))
  if (j.checks) did.push(count(j.checks, 'checked a statement', 'checked # statements'))
  if (!did.length) did.push(count(j.decisions, 'made one judgment', 'made # judgments'))
  return `${did.join(', ')}. ${(j.ms / 1000).toFixed(1)}s`
}
