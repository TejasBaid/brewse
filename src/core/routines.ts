import { createHash } from 'node:crypto'
import type { Action } from './browser/types'
import type { Engine, RecordedStep, Session } from './engine'
import type { Store } from './store'

interface RoutineRow {
  name: string
  description: string
  profile: string
  steps: string
  params: string
  runs: number
  failures: number
  last_run: number | null
  every_minutes: number | null
  next_run: number | null
  last_result: string | null
  last_hash: string | null
}

interface ToolArgs {
  op: 'list' | 'run' | 'save' | 'delete' | 'show'
  name?: string
  description?: string
  last_n?: number
  params?: Record<string, string>
  every_minutes?: number
}

const ELEMENT_OPS = new Set(['click', 'type', 'select', 'hover'])

/**
 * Saved routines. A routine is the list of actions that completed a task, each
 * with a description of its element. Replay needs no model while the site is
 * unchanged; when an element has moved, Jev re-grounds that one step; when that
 * fails too, the caller gets the page back with the step that needs attention.
 */
export class Routines {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private engine: Engine,
    private store: Store,
    private notify: (event: { name: string; ok: boolean; changed: boolean; summary: string }) => void = () => {},
  ) {}

  private get(name: string): RoutineRow | undefined {
    return this.store.db.prepare('SELECT * FROM routines WHERE name = ?').get(name) as RoutineRow | undefined
  }

  list(): RoutineRow[] {
    return this.store.db.prepare('SELECT * FROM routines ORDER BY last_run DESC, created DESC').all() as unknown as RoutineRow[]
  }

  async tool(s: Session, args: ToolArgs): Promise<{ text: string; ok: boolean; byJev?: boolean }> {
    if (args.op === 'list') {
      const rows = this.list()
      if (!rows.length) return { ok: true, text: 'no saved routines yet; after a task succeeds, save it with op "save"' }
      return {
        ok: true,
        text: rows
          .map((r) => {
            const params = JSON.parse(r.params) as string[]
            const schedule = r.every_minutes ? `, every ${r.every_minutes} min` : ''
            return `${r.name}${params.length ? `(${params.join(', ')})` : ''}: ${r.description || 'no description'} [${JSON.parse(r.steps).length} steps, ran ${r.runs}x, failed ${r.failures}x${schedule}]`
          })
          .join('\n'),
      }
    }
    if (!args.name) return { ok: false, text: 'a routine name is required' }
    if (args.op === 'delete') {
      this.store.db.prepare('DELETE FROM routines WHERE name = ?').run(args.name)
      return { ok: true, text: `deleted routine "${args.name}"` }
    }
    if (args.op === 'show') {
      const row = this.get(args.name)
      if (!row) return { ok: false, text: `no routine named "${args.name}"` }
      const steps = JSON.parse(row.steps) as RecordedStep[]
      return { ok: true, text: steps.map((st, i) => `${i + 1}. ${JSON.stringify(st.action)}`).join('\n') + (row.last_result ? `\n\nlast result:\n${row.last_result}` : '') }
    }
    if (args.op === 'save') return this.save(s, args)
    return this.run(s, args.name, args.params ?? {})
  }

  private save(s: Session, args: ToolArgs): { text: string; ok: boolean } {
    let steps = s.log
    if (args.last_n) steps = steps.slice(-args.last_n)
    if (!steps.length) return { ok: false, text: 'nothing to save: no successful actions have been recorded in this session' }
    // Typed literals become named parameters so the routine can be reused with other values.
    const params = args.params ?? {}
    const names = Object.keys(params)
    const stored = steps.map((st) => {
      const action = { ...st.action }
      for (const key of ['text', 'value', 'url'] as const) {
        let v = action[key]
        if (typeof v !== 'string') continue
        for (const name of names) if (params[name]) v = v.split(params[name]).join(`{{${name}}}`)
        action[key] = v
      }
      return { ...st, action }
    })
    const every = args.every_minutes && args.every_minutes > 0 ? Math.max(5, args.every_minutes) : null
    this.store.db
      .prepare(
        `INSERT INTO routines (name, description, profile, steps, params, created, every_minutes, next_run) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET description = excluded.description, profile = excluded.profile, steps = excluded.steps, params = excluded.params,
           every_minutes = excluded.every_minutes, next_run = excluded.next_run`,
      )
      .run(args.name!, args.description ?? '', s.profile, JSON.stringify(stored), JSON.stringify(names), Date.now(), every, every ? Date.now() + every * 60_000 : null)
    return { ok: true, text: `saved routine "${args.name}" with ${stored.length} steps${names.length ? ` and parameters ${names.join(', ')}` : ''}${every ? `, scheduled every ${every} minutes` : ''}` }
  }

  async run(s: Session, name: string, params: Record<string, string>): Promise<{ text: string; ok: boolean; byJev: boolean }> {
    const row = this.get(name)
    if (!row) return { ok: false, byJev: false, text: `no routine named "${name}"; use op "list"` }
    const steps = JSON.parse(row.steps) as RecordedStep[]
    const missing = (JSON.parse(row.params) as string[]).filter((p) => params[p] === undefined)
    if (missing.length) return { ok: false, byJev: false, text: `routine "${name}" needs parameters: ${missing.join(', ')}` }
    const fill = (v: unknown) => (typeof v === 'string' ? v.replace(/\{\{(\w+)\}\}/g, (_m, k) => params[k] ?? '') : v)

    const lines: string[] = []
    let byJev = false
    let ok = true
    // Re-grounding inside a routine is allowed for reversible steps: each one is guarded by its recorded outcome.
    const previousMode = s.mode
    s.mode = 'fast'
    try {
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i]
        const action: Action = { ...st.action, text: fill(st.action.text) as string | undefined, value: fill(st.action.value) as string | undefined, url: fill(st.action.url) as string | undefined }
        let how = 'direct'
        if (ELEMENT_OPS.has(action.op) && action.x == null) {
          const id = st.fingerprint ? await this.engine.locate(s, st.fingerprint) : null
          if (id != null) {
            action.id = id
            how = 'saved description'
          } else {
            action.target ??= [st.fingerprint?.role, st.fingerprint?.name ? `"${st.fingerprint.name}"` : ''].filter(Boolean).join(' ')
            how = 'Jev'
          }
        }
        const r = await this.engine.act(s, { actions: [action], observe: 'none' })
        const receipt = r.receipts[0]
        byJev ||= r.byJev
        const drifted = r.ok && st.effect === 'navigated' && receipt?.effect === 'none'
        if (!r.ok || drifted) {
          ok = false
          lines.push(`${i + 1}. STOPPED (${how}): ${drifted ? 'the step no longer leads to a new page, so the site has probably changed' : r.text.split('\n')[0]}`)
          lines.push(`Steps ${i + 1}-${steps.length} of "${name}" were not completed. Continue by hand from step ${i + 1}: ${JSON.stringify(action)}`)
          break
        }
        lines.push(`${i + 1}. ok (${how}): ${receipt?.line ?? action.op}`)
      }
    } finally {
      s.mode = previousMode
    }
    this.store.db.prepare('UPDATE routines SET runs = runs + 1, failures = failures + ?, last_run = ? WHERE name = ?').run(ok ? 0 : 1, Date.now(), name)
    const state = await this.engine.state(s, { max_chars: 2500 }).catch(() => '')
    return { ok, byJev, text: `${lines.join('\n')}\n\n${state}` }
  }

  /** Run due scheduled routines once a minute, each in its own background tab, and note whether the result changed. */
  startScheduler(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), 60_000)
  }

  private running = false
  private async tick(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const due = this.store.db.prepare('SELECT * FROM routines WHERE every_minutes IS NOT NULL AND next_run <= ?').all(Date.now()) as unknown as RoutineRow[]
      for (const row of due) {
        this.store.db.prepare('UPDATE routines SET next_run = ? WHERE name = ?').run(Date.now() + row.every_minutes! * 60_000, row.name)
        const s = this.engine.open('app', `sched-${Date.now().toString(36)}`, 'fast')
        s.profile = row.profile
        try {
          const r = await this.run(s, row.name, {})
          const text = r.ok ? await this.engine.read(s, { max_chars: 2000 }).then((x) => x.text, () => '') : r.text
          const hash = createHash('sha1').update(text).digest('hex')
          const changed = r.ok && row.last_hash !== null && row.last_hash !== hash
          this.store.db.prepare('UPDATE routines SET last_result = ?, last_hash = ? WHERE name = ?').run(text.slice(0, 4000), r.ok ? hash : row.last_hash, row.name)
          this.notify({ name: row.name, ok: r.ok, changed, summary: text.slice(0, 300) })
        } catch (e) {
          this.notify({ name: row.name, ok: false, changed: false, summary: (e as Error).message })
        } finally {
          await this.engine.close(s.id)
        }
      }
    } finally {
      this.running = false
    }
  }
}
