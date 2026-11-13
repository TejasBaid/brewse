import type { DatabaseSync } from 'node:sqlite'
import type { AgentEvent, TaskItem, TaskRecord, TaskSummary } from '../shared/protocol'

// Every task and page conversation is kept: what was asked, what was done and
// what came of it. The interface shows them on the Tasks page, and a task that
// was closed, or left over from an earlier day, can be opened and carried on.
//
// The record is built here, in the core, from the same events the interface is
// sent, so it does not depend on a window being open.

interface Live extends TaskRecord {
  claudeSession?: string
  timer?: ReturnType<typeof setTimeout>
}

/** How much of a step's raw result is kept. The full text is only of use while the task runs. */
const DETAIL_KEPT = 600

/** The answer's opening statement, as a line to show in a list. */
export function headlineOf(items: TaskItem[]): string {
  let start = 0
  items.forEach((item, i) => {
    if (item.kind === 'user') start = i
  })
  const turn = items.slice(start)
  const failure = turn.find((i) => i.kind === 'error')
  // The answer is what was said after the last thing done; a remark made along the way is not the outcome.
  let lastStep = -1
  turn.forEach((item, i) => {
    if (item.kind === 'step') lastStep = i
  })
  const closing = turn.slice(lastStep + 1).filter((i) => i.kind === 'text')
  const answer = (closing.length ? closing : turn.filter((i) => i.kind === 'text'))
    .map((i) => (i.kind === 'text' ? i.text : ''))
    .join('\n\n')
    .trim()
  if (!answer) return failure && failure.kind === 'error' ? failure.text.slice(0, 200) : ''
  const first = answer.split(/\n\s*\n/)[0] ?? ''
  const plain = first
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 220 ? `${plain.slice(0, 217)}…` : plain
}

export class Tasks {
  private live = new Map<string, Live>()

  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, mode TEXT NOT NULL,
        created INTEGER NOT NULL, at INTEGER NOT NULL, headline TEXT NOT NULL DEFAULT '',
        steps INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0,
        page_url TEXT, claude_session TEXT, items TEXT NOT NULL DEFAULT '[]', workers TEXT NOT NULL DEFAULT '[]');
    `)
    // Anything that was still going when Brewse last closed did not finish.
    db.prepare("UPDATE tasks SET status = 'stopped' WHERE status IN ('running', 'waiting')").run()
  }

  private row(id: string): Live | undefined {
    const live = this.live.get(id)
    if (live) return live
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
    if (!r) return undefined
    const task: Live = {
      id: String(r['id']),
      title: String(r['title']),
      status: r['status'] as Live['status'],
      mode: r['mode'] as Live['mode'],
      created: Number(r['created']),
      at: Number(r['at']),
      headline: String(r['headline']),
      steps: Number(r['steps']),
      ms: Number(r['ms']),
      pageUrl: (r['page_url'] as string | null) ?? undefined,
      claudeSession: (r['claude_session'] as string | null) ?? undefined,
      items: JSON.parse(String(r['items'])) as TaskItem[],
      workers: JSON.parse(String(r['workers'])) as Live['workers'],
    }
    return task
  }

  private save(task: Live): void {
    if (task.timer) clearTimeout(task.timer)
    task.timer = undefined
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, status, mode, created, at, headline, steps, ms, page_url, claude_session, items, workers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, mode = excluded.mode, at = excluded.at, headline = excluded.headline,
           steps = excluded.steps, ms = excluded.ms, page_url = excluded.page_url, claude_session = excluded.claude_session, items = excluded.items, workers = excluded.workers`,
      )
      .run(task.id, task.title, task.status, task.mode, task.created, task.at, task.headline, task.steps, task.ms, task.pageUrl ?? null, task.claudeSession ?? null, JSON.stringify(task.items), JSON.stringify(task.workers))
  }

  private touch(task: Live, now = false): void {
    if (task.timer) clearTimeout(task.timer)
    if (now) return this.save(task)
    task.timer = setTimeout(() => this.save(task), 500)
  }

  /** Take in one event from a running task. */
  record(e: AgentEvent): void {
    let task = this.live.get(e.session) ?? this.row(e.session)
    if (!task) {
      if (e.type !== 'session') return
      const now = Date.now()
      task = { id: e.session, title: e.title, status: e.status, mode: e.mode, created: now, at: now, headline: '', steps: 0, ms: 0, items: [], workers: [] }
    }
    this.live.set(e.session, task)
    const items = task.items
    switch (e.type) {
      case 'session':
        task.status = e.status
        task.mode = e.mode
        if (e.title && !task.title) task.title = e.title
        break
      case 'user':
        task.status = 'running'
        task.at = Date.now()
        items.push({ kind: 'user', text: e.text })
        break
      case 'text':
      case 'thinking': {
        const last = items[items.length - 1]
        if (last && last.kind === e.type && last.id === e.id) last.text += e.delta
        else items.push({ kind: e.type, id: e.id, text: e.delta })
        break
      }
      case 'step': {
        const existing = items.find((i) => i.kind === 'step' && i.id === e.id)
        const detail = e.detail?.slice(0, DETAIL_KEPT)
        if (existing && existing.kind === 'step') Object.assign(existing, { status: e.status, summary: e.summary || existing.summary, detail: detail ?? existing.detail, by: e.by ?? existing.by, worker: e.worker ?? existing.worker })
        else items.push({ kind: 'step', id: e.id, tool: e.tool, summary: e.summary, status: e.status, detail, by: e.by, worker: e.worker })
        break
      }
      case 'worker': {
        const w = task.workers.find((x) => x.id === e.worker)
        if (w) Object.assign(w, { status: e.status, label: e.label ?? w.label })
        else task.workers.push({ id: e.worker, label: e.label, status: e.status })
        break
      }
      case 'approval':
        task.status = 'waiting'
        items.push({ kind: 'approval', id: e.id, summary: e.summary, detail: e.detail })
        break
      case 'done':
        task.status = e.ok ? 'done' : 'error'
        task.at = Date.now()
        task.ms = e.ms
        items.push({ kind: 'result', ok: e.ok, ms: e.ms, cost: e.cost, jev: e.jev })
        // Whatever was still marked as under way is not, now.
        for (const i of items) if (i.kind === 'step' && i.status === 'run') i.status = 'error'
        for (const w of task.workers) w.status = 'done'
        break
      case 'error':
        items.push({ kind: 'error', text: e.message })
        break
      case 'files':
        // One list per task: the latest replaces what was listed before.
        task.items = task.items.filter((i) => i.kind !== 'files')
        task.items.push({ kind: 'files', folder: e.folder, files: e.files })
        break
      case 'attach':
        break
    }
    task.steps = task.items.filter((i) => i.kind === 'step').length
    task.headline = headlineOf(task.items)
    this.touch(task, e.type === 'done' || e.type === 'session')
  }

  answered(session: string, approval: string, allow: boolean): void {
    const task = this.live.get(session)
    const item = task?.items.find((i) => i.kind === 'approval' && i.id === approval)
    if (!task || !item || item.kind !== 'approval') return
    item.answered = allow ? 'allow' : 'deny'
    task.status = 'running'
    this.touch(task)
  }

  /** The page a conversation belongs to, when it was asked on one. */
  setPage(session: string, url: string): void {
    const task = this.live.get(session) ?? this.row(session)
    if (!task || task.pageUrl === url) return
    this.live.set(session, task)
    task.pageUrl = url
    this.touch(task)
  }

  setClaudeSession(session: string, claudeSession: string): void {
    const task = this.live.get(session) ?? this.row(session)
    if (!task || task.claudeSession === claudeSession) return
    this.live.set(session, task)
    task.claudeSession = claudeSession
    this.touch(task)
  }

  claudeSession(session: string): string | undefined {
    return this.row(session)?.claudeSession
  }

  /** Every task, newest first, without what was said and done in it. */
  list(limit = 400): TaskSummary[] {
    for (const task of this.live.values()) if (task.timer) this.save(task)
    const rows = this.db.prepare('SELECT id, title, status, mode, created, at, headline, steps, ms, page_url FROM tasks ORDER BY at DESC LIMIT ?').all(limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r['id']),
      title: String(r['title']),
      status: r['status'] as TaskSummary['status'],
      mode: r['mode'] as TaskSummary['mode'],
      created: Number(r['created']),
      at: Number(r['at']),
      headline: String(r['headline']),
      steps: Number(r['steps']),
      ms: Number(r['ms']),
      pageUrl: (r['page_url'] as string | null) ?? undefined,
    }))
  }

  get(id: string): TaskRecord | undefined {
    const task = this.row(id)
    if (!task) return undefined
    const { claudeSession: _c, timer: _t, ...record } = task
    return record
  }

  /** What was said so far, for carrying a conversation on when its original session cannot be resumed. */
  transcript(id: string, maxChars = 6000): string {
    const lines: string[] = []
    for (const item of this.row(id)?.items ?? []) {
      if (item.kind === 'user') lines.push(`User: ${item.text}`)
      else if (item.kind === 'text') lines.push(`You: ${item.text}`)
    }
    return lines.join('\n\n').slice(-maxChars)
  }

  remove(id: string): void {
    const task = this.live.get(id)
    if (task?.timer) clearTimeout(task.timer)
    this.live.delete(id)
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id)
  }

  /** Forget every task that is not running. */
  clear(): void {
    for (const [id, task] of this.live) {
      if (task.status === 'running' || task.status === 'waiting') continue
      if (task.timer) clearTimeout(task.timer)
      this.live.delete(id)
    }
    this.db.prepare("DELETE FROM tasks WHERE status NOT IN ('running', 'waiting')").run()
  }
}
