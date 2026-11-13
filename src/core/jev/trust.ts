import type { EffortMode } from '../../shared/protocol'
import type { Store } from '../store'

// Jev earns the right to act, per site and kind of step, from evidence gathered
// in shadow mode: whenever Claude acts on an element it has described, Jev is
// asked the same question in the background, and its gated pick is compared with
// what Claude did. Autonomy is granted by Wald's sequential probability ratio
// test between "miss rate is 1%" and "miss rate is 5%" at 5% error either way:
// about 72 clean observations in a row, with each miss costing about 39 more.

const P0 = 0.01
const P1 = 0.05
const CLEAN = Math.log((1 - P1) / (1 - P0)) // about -0.041 per agreement
const MISS = Math.log(P1 / P0) // about +1.61 per miss
const GRANT = Math.log(0.05 / 0.95) // about -2.94
const REJECT = Math.log(0.95 / 0.05)
const MIN_REAL = 30
const PRIOR_CAP = 20

export type StepKind = 'click' | 'type' | 'select'

interface Row {
  site: string
  kind: string
  shadow_n: number
  shadow_miss: number
  auto_n: number
  auto_fail: number
  llr: number
  granted: number
}

export class Trust {
  constructor(private store: Store) {}

  private row(site: string, kind: string): Row {
    const found = this.store.db.prepare('SELECT * FROM scorecard WHERE site = ? AND kind = ?').get(site, kind) as Row | undefined
    if (found) return found
    // A new site starts from what Jev has shown across all sites for this kind of step, capped.
    const pooled = site === '*' ? undefined : (this.store.db.prepare('SELECT * FROM scorecard WHERE site = ? AND kind = ?').get('*', kind) as Row | undefined)
    const prior = pooled && pooled.granted ? Math.max(pooled.llr, PRIOR_CAP * CLEAN) : 0
    return { site, kind, shadow_n: 0, shadow_miss: 0, auto_n: 0, auto_fail: 0, llr: prior, granted: 0 }
  }

  private save(r: Row): void {
    this.store.db
      .prepare(
        `INSERT INTO scorecard (site, kind, shadow_n, shadow_miss, auto_n, auto_fail, llr, granted, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(site, kind) DO UPDATE SET shadow_n = excluded.shadow_n, shadow_miss = excluded.shadow_miss, auto_n = excluded.auto_n,
           auto_fail = excluded.auto_fail, llr = excluded.llr, granted = excluded.granted, updated = excluded.updated`,
      )
      .run(r.site, r.kind, r.shadow_n, r.shadow_miss, r.auto_n, r.auto_fail, r.llr, r.granted, Date.now())
  }

  private observe(site: string, kind: string, clean: boolean): void {
    const r = this.row(site, kind)
    r.shadow_n++
    if (!clean) r.shadow_miss++
    r.llr += clean ? CLEAN : MISS
    if (r.llr >= REJECT) r.llr = 0 // evidence says "not reliable here": start the test over
    if (!r.granted && r.llr <= GRANT && r.shadow_n >= MIN_REAL) r.granted = 1
    this.save(r)
  }

  /** Record a shadow comparison on a step that Claude carried out successfully. */
  shadow(site: string, kind: StepKind, agreed: boolean): void {
    this.observe(site, kind, agreed)
    this.observe('*', kind, agreed)
  }

  /** Record the outcome of an action Jev was allowed to ground. A verified failure revokes autonomy at once. */
  outcome(site: string, kind: StepKind, ok: boolean): void {
    const r = this.row(site, kind)
    r.auto_n++
    if (!ok) {
      r.auto_fail++
      r.granted = 0
      r.llr = 0
    }
    this.save(r)
  }

  granted(site: string, kind: StepKind): boolean {
    return !!this.row(site, kind).granted
  }

  /**
   * May a gate-accepted Jev pick be acted on?
   *   thorough  never; Jev only shadows
   *   balanced  only where autonomy has been earned
   *   auto      any reversible step: a wrong one can be undone, and the receipt
   *             names the control that was used, so Claude sees a miss at once
   *   fast      the same, without shadow scoring
   * Irreversible steps always go back to Claude.
   */
  mayAct(mode: EffortMode, site: string, kind: StepKind, step: { reversible: boolean; checked: boolean }): { allow: boolean; why: string } {
    if (!step.reversible) return { allow: false, why: 'step may not be reversible' }
    if (mode === 'thorough') return { allow: false, why: 'thorough mode keeps every step with Claude' }
    if (this.granted(site, kind)) return { allow: true, why: 'earned on this site' }
    if (mode === 'fast' || mode === 'auto') return { allow: true, why: step.checked ? 'reversible and checked' : 'reversible' }
    return { allow: false, why: `Jev has not yet earned ${kind} steps on ${site}` }
  }

  summary(): { site: string; kind: string; shadow_n: number; shadow_miss: number; auto_n: number; auto_fail: number; granted: number; progress: number }[] {
    const rows = this.store.db.prepare('SELECT * FROM scorecard ORDER BY shadow_n DESC LIMIT 100').all() as unknown as Row[]
    return rows.map((r) => ({ ...r, progress: Math.max(0, Math.min(1, r.llr / GRANT)) }))
  }
}
