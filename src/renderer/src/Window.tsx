import { For, Show, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount, type JSX } from 'solid-js'
import type { TabInfo } from '../../shared/protocol'
import { bridge } from './bridge'
import { Conversation } from './Conversation'
import { Icon } from './icons'
import { SettingsPanel } from './SettingsPanel'
import { StartPage } from './StartPage'
import { TaskLog } from './TaskLog'
import { TasksPage } from './Tasks'
import {
  activeTab,
  ask,
  currentSession,
  initAgent,
  initShell,
  isPageThread,
  layout,
  markSeen,
  openTask,
  panelView,
  pinTile,
  closeTask,
  loadTasks,
  sessions,
  setComposerFocus,
  setPanelView,
  setSessions,
  stop,
  tabs,
  taskPeeks,
  threadFor,
  workerOfTab,
  type Session,
} from './store'

// The window. There is no sidebar: the page gets the full width, and everything
// else is one line of words across the top.
//   left   your tabs. The one you are on shows its address; the others are names.
//   right  your tasks, each with a word for where it stands, then Ask.
// Choosing a tab shows a page. Choosing a task shows its conversation, with the
// page it is working on floating beside it. The overview shows all of them at once.

const PANEL = 400
const inTask = () => layout().mode === 'chat'
const inOverview = () => layout().mode === 'overview'
const inTasks = () => layout().mode === 'tasks'
const TASKS_SHOWN = 3

function host(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'about:' ? '' : u.host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** The path as readable segments: `essays / a-prairie-enthusiast`. */
function pathParts(url: string): string[] {
  try {
    return new URL(url).pathname
      .split('/')
      .filter(Boolean)
      .slice(0, 3)
      .map((p) => {
        try {
          return decodeURIComponent(p)
        } catch {
          return p
        }
      })
  } catch {
    return []
  }
}

function ago(at: number | undefined, now: number): string {
  if (!at) return ''
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** One word for where a task stands. */
function taskState(t: Session, now: number): { word: string; live?: boolean; strong?: boolean; bad?: boolean } {
  if (t.status === 'running') return { word: 'working', live: true }
  if (t.status === 'waiting') return { word: 'needs you', strong: true }
  if (t.status === 'error') return { word: 'failed', bad: true }
  if (t.unread) return { word: 'ready', live: true }
  return { word: ago(t.at, now) }
}

/** Close, minimise and full screen. Drawn here, not by macOS, so they are always coloured. */
function WindowButtons(): JSX.Element {
  const act = (action: 'close' | 'minimize' | 'zoom') => () => void bridge.invoke('app:window', action)
  return (
    <div class="lights">
      <button class="light light-close" aria-label="Close window" onClick={act('close')}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.6 3.6l4.8 4.8M8.4 3.6L3.6 8.4" />
        </svg>
      </button>
      <button class="light light-min" aria-label="Minimise window" onClick={act('minimize')}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.8 6h6.4" />
        </svg>
      </button>
      <button class="light light-zoom" aria-label="Full screen" onClick={act('zoom')}>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 2.8v6.4M2.8 6h6.4" />
        </svg>
      </button>
    </div>
  )
}

const isBlank = (url: string) => !url || url === 'about:blank'

/** Edit the address of the tab in view, in place: the field opens over the tab's word. */
function editAddress(): void {
  const word = document.querySelector('.word.tab.current')?.getBoundingClientRect()
  const anchor = word
    ? {
        x: Math.round(word.left),
        y: Math.round(word.top),
        width: Math.round(word.width),
        height: Math.round(word.height),
      }
    : undefined
  void bridge.invoke('overlay:open', { mode: 'address', anchor })
}

function Favicon(props: { tab: TabInfo }): JSX.Element {
  const [failed, setFailed] = createSignal(false)
  createEffect(() => {
    props.tab.favicon
    setFailed(false)
  })
  return (
    <span class="favicon" classList={{ loading: props.tab.loading }}>
      <Show when={props.tab.favicon && !failed()} fallback={<span class="favicon-blank">{(host(props.tab.url)[0] ?? '').toUpperCase()}</span>}>
        <img src={props.tab.favicon} alt="" draggable={false} onError={() => setFailed(true)} />
      </Show>
    </span>
  )
}

/**
 * A tab, as a word in the toolbar. The tab you are on is written out as its
 * address, and clicking it edits that address. The others are short names;
 * clicking one goes there, and it unfolds into its address as it becomes current.
 */
function TabWord(props: { tab: TabInfo }): JSX.Element {
  const current = () => layout().mode === 'browse' && props.tab.id === tabs.activeId
  const domain = () => host(props.tab.url)
  // What you asked on a page stays with its tab, and the tab says where that stands.
  const thread = () => (props.tab.owner === 'user' ? threadFor(props.tab.id) : undefined)
  const pending = () => {
    const t = thread()
    return t && (t.status === 'running' || t.status === 'waiting' || t.unread) ? taskState(t, 0) : undefined
  }
  return (
    <div
      class="word tab"
      classList={{
        current: current(),
        asleep: !!props.tab.asleep,
        busy: !!props.tab.busy,
      }}
      title={current() ? 'Edit address (⌘L)' : props.tab.title}
      onMouseDown={(e) => {
        if (e.button === 1) void bridge.invoke('tabs:close', props.tab.id)
        else if (e.button !== 0) return
        else if (current()) editAddress()
        // Going to a tab whose conversation is working, or has something new, opens that conversation beside it.
        else if (pending()) openTask(thread()!.id)
        else void bridge.invoke('tabs:activate', props.tab.id)
      }}
    >
      <Show when={!isBlank(props.tab.url)}>
        <Favicon tab={props.tab} />
      </Show>
      <span class="word-text">
        <Show when={current() && domain()} fallback={isBlank(props.tab.url) ? 'New tab' : props.tab.title || domain() || 'New tab'}>
          <span class="url-host">{domain()}</span>
          <For each={pathParts(props.tab.url)}>
            {(p) => (
              <>
                <span class="url-sep"> / </span>
                <span class="url-part">{p}</span>
              </>
            )}
          </For>
        </Show>
      </span>
      <Show when={pending()}>
        <span
          class="row-meta"
          classList={{
            live: !!pending()!.live,
            pulse: thread()!.status === 'running',
            strong: !!pending()!.strong,
          }}
        >
          {pending()!.word}
        </span>
      </Show>
      <button
        class="word-x"
        aria-label="Close tab"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          void bridge.invoke('tabs:close', props.tab.id)
        }}
      >
        <Icon.close />
      </button>
    </div>
  )
}

/** A task, as a word in the toolbar: what was asked, and where it stands. */
function TaskWord(props: { task: Session; now: number }): JSX.Element {
  const t = () => props.task
  const state = () => taskState(t(), props.now)
  const current = () => sessions.current === t().id && (inTask() || (layout().panel > 0 && panelView() === 'agent'))
  return (
    <div
      class="word task"
      classList={{ current: current(), unread: !!t().unread }}
      title={t().title}
      // Choosing the task you are already in goes back to the page you came from.
      onClick={() => (inTask() && sessions.current === t().id ? void bridge.invoke('layout:set', { mode: 'browse', peek: null }) : openTask(t().id))}
    >
      <span class="word-text">{t().title}</span>
      <span
        class="row-meta"
        classList={{
          live: !!state().live,
          pulse: t().status === 'running',
          strong: !!state().strong,
          bad: !!state().bad,
        }}
      >
        {state().word}
      </span>
      <button
        class="word-x"
        aria-label="Close task"
        title="Close this task. It stays on the Tasks page."
        onClick={(e) => {
          e.stopPropagation()
          if (sessions.current === t().id && inTask()) void bridge.invoke('layout:set', { mode: 'browse', peek: null })
          closeTask(t().id)
        }}
      >
        <Icon.close />
      </button>
    </div>
  )
}

function Toolbar(props: { now: number }): JSX.Element {
  const tab = activeTab
  const userTabs = createMemo(() => tabs.tabs.filter((t) => t.owner === 'user'))
  // Tabs opened by a coding session over MCP have no task in this window; they sit with your tabs.
  // So does a task's page once you open it in full: the page in view always has its word and its address.
  const codingTabs = createMemo(() => tabs.tabs.filter((t) => t.owner === 'agent' && (!sessions.list.some((s) => s.id === t.session) || (layout().mode === 'browse' && t.id === tabs.activeId))))
  const shownTasks = createMemo(() => {
    // Always show the task being looked at, then the most recent ones.
    // A conversation that belongs to an open page is shown on that page's tab, not here.
    // The top row holds the tasks that are open, like tabs. Closed ones, and those from earlier days, are on the Tasks page.
    const list = sessions.list.filter((s) => s.open && !isPageThread(s))
    const current = list.find((s) => s.id === sessions.current && inTask())
    const rest = list.filter((s) => s !== current)
    return (current ? [current, ...rest] : rest).slice(0, TASKS_SHOWN)
  })
  const browsing = () => layout().mode === 'browse'
  const taskCount = () => sessions.list.filter((s) => s.open && !isPageThread(s)).length

  return (
    <div class="toolbar">
      <WindowButtons />
      <button class="icon-btn" aria-label="Back" disabled={!browsing() || !tab()?.canGoBack} onClick={() => bridge.invoke('tabs:back')}>
        <Icon.back />
      </button>
      <button class="icon-btn" aria-label="Forward" disabled={!browsing() || !tab()?.canGoForward} onClick={() => bridge.invoke('tabs:forward')}>
        <Icon.forward />
      </button>
      <button class="icon-btn" aria-label={tab()?.loading ? 'Stop' : 'Reload'} disabled={!browsing() || !tab()} onClick={() => bridge.invoke(tab()?.loading ? 'tabs:stop' : 'tabs:reload')}>
        <Show when={browsing() && tab()?.loading} fallback={<Icon.reload />}>
          <Icon.stop />
        </Show>
      </button>

      <div class="words tabs">
        <For each={userTabs()}>{(t) => <TabWord tab={t} />}</For>
        <For each={codingTabs()}>{(t) => <TabWord tab={t} />}</For>
      </div>
      <button class="text-btn word-new" aria-label="New tab" title="New tab (⌘T)" onClick={() => bridge.invoke('tabs:new')}>
        +
      </button>
      {/* The empty stretch of the row is where the window is picked up and moved. */}
      <div class="drag toolbar-gap" />

      <div class="words tasks">
        <For each={shownTasks()}>{(s) => <TaskWord task={s} now={props.now} />}</For>
        <Show when={taskCount() > TASKS_SHOWN}>
          <button class="text-btn" title="All tasks" onClick={() => bridge.invoke('app:tasks')}>
            +{taskCount() - TASKS_SHOWN}
          </button>
        </Show>
        <Show when={inTask() && currentSession()?.status === 'running'}>
          <button class="text-btn" onClick={() => stop(currentSession()!.id)}>
            Stop
          </button>
        </Show>
      </div>

      <nav class="toolbar-nav">
        <button class="text-btn" data-nav="tabs" classList={{ on: inOverview() }} onClick={() => bridge.invoke('app:overview')} title="Every tab at once (⇧⌘\)">
          Tabs
        </button>
        <button class="text-btn" data-nav="tasks" classList={{ on: inTasks() }} onClick={() => bridge.invoke('app:tasks')} title="Every task you have given Brewse (⇧⌘K)">
          Tasks
        </button>
        <button class="text-btn" data-nav="ask" onClick={() => bridge.invoke('dock:open')} title="Give Brewse a task (⌘K)">
          Ask
        </button>
      </nav>
    </div>
  )
}

/** Everything at once: each tab as a picture of its page, and each task as a line. */
function Overview(): JSX.Element {
  const [thumbs] = createResource(() => bridge.invoke<Record<string, string>>('tabs:thumbs'))
  const pages = createMemo(() => tabs.tabs.filter((t) => t.owner === 'user' || !sessions.list.some((s) => s.id === t.session)))
  return (
    <div class="overview">
      <div class="over-col">
        <div class="over-label">Tabs</div>
        <div class="over-grid">
          <For each={pages()}>
            {(t, i) => (
              <div class="over-card" style={{ '--i': i() }} onClick={() => bridge.invoke('tabs:activate', t.id)}>
                <div class="over-thumb" classList={{ blank: !thumbs()?.[t.id] }} style={thumbs()?.[t.id] ? { 'background-image': `url("${thumbs()![t.id]}")` } : undefined}>
                  <Show when={!thumbs()?.[t.id]}>
                    <span>{host(t.url) || 'New tab'}</span>
                  </Show>
                </div>
                <div class="over-name">
                  <Favicon tab={t} />
                  <span class="word-text">{t.title || host(t.url) || 'New tab'}</span>
                  <button
                    class="word-x"
                    aria-label="Close tab"
                    onClick={(e) => {
                      e.stopPropagation()
                      void bridge.invoke('tabs:close', t.id)
                    }}
                  >
                    <Icon.close />
                  </button>
                </div>
              </div>
            )}
          </For>
          <button class="over-card new" style={{ '--i': pages().length }} onClick={() => bridge.invoke('tabs:new')}>
            <div class="over-thumb blank">
              <span>New tab</span>
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}

/** Settings open beside a page. */
function openSettings(): void {
  const showing = layout().panel > 0 && panelView() === 'settings'
  setPanelView(showing ? 'agent' : 'settings')
  void bridge.invoke('layout:set', showing ? { panel: 0 } : { panel: PANEL, mode: 'browse', peek: null })
}

export function Window(): JSX.Element {
  const [width, setWidth] = createSignal(window.innerWidth)
  // Relative times ("2m") move on by themselves.
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(tick))

  onMount(() => {
    initShell()
    initAgent()
    // Tasks from earlier are kept on disk; they are listed on the Tasks page and the new tab page.
    void loadTasks()
    window.addEventListener('resize', () => setWidth(window.innerWidth))
    // Escape steps back to the page: out of the overview, or out of a task whose field is empty.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      if (inOverview()) void bridge.invoke('app:overview')
      else if (inTasks()) void bridge.invoke('app:tasks')
      else if (inTask() && !(e.target as HTMLTextAreaElement | null)?.value) void bridge.invoke('layout:set', { mode: 'browse', peek: null })
    })
    bridge.on('app:edit-address', () => editAddress())
    // Development aid: open the most recent stored task and carry it on.
    bridge.on('app:dev-continue', async ({ prompt }: { prompt: string }) => {
      await loadTasks()
      const latest = sessions.list[0]
      if (!latest) return
      await openTask(latest.id)
      setSessions('current', latest.id)
      void ask(prompt, { scope: 'continue' })
    })
    bridge.on('app:settings', () => openSettings())
    bridge.on('app:focus-composer', () => setComposerFocus((n) => n + 1))
    bridge.on('app:ask', ({ prompt }: { prompt: string }) => {
      setPanelView('agent')
      void ask(prompt)
    })
    // A task that starts working on the page you are looking at opens beside that page.
    bridge.on('core:agent', (e: { type: string; session: string; tab?: string }) => {
      if (e.type !== 'attach' || layout().mode !== 'browse' || e.tab !== tabs.activeId) return
      setSessions('current', e.session)
      setPanelView('agent')
      void bridge.invoke('layout:set', { panel: PANEL })
    })
  })

  createEffect(() => {
    const l = layout()
    const right = l.panel > 0 ? l.panel : 8
    const root = document.documentElement.style
    root.setProperty('--sidebar', '8px')
    root.setProperty('--panel', `${right}px`)
    // The floating window in a task view. The main process places the page with the same arithmetic (see shell.ts).
    const inset = Math.round(Math.min(420, Math.max(280, (width() - 8 - right) * 0.3)))
    root.setProperty('--inset-w', `${inset}px`)
    root.setProperty('--inset-h', `${Math.round(inset * 0.68)}px`)
  })

  // In a task view, keep every page the task is working in on screen, live.
  createEffect(() => {
    if (!inTask() || !sessions.current) return
    const peeks = taskPeeks(sessions.current)
    if (peeks.join() !== layout().peeks.join()) void bridge.invoke('layout:set', { peeks })
  })

  // The conversation beside a page is that page's own. Going to another tab shows that tab's, or closes the panel.
  createEffect(
    on(
      () => tabs.activeId,
      (active) => {
        if (layout().panel === 0 || layout().mode !== 'browse' || panelView() !== 'agent') return
        const thread = threadFor(active)
        if (thread) setSessions('current', thread.id)
        else void bridge.invoke('layout:set', { panel: 0 })
      },
      { defer: true },
    ),
  )
  // Opening the panel on a page shows what has been asked on that page, or an empty field to ask in.
  createEffect(
    on(
      () => layout().panel > 0,
      (open) => {
        if (!open || layout().mode !== 'browse' || panelView() !== 'agent') return
        const thread = threadFor(tabs.activeId)
        if (thread) setSessions('current', thread.id)
        else if (!pendingThread()) setSessions('current', null)
      },
      { defer: true },
    ),
  )

  // Looking at a conversation, in its own view or beside its page, counts as having read its outcome.
  createEffect(() => {
    const s = currentSession()
    if (s?.unread && (inTask() || (layout().panel > 0 && layout().mode === 'browse' && panelView() === 'agent'))) markSeen(s.id)
  })

  /** A request just made on this page, whose conversation has not been tied to the tab yet. */
  const pendingThread = () => {
    const s = currentSession()
    return !!s && s.status === 'running' && !s.attached && !tabs.tabs.some((t) => t.session === s.id)
  }

  // A page that is being worked on has a border around it for as long as the work goes on.
  const workState = createMemo<'working' | 'waiting' | null>(() => {
    const tab = activeTab()
    if (layout().mode !== 'browse' || !tab || isBlank(tab.url)) return null
    const thread = threadFor(tab.id)
    return thread?.status === 'running' ? 'working' : thread?.status === 'waiting' ? 'waiting' : null
  })
  createEffect(() => {
    if (!!workState() !== layout().frame) void bridge.invoke('layout:set', { frame: !!workState() })
  })

  const tileIds = createMemo(() => layout().tiles.map((t) => t.id), undefined, {
    equals: (a, b) => a.join() === b.join(),
  })
  const tile = (id: string) => layout().tiles.find((t) => t.id === id)
  const moreTiles = () => (sessions.current && inTask() ? Math.max(0, taskPeeks(sessions.current).length - layout().tiles.length) : 0)
  // The log runs under the live pages, in the same column.
  const logStyle = (): JSX.CSSProperties => {
    const tiles = layout().tiles
    if (!tiles.length)
      return {
        right: '22px',
        top: 'calc(var(--toolbar) + 14px)',
        width: 'var(--inset-w)',
      }
    const bottom = Math.max(...tiles.map((t) => t.y + t.height))
    return {
      left: `${tiles[0].x}px`,
      top: `${bottom + (moreTiles() ? 34 : 12)}px`,
      width: `${tiles[0].width}px`,
    }
  }

  return (
    <div class="chrome">
      <div class="drag frame-drag" />
      <div
        class="card"
        classList={{
          working: !!workState(),
          waiting: workState() === 'waiting',
          task: inTask(),
          'with-inset': inTask() && layout().tiles.length > 0,
        }}
      >
        <Toolbar now={now()} />
        <Show when={inTask()}>
          <Conversation variant="center" />
          {/* Every page the task is working in, live: one large, the rest small. Each is the real page, scaled. */}
          <For each={tileIds()}>
            {(id) => {
              // A tile's frame is read once more as it leaves; it keeps the last place it had.
              let last = tile(id)!
              const t = () => (last = tile(id) ?? last)
              const tab = () => tabs.tabs.find((x) => x.id === id)
              const worker = () => workerOfTab(currentSession(), id)
              const active = () => {
                const s = currentSession()
                if (!s || s.status !== 'running') return false
                const w = worker()
                return w ? w.status === 'running' : !!tab()?.busy || (!!t()?.primary && !s.workers?.length)
              }
              return (
                <div
                  class="tile"
                  classList={{ primary: t().primary, working: active() }}
                  style={{
                    left: `${t().x}px`,
                    top: `${t().y}px`,
                    width: `${t().width}px`,
                    height: `${t().height}px`,
                    '--header': `${t().header}px`,
                  }}
                >
                  <div class="tile-head" title={t().primary ? undefined : 'Show this page large'} onClick={() => !t().primary && sessions.current && pinTile(sessions.current, id)}>
                    <span class="tile-name">{worker()?.label || host(tab()?.url ?? '') || tab()?.title || 'New page'}</span>
                    <Show when={t().primary && worker()?.label}>
                      <span class="tile-host">{host(tab()?.url ?? '')}</span>
                    </Show>
                    <Show when={t().primary}>
                      <button
                        class="text-btn"
                        title="Open this page in full"
                        onClick={(e) => {
                          e.stopPropagation()
                          void bridge.invoke('tabs:activate', id)
                        }}
                      >
                        Open
                      </button>
                    </Show>
                  </div>
                </div>
              )
            }}
          </For>
          <Show when={moreTiles() > 0}>
            <div
              class="tile-more"
              style={{
                left: `${layout().tiles[0]?.x ?? 0}px`,
                top: `${Math.max(0, ...layout().tiles.map((x) => x.y + x.height)) + 8}px`,
              }}
            >
              and {moreTiles()} more {moreTiles() === 1 ? 'page' : 'pages'}
            </div>
          </Show>
          <TaskLog style={logStyle()} />
        </Show>
        <Show when={inTasks()}>
          <TasksPage now={now()} />
        </Show>
        <Show when={inOverview()}>
          <Overview />
        </Show>
        {/* A tab that has not been taken anywhere yet shows the start page. */}
        <Show when={layout().mode === 'browse' && activeTab() && isBlank(activeTab()!.url)}>
          <StartPage now={now()} />
        </Show>
        <Show when={layout().mode === 'browse' && !tabs.activeId}>
          <div class="empty-state">
            <p>⌘T opens a tab. ⌘K gives Brewse a task.</p>
          </div>
        </Show>
      </div>
      <Show when={layout().panel > 0 && layout().mode === 'browse'}>
        <Show when={panelView() === 'settings'} fallback={<Conversation />}>
          <SettingsPanel />
        </Show>
      </Show>
    </div>
  )
}
