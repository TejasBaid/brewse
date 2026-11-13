import { For, Show, createMemo, createSignal, onMount, type JSX } from 'solid-js'
import { clearTasks, deleteTask, headlineOf, openTask, sessions, type Session } from './store'

// The Tasks page: everything you have asked Brewse to do, kept. What is going
// on now comes first; the rest is listed by day. A task that was closed, or
// left from an earlier day, opens again from here with its conversation as it
// was, and can be carried on.

const DAY = 86_400_000

function host(url: string | undefined): string {
  try {
    return url ? new URL(url).host.replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

/** Which day a task belongs under. */
function dayOf(at: number, now: number): string {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  if (at >= start.getTime()) return 'Today'
  if (at >= start.getTime() - DAY) return 'Yesterday'
  if (at >= start.getTime() - 6 * DAY) return 'This week'
  return 'Earlier'
}

/** When a task last finished: the time for today, the date otherwise. */
function when(at: number | undefined, now: number): string {
  if (!at) return ''
  const d = new Date(at)
  if (dayOf(at, now) === 'Today') return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

/** The word for where a task stands, when that matters more than when it was. */
export function standing(s: Session): { word: string; live?: boolean; strong?: boolean; bad?: boolean } | undefined {
  if (s.status === 'running') return { word: 'working', live: true }
  if (s.status === 'waiting') return { word: 'needs you', strong: true }
  if (s.unread) return { word: 'ready', live: true }
  if (s.status === 'error') return { word: 'failed', bad: true }
  if (s.status === 'stopped') return { word: 'stopped' }
  return undefined
}

/** One task as a line: what was asked, what came of it, and where it stands or when it was. */
export function TaskRow(props: { task: Session; now: number; onRemove?: () => void }): JSX.Element {
  const s = () => props.task
  const state = () => standing(s())
  const page = () => host(s().pageUrl)
  return (
    <div class="task-row" classList={{ unread: !!s().unread, live: s().status === 'running' || s().status === 'waiting' }} onClick={() => void openTask(s().id)}>
      <div class="task-main">
        <div class="task-title">{s().title}</div>
        <div class="task-line">
          <Show when={page()}>
            <span class="task-page">On {page()}</span>
          </Show>
          <span class="task-outcome">{headlineOf(s()) || (s().status === 'running' ? 'Working on it' : s().status === 'stopped' ? 'Stopped before it finished' : '')}</span>
        </div>
      </div>
      <div class="task-meta">
        <Show when={state()} fallback={<span class="row-meta">{when(s().at, props.now)}</span>}>
          <span class="row-meta" classList={{ live: !!state()!.live, pulse: s().status === 'running', strong: !!state()!.strong, bad: !!state()!.bad }}>
            {state()!.word}
          </span>
        </Show>
        <Show when={props.onRemove}>
          <button
            class="text-btn task-remove"
            title="Remove this task for good"
            onClick={(e) => {
              e.stopPropagation()
              props.onRemove!()
            }}
          >
            Remove
          </button>
        </Show>
      </div>
    </div>
  )
}

export function TasksPage(props: { now: number }): JSX.Element {
  const [query, setQuery] = createSignal('')
  const [confirming, setConfirming] = createSignal(false)
  let input!: HTMLInputElement
  onMount(() => input.focus())

  const matching = createMemo(() => {
    const q = query().trim().toLowerCase()
    if (!q) return sessions.list
    return sessions.list.filter((s) => `${s.title} ${headlineOf(s)} ${s.pageUrl ?? ''}`.toLowerCase().includes(q))
  })
  const groups = createMemo(() => {
    const now: Session[] = []
    const byDay = new Map<string, Session[]>()
    for (const s of matching()) {
      if (s.status === 'running' || s.status === 'waiting') now.push(s)
      else {
        const day = dayOf(s.at ?? s.created ?? 0, props.now)
        byDay.set(day, [...(byDay.get(day) ?? []), s])
      }
    }
    const out: { label: string; tasks: Session[] }[] = []
    if (now.length) out.push({ label: 'Now', tasks: now })
    for (const label of ['Today', 'Yesterday', 'This week', 'Earlier']) {
      const tasks = byDay.get(label)
      if (tasks?.length) out.push({ label, tasks: tasks.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)) })
    }
    return out
  })
  const finished = () => sessions.list.filter((s) => s.status !== 'running' && s.status !== 'waiting').length

  return (
    <div class="tasks-page">
      <div class="tasks-col">
        <div class="tasks-head">
          <input ref={input} class="tasks-search" spellcheck={false} placeholder="Search your tasks" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
          <Show when={finished() > 0}>
            <button
              class="text-btn"
              classList={{ on: confirming() }}
              onClick={() => {
                if (!confirming()) return setConfirming(true)
                clearTasks()
                setConfirming(false)
              }}
              onMouseLeave={() => setConfirming(false)}
            >
              {confirming() ? `Remove all ${finished()}?` : 'Clear'}
            </button>
          </Show>
        </div>
        <Show
          when={groups().length > 0}
          fallback={<p class="tasks-empty">{sessions.list.length ? 'Nothing matches that.' : 'Nothing yet. Ask from a new tab, or press ⌘K on a page, and it will be kept here.'}</p>}
        >
          <For each={groups()}>
            {(group) => (
              <section class="tasks-group">
                <div class="tasks-label">{group.label}</div>
                <For each={group.tasks}>{(task) => <TaskRow task={task} now={props.now} onRemove={() => deleteTask(task.id)} />}</For>
              </section>
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}
