import { For, Show, createEffect, createMemo, type JSX } from 'solid-js'
import { Step } from './Conversation'
import type { JevShare } from '../../shared/protocol'
import { jevLine } from './jev'
import { currentSession, type Item } from './store'

type StepItem = Extract<Item, { kind: 'step' }>

interface Group {
  /** Empty for what the agent did itself; otherwise the sub-agent's name. */
  label: string
  running: boolean
  steps: StepItem[]
}

interface Task {
  title: string
  groups: Group[]
  seconds?: number
  failed?: boolean
  jev?: JevShare
}

/**
 * A task's record of work: each request, and under it what was done for it.
 * When the agent hands parts of a request to sub-agents, each one's work is
 * listed under its own name, so several working at once stay readable.
 * It sits below the live pages so the conversation can stay text.
 */
export function TaskLog(props: { style?: JSX.CSSProperties }): JSX.Element {
  let scroller!: HTMLDivElement
  const tasks = createMemo<Task[]>(() => {
    const session = currentSession()
    const out: Task[] = []
    let byWorker = new Map<string, Group>()
    for (const item of session?.items ?? []) {
      if (item.kind === 'user') {
        out.push({ title: item.text, groups: [] })
        byWorker = new Map()
      } else if (item.kind === 'step' && out.length) {
        const key = item.worker ?? ''
        let group = byWorker.get(key)
        if (!group) {
          const worker = session?.workers?.find((w) => w.id === item.worker)
          const n = session?.workers?.findIndex((w) => w.id === item.worker) ?? 0
          group = { label: item.worker ? worker?.label || `Part ${n + 1}` : '', running: worker?.status === 'running', steps: [] }
          byWorker.set(key, group)
          out[out.length - 1].groups.push(group)
        }
        group.steps.push(item)
      } else if (item.kind === 'result' && out.length) {
        out[out.length - 1].seconds = item.ms / 1000
        out[out.length - 1].failed = !item.ok
        out[out.length - 1].jev = item.jev
      }
    }
    return out
  })

  // Follow the newest line as work comes in.
  createEffect(() => {
    tasks().reduce((n, t) => n + t.groups.reduce((m, g) => m + g.steps.length, 0), tasks().length)
    queueMicrotask(() => (scroller.scrollTop = scroller.scrollHeight))
  })

  return (
    <aside class="log" style={props.style}>
      <div class="log-head">Log</div>
      <div class="log-body" ref={scroller}>
        <Show when={tasks().length > 0} fallback={<p class="log-empty">What the agent does for each request is listed here.</p>}>
          <For each={tasks()}>
            {(task) => (
              <div class="log-task">
                <div class="log-title">
                  <span class="log-name">{task.title}</span>
                  <Show when={task.seconds !== undefined}>
                    <span class="log-time" classList={{ failed: task.failed }}>
                      {task.seconds!.toFixed(1)}s
                    </span>
                  </Show>
                </div>
                <Show when={task.groups.length > 0} fallback={<div class="log-none">{task.seconds === undefined ? 'Thinking' : 'Answered without browsing'}</div>}>
                  <For each={task.groups}>
                    {(group) => (
                      <>
                        <Show when={group.label}>
                          <div class="log-worker" classList={{ running: group.running }}>
                            <span class="log-name">{group.label}</span>
                            <span class="log-time">{group.running ? 'working' : 'done'}</span>
                          </div>
                        </Show>
                        <div classList={{ 'log-part': !!group.label }}>
                          <For each={group.steps}>{(step) => <Step item={step} />}</For>
                        </div>
                      </>
                    )}
                  </For>
                </Show>
                {/* The fast model's share of the request, beside Claude's steps above. */}
                <Show when={task.jev}>
                  <div class="log-jev">
                    <span class="log-jev-name">Jev</span>
                    {jevLine(task.jev!)}
                  </div>
                </Show>
              </div>
            )}
          </For>
        </Show>
      </div>
    </aside>
  )
}
