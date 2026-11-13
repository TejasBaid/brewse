import { For, Show, createEffect, createMemo, createResource, createSignal, on, onMount, type JSX } from 'solid-js'
import type { Suggestion } from '../../shared/protocol'
import { bridge, core } from './bridge'
import { LABEL, createSuggestions } from './CommandBar'
import { TaskRow } from './Tasks'
import { isPageThread, sessions, tabs } from './store'

// A new tab. One field takes an address, a search or a task; under it is what
// you are most likely to want next: the tasks that are running or just done,
// and the pages you go to, as pictures. Whatever is chosen happens in this tab.

/** Shown only until the first task has been given: what kind of thing can be asked. */
const EXAMPLES = ['What are the top stories on Hacker News right now?', 'Compare the three best-reviewed espresso grinders under $200', 'Find a vegetarian dinner recipe that uses spinach and chickpeas']

function host(url: string | undefined): string {
  try {
    return url ? new URL(url).host.replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

export function StartPage(props: { now: number }): JSX.Element {
  const [text, setText] = createSignal('')
  const [selected, setSelected] = createSignal(0)
  const suggestions = createSuggestions(text, () => tabs)
  const typing = () => !!text().trim()
  let input!: HTMLInputElement

  // The pages you go to most, and a picture of each from the last time you were there.
  const [recent] = createResource(() => core<Suggestion[]>('history.recent', { limit: 8 }).catch(() => [] as Suggestion[]))
  const [pictures] = createResource(
    () => recent()?.map((r) => r.url ?? ''),
    (urls) => (urls.length ? bridge.invoke<Record<string, string>>('app:thumbs', urls).catch(() => ({}) as Record<string, string>) : ({} as Record<string, string>)),
  )
  // What is going on now comes first, then the latest that finished.
  const tasks = createMemo(() => {
    const all = sessions.list.filter((s) => !isPageThread(s))
    const live = all.filter((s) => s.status === 'running' || s.status === 'waiting' || s.unread)
    const rest = all.filter((s) => !live.includes(s)).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    return [...live, ...rest].slice(0, 4)
  })

  const focus = () => {
    input.focus()
    input.select()
  }
  onMount(() => {
    focus()
    bridge.on('app:focus-address', focus)
    // Development screenshots: fill the field.
    bridge.on('app:dev-type', (p: { text: string }) => setText(p.text))
  })
  // Coming back to an empty tab puts the keyboard in its field again.
  createEffect(on(() => tabs.activeId, focus, { defer: true }))
  createEffect(() => {
    suggestions()
    setSelected(0)
  })

  const submit = (s: Suggestion | undefined) => {
    if (!s) return
    const blank = tabs.activeId
    setText('')
    void bridge.invoke('overlay:submit', { kind: s.kind, text: s.title, url: s.kind === 'history' ? s.url : undefined, tabId: s.tabId, mode: 'address' })
    // Going to a tab that is already open leaves nothing for this one to do.
    if (s.kind === 'tab' && blank) void bridge.invoke('tabs:close', blank)
  }

  const today = () => new Date(props.now).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div class="start">
      <div class="start-col">
        <div class="start-date">{today()}</div>
        <input
          ref={input}
          class="start-input"
          spellcheck={false}
          placeholder="Search, enter an address, or ask Brewse"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            const list = suggestions()
            if (e.key === 'Escape') setText('')
            else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSelected(Math.min(list.length - 1, selected() + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSelected(Math.max(0, selected() - 1))
            } else if (e.key === 'Enter' && !e.isComposing) {
              e.preventDefault()
              if (!typing()) return
              if (e.metaKey) submit({ kind: 'ask', title: text().trim() })
              else submit(list[selected()])
            }
          }}
        />

        {/* While typing: what the text could mean, the likeliest first. */}
        <Show when={typing()}>
          <div class="start-list">
            <For each={suggestions()}>
              {(s, i) => (
                <div class="start-row" classList={{ selected: selected() === i() }} onMouseEnter={() => setSelected(i())} onMouseDown={(e) => (e.preventDefault(), submit(s))}>
                  <span class="start-title">{s.title}</span>
                  <span class="start-detail">
                    {s.kind === 'history'
                      ? s.url
                          ?.replace(/^https?:\/\/(www\.)?/, '')
                          .replace(/\/$/, '')
                      : LABEL[s.kind]}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={!typing()}>
          <Show
            when={tasks().length > 0}
            fallback={
              <section class="start-section">
                <div class="start-label">Things you can ask</div>
                <For each={EXAMPLES}>
                  {(example) => (
                    <button
                      class="start-example"
                      onClick={() => {
                        setText(example)
                        focus()
                      }}
                    >
                      {example}
                    </button>
                  )}
                </For>
              </section>
            }
          >
            <section class="start-section">
              <div class="start-label">
                Tasks
                <button class="text-btn" onClick={() => bridge.invoke('app:tasks')}>
                  All tasks
                </button>
              </div>
              <For each={tasks()}>{(task) => <TaskRow task={task} now={props.now} />}</For>
            </section>
          </Show>

          <Show when={(recent() ?? []).length > 0}>
            <section class="start-section">
              <div class="start-label">Pages</div>
              <div class="start-grid">
                <For each={recent()}>
                  {(page, i) => (
                    <button class="start-card" style={{ '--i': i() }} title={page.url} onClick={() => submit(page)}>
                      <div class="start-thumb" classList={{ blank: !pictures()?.[page.url ?? ''] }} style={pictures()?.[page.url ?? ''] ? { 'background-image': `url("${pictures()![page.url ?? '']}")` } : undefined}>
                        <Show when={!pictures()?.[page.url ?? '']}>
                          <span>{(host(page.url)[0] ?? '').toUpperCase()}</span>
                        </Show>
                      </div>
                      <div class="start-card-title">{page.title}</div>
                      <div class="start-card-host">{host(page.url)}</div>
                    </button>
                  )}
                </For>
              </div>
            </section>
          </Show>
        </Show>
      </div>
      <button class="text-btn start-settings" onClick={() => bridge.invoke('app:settings')}>
        Settings
      </button>
    </div>
  )
}
