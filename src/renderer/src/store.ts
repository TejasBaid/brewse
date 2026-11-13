import { batch, createSignal } from 'solid-js'
import { createStore, produce } from 'solid-js/store'
import type { AgentEvent, AgentStatus, EffortMode, Layout, TabsState, TaskItem, TaskRecord, TaskSummary, TaskWorker } from '../../shared/protocol'
import { bridge, core } from './bridge'

// State shared by the interface. There are two interface layers (the window
// itself, and the layer above the page that holds the command bar and the
// dock); each runs this module separately and both are fed the same events, so
// they agree on what the tabs and tasks are.

// ---- tabs and layout ---------------------------------------------------------

export const [tabs, setTabs] = createStore<TabsState>({ tabs: [], activeId: null })
export const [layout, setLayout] = createSignal<Layout>({ sidebar: 248, panel: 0, sidebarVisible: false, mode: 'browse', peek: null, peeks: [], tiles: [], frame: false })

export const activeTab = () => tabs.tabs.find((t) => t.id === tabs.activeId)

export function initShell(): void {
  bridge.on('tabs:state', (s: TabsState) => setTabs(s))
  bridge.on('layout', (l: Layout) => setLayout(l))
  void bridge.invoke<TabsState>('tabs:state').then(setTabs)
  void bridge.invoke<Layout>('layout:get').then(setLayout)
}

// ---- tasks -------------------------------------------------------------------

export type Item = TaskItem
export type Worker = TaskWorker

/** A task: something the user asked Brewse to do, with everything said and done for it. */
export interface Session {
  id: string
  title: string
  status: AgentStatus
  mode: EffortMode
  items: Item[]
  /** Finished, and its outcome has not been looked at yet. */
  unread?: boolean
  /** When it last finished. */
  at?: number
  /** A tab of the user's that this task is working on (a question about that page). */
  attached?: string
  /** Sub-agents working on parts of the task side by side, each in its own tab. */
  workers?: Worker[]
  /** Open: it has a word in the top row. A task that is closed is put away, not lost; it stays on the Tasks page. */
  open?: boolean
  /** False for a task from an earlier day whose record has not been read from disk yet. */
  loaded?: boolean
  /** When it was first asked. */
  created?: number
  /** The opening statement of its latest answer, as it is kept with the task. */
  headline?: string
  /** The page it was asked on, for a conversation that belongs to a page. */
  pageUrl?: string
}

/** Where a request goes: on with the conversation in view, to the page in view, or into a task of its own. */
export type Scope = 'continue' | 'page' | 'task'

export const [sessions, setSessions] = createStore<{ list: Session[]; current: string | null }>({ list: [], current: null })
export const [mode, setMode] = createSignal<EffortMode>('auto')
export const [panelView, setPanelView] = createSignal<'agent' | 'settings'>('agent')
/** Bumped to ask whichever composer is on screen to take the keyboard. */
export const [composerFocus, setComposerFocus] = createSignal(0)

export const currentSession = () => sessions.list.find((s) => s.id === sessions.current)

function withSession(id: string, fn: (s: Session) => void): void {
  setSessions(
    produce((state) => {
      const s = state.list.find((x) => x.id === id)
      if (s) fn(s)
    }),
  )
}

export function initAgent(): void {
  bridge.on('app:seen', ({ id }: { id: string }) => withSession(id, (s) => (s.unread = false)))
  bridge.on('app:open-thread', ({ id }: { id: string }) => {
    setSessions('current', id)
    withSession(id, (s) => (s.unread = false))
  })
  bridge.on('app:open-task', ({ id }: { id: string }) => {
    setSessions('current', id)
    withSession(id, (s) => (s.unread = false))
  })
  bridge.on('core:agent', (e: AgentEvent) => {
    batch(() => {
      switch (e.type) {
        case 'session':
          setSessions(
            produce((state) => {
              const existing = state.list.find((s) => s.id === e.session)
              if (existing) {
                existing.status = e.status
                existing.title = e.title || existing.title
              } else {
                state.list.unshift({ id: e.session, title: e.title, status: e.status, mode: e.mode, items: [], open: true, loaded: true, created: Date.now(), at: Date.now() })
                // A task that has just started is the one to look at, whichever part of the interface started it.
                if (e.status === 'running') state.current = e.session
              }
            }),
          )
          break
        case 'user':
          withSession(e.session, (s) => {
            s.status = 'running'
            s.unread = false
            s.at = Date.now()
            s.items.push({ kind: 'user', text: e.text })
          })
          break
        case 'attach':
          withSession(e.session, (s) => {
            s.attached = e.tab
            s.pageUrl = tabs.tabs.find((t) => t.id === e.tab)?.url
          })
          break
        case 'text':
        case 'thinking':
          withSession(e.session, (s) => {
            const last = s.items[s.items.length - 1]
            if (last && last.kind === e.type && last.id === e.id) last.text += e.delta
            else s.items.push({ kind: e.type, id: e.id, text: e.delta })
          })
          break
        case 'step':
          withSession(e.session, (s) => {
            const existing = s.items.find((i) => i.kind === 'step' && i.id === e.id)
            if (existing && existing.kind === 'step') Object.assign(existing, { status: e.status, summary: e.summary || existing.summary, detail: e.detail ?? existing.detail, by: e.by ?? existing.by, worker: e.worker ?? existing.worker, tab: e.tab ?? existing.tab })
            else s.items.push({ kind: 'step', id: e.id, tool: e.tool, summary: e.summary, status: e.status, detail: e.detail, by: e.by, worker: e.worker, tab: e.tab })
          })
          break
        case 'files':
          withSession(e.session, (s) => {
            s.items = s.items.filter((i) => i.kind !== 'files')
            s.items.push({ kind: 'files', folder: e.folder, files: e.files })
          })
          break
        case 'worker':
          withSession(e.session, (s) => {
            s.workers ??= []
            const w = s.workers.find((x) => x.id === e.worker)
            if (w) Object.assign(w, { status: e.status, label: e.label ?? w.label })
            else s.workers.push({ id: e.worker, label: e.label, status: e.status })
          })
          break
        case 'approval':
          withSession(e.session, (s) => {
            s.status = 'waiting'
            s.items.push({ kind: 'approval', id: e.id, summary: e.summary, detail: e.detail })
          })
          break
        case 'done':
          withSession(e.session, (s) => {
            s.status = e.ok ? 'done' : 'error'
            s.at = Date.now()
            s.unread = true
            s.items.push({ kind: 'result', ok: e.ok, ms: e.ms, cost: e.cost, jev: e.jev })
          })
          break
        case 'error':
          withSession(e.session, (s) => {
            s.status = 'error'
            s.items.push({ kind: 'error', text: e.message })
          })
          break
      }
    })
  })
}

/**
 * The conversation that belongs to a tab. For a page of yours it is what you
 * have asked on that page; for a page a task opened it is that task.
 */
export function threadFor(tabId: string | null | undefined): Session | undefined {
  const tab = tabs.tabs.find((t) => t.id === tabId)
  if (!tab) return undefined
  if (tab.owner === 'agent') return sessions.list.find((s) => s.id === tab.session)
  return sessions.list.find((s) => s.attached === tab.id)
}

/** A page conversation whose page is still open. It lives with that tab, not among the tasks. */
export const isPageThread = (s: Session) => !!s.attached && tabs.tabs.some((t) => t.id === s.attached)

/**
 * Ask Brewse for something. Returns the session it runs in, or null if it could not be started.
 *   continue  goes on with the conversation being looked at
 *   page      belongs to the page in view: one conversation per tab, picked up again each time
 *   task      a task of its own, with its own pages
 */
export async function ask(prompt: string, opts: { scope?: Scope } = {}): Promise<string | null> {
  const text = prompt.trim()
  if (!text) return null
  const scope = opts.scope ?? 'continue'
  let target: Session | undefined
  let attach: string | null = null
  if (scope === 'continue') {
    target = currentSession()
    if (target?.attached && tabs.tabs.some((t) => t.id === target!.attached)) attach = target.attached
  } else if (scope === 'page') {
    const tab = activeTab()
    target = threadFor(tab?.id)
    if (tab?.owner === 'user') attach = tab.id
  }
  // One request at a time in a conversation.
  if (target?.status === 'running' || target?.status === 'waiting') return null
  try {
    // The request and everything after it come back as events, so both interface layers show the same thing.
    const { session } = await core<{ session: string }>('agent.start', { prompt: text, mode: mode(), tabId: tabs.activeId, session: target?.id, attach })
    setSessions('current', session)
    return session
  } catch (e) {
    const id = `local-${Date.now()}`
    setSessions(
      produce((state) => {
        state.list.unshift({ id, title: text.slice(0, 60), status: 'error', mode: mode(), items: [{ kind: 'user', text }, { kind: 'error', text: (e as Error).message }] })
        state.current = id
      }),
    )
    return null
  }
}

export function stop(session: string): void {
  void core('agent.stop', { session }).catch(() => {})
}

export function answerApproval(session: string, id: string, allow: boolean): void {
  withSession(session, (s) => {
    const item = s.items.find((i) => i.kind === 'approval' && i.id === id)
    if (item && item.kind === 'approval') item.answered = allow ? 'allow' : 'deny'
    s.status = 'running'
  })
  void core('agent.approve', { session, id, allow }).catch(() => {})
}

/** Which sub-agent, if any, is working in a tab: the one whose step touched it last. */
export function workerOfTab(s: Session | undefined, tabId: string): Worker | undefined {
  if (!s?.workers?.length) return undefined
  for (let i = s.items.length - 1; i >= 0; i--) {
    const item = s.items[i]
    if (item.kind === 'step' && item.tab === tabId) return item.worker ? s.workers.find((w) => w.id === item.worker) : undefined
  }
  return undefined
}

/** A page the user chose to see large in a task view, per task. */
const [pinned, setPinned] = createStore<Record<string, string>>({})
export const pinTile = (task: string, tab: string) => setPinned(task, tab)

/**
 * The pages a task is working in, to be shown live beside its conversation.
 * The first is drawn large. With one agent that is wherever it is working now;
 * with several working side by side the order holds still, so pages do not
 * swap places while you watch. A page you click stays the large one.
 */
export function taskPeeks(id: string): string[] {
  const s = sessions.list.find((x) => x.id === id)
  const own = tabs.tabs.filter((t) => t.owner === 'agent' && t.session === id).map((t) => t.id)
  const all = s?.attached && tabs.tabs.some((t) => t.id === s.attached) ? [s.attached, ...own] : own
  if (!all.length) return []
  let first = pinned[id] && all.includes(pinned[id]) ? pinned[id] : undefined
  if (!first && !s?.workers?.length) {
    for (let i = (s?.items.length ?? 0) - 1; i >= 0 && !first; i--) {
      const item = s!.items[i]
      if (item.kind === 'step' && item.tab && all.includes(item.tab)) first = item.tab
    }
  }
  first ??= s?.workers?.length ? all[0] : all[all.length - 1]
  return [first, ...all.filter((t) => t !== first)]
}

/**
 * Go to a task. A task has its own place: its conversation fills the window,
 * with the pages it is working in live beside it. A conversation that belongs
 * to a page of yours opens beside that page instead.
 */
export async function openTask(id: string): Promise<void> {
  await ensureLoaded(id)
  const s = sessions.list.find((x) => x.id === id)
  withSession(id, (x) => (x.open = true))
  if (s && isPageThread(s)) {
    setSessions('current', id)
    void bridge.invoke('app:open-thread', { id, tab: s.attached })
    return
  }
  void bridge.invoke('app:open-task', { id, peeks: taskPeeks(id) })
}

export function markSeen(id: string): void {
  void bridge.invoke('app:seen', id)
}

/** Forget a task and close the tabs it opened. */
/** The tasks kept from earlier, newest first. Each is a line until it is opened; then its record is read. */
export async function loadTasks(): Promise<void> {
  const stored = await core<TaskSummary[]>('tasks.list').catch(() => [] as TaskSummary[])
  setSessions(
    produce((state) => {
      for (const t of stored ?? []) {
        if (state.list.some((s) => s.id === t.id)) continue
        state.list.push({ id: t.id, title: t.title, status: t.status, mode: t.mode, items: [], open: false, loaded: false, created: t.created, at: t.at, headline: t.headline, pageUrl: t.pageUrl })
      }
      state.list.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    }),
  )
}

/** Read a stored task's record, if it has not been read yet. */
async function ensureLoaded(id: string): Promise<void> {
  const s = sessions.list.find((x) => x.id === id)
  if (!s || s.loaded !== false) return
  const record = await core<TaskRecord | null>('tasks.get', { id }).catch(() => null)
  withSession(id, (x) => {
    x.loaded = true
    if (!record) return
    x.items = record.items
    x.workers = record.workers
  })
}

/** What a task came to, in a line: the opening of its latest answer. */
export function headlineOf(s: Session): string {
  if (s.loaded === false) return s.headline ?? ''
  const turn = lastTurn(s)
  if (turn.failure && !turn.answer) return turn.failure
  const first = turn.answer.trim().split(/\n\s*\n/)[0] ?? ''
  return first
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Close a task: its word leaves the top row and its pages are closed. It stays on the Tasks page. */
export function closeTask(id: string): void {
  for (const t of tabs.tabs) if (t.owner === 'agent' && t.session === id) void bridge.invoke('tabs:close', t.id)
  const s = sessions.list.find((x) => x.id === id)
  if (s?.status === 'running' || s?.status === 'waiting') stop(id)
  withSession(id, (x) => {
    x.open = false
    x.unread = false
  })
  if (sessions.current === id) setSessions('current', null)
}

/** Remove a task for good. */
export function deleteTask(id: string): void {
  closeTask(id)
  void core('tasks.remove', { id }).catch(() => {})
  setSessions(
    produce((state) => {
      state.list = state.list.filter((x) => x.id !== id)
    }),
  )
}

/** Remove every task that is not running. */
export function clearTasks(): void {
  const gone = sessions.list.filter((s) => s.status !== 'running' && s.status !== 'waiting')
  for (const s of gone) for (const t of tabs.tabs) if (t.owner === 'agent' && t.session === s.id) void bridge.invoke('tabs:close', t.id)
  void core('tasks.clear').catch(() => {})
  setSessions(
    produce((state) => {
      state.list = state.list.filter((x) => x.status === 'running' || x.status === 'waiting')
      if (!state.list.some((x) => x.id === state.current)) state.current = null
    }),
  )
}

/** The part of a task produced by its latest request. */
export function lastTurn(s: Session | undefined): { request: string; answer: string; steps: Extract<Item, { kind: 'step' }>[]; outcome?: Extract<Item, { kind: 'result' }>; failure?: string; pending?: Extract<Item, { kind: 'approval' }> } {
  const items = s?.items ?? []
  let start = 0
  items.forEach((item, i) => {
    if (item.kind === 'user') start = i
  })
  const turn = items.slice(start)
  const first = turn[0]
  // The answer is what was said after the last thing done. A remark made along the way is not the outcome.
  let lastStep = -1
  turn.forEach((item, i) => {
    if (item.kind === 'step') lastStep = i
  })
  const closing = turn.slice(lastStep + 1).filter((i): i is Extract<Item, { kind: 'text' }> => i.kind === 'text')
  const said = closing.length ? closing : turn.filter((i): i is Extract<Item, { kind: 'text' }> => i.kind === 'text')
  return {
    request: first?.kind === 'user' ? first.text : '',
    answer: said.map((i) => i.text).join('\n\n'),
    steps: turn.filter((i): i is Extract<Item, { kind: 'step' }> => i.kind === 'step'),
    outcome: turn.find((i): i is Extract<Item, { kind: 'result' }> => i.kind === 'result'),
    failure: turn.find((i): i is Extract<Item, { kind: 'error' }> => i.kind === 'error')?.text,
    pending: turn.find((i): i is Extract<Item, { kind: 'approval' }> => i.kind === 'approval' && !i.answered),
  }
}
