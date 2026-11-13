import { For, Match, Show, Switch, createEffect, createSignal, type JSX } from 'solid-js'
import type { EffortMode } from '../../shared/protocol'
import { bridge } from './bridge'
import { Markdown } from './markdown'
import { jevLine } from './jev'
import { answerApproval, ask, composerFocus, currentSession, mode, setMode, stop, type Item } from './store'

const MODES: { id: EffortMode; label: string; hint: string }[] = [
  { id: 'auto', label: 'Auto', hint: 'Claude and Jev share the work: Jev sizes up the request, reads pages for Claude, finds controls and clears notices' },
  { id: 'fast', label: 'Fast', hint: 'Fewest model calls; Jev finds every control it can and Claude checks only the outcome' },
  { id: 'balanced', label: 'Balanced', hint: 'Jev reads for Claude, but finds controls only on sites where it has earned it' },
  { id: 'thorough', label: 'Thorough', hint: 'Claude takes every step itself and verifies as it goes; Jev only reads' },
]

const openLink = (url: string) => void bridge.invoke('tabs:create', { url })

/** One thing the agent did: a quiet line that opens to show the detail. */
export function Step(props: { item: Extract<Item, { kind: 'step' }> }): JSX.Element {
  const [open, setOpen] = createSignal(false)
  return (
    <div class="step" classList={{ run: props.item.status === 'run', error: props.item.status === 'error' }}>
      <button class="step-head" onClick={() => props.item.detail && setOpen(!open())}>
        <span class="step-summary">
          {props.item.summary}
          {props.item.status === 'error' ? ' (did not work)' : ''}
        </span>
        <Show when={props.item.by === 'jev'}>
          <span class="step-note" title={props.item.tool === 'browser_read' ? 'Jev went through the page and chose what Claude read' : 'Jev found the control for this step, or cleared what was over it'}>
            Jev
          </span>
        </Show>
      </button>
      <Show when={open() && props.item.detail}>
        <pre class="step-detail">{props.item.detail}</pre>
      </Show>
    </div>
  )
}

/**
 * The conversation with the agent. `side` is the panel beside the page;
 * `center` is chat mode, where it fills the card.
 */
export function Conversation(props: { variant?: 'side' | 'center' } = {}): JSX.Element {
  const center = () => props.variant === 'center'
  const [draft, setDraft] = createSignal('')
  let scroller!: HTMLDivElement
  let input!: HTMLTextAreaElement
  const session = currentSession
  const busy = () => session()?.status === 'running'

  // Keep the newest output in view unless the reader has scrolled up.
  let pinned = true
  createEffect(() => {
    const s = session()
    if (!s) return
    const last = s.items[s.items.length - 1]
    if (last && 'text' in last) last.text
    s.items.length
    if (pinned) queueMicrotask(() => (scroller.scrollTop = scroller.scrollHeight))
  })

  // ⌘K in chat mode lands here.
  createEffect(() => {
    if (composerFocus() > 0) input?.focus()
  })

  const submit = () => {
    const text = draft().trim()
    if (!text || busy()) return
    setDraft('')
    input.style.height = ''
    // Beside a page the conversation is that page's; in a task view it goes on with the task.
    void ask(text, { scope: center() ? 'continue' : 'page' })
  }

  return (
    <section class="panel" classList={{ center: center() }}>
      <header class="panel-head">
        {/* In chat mode the request itself is the heading, so the title would only repeat it. */}
        <span class="panel-title">{center() ? '' : (session()?.title ?? '')}</span>
        <Show when={!center()}>
          <button class="text-btn" onClick={() => bridge.invoke('layout:set', { panel: 0 })}>
            Close
          </button>
        </Show>
      </header>

      <div class="transcript" ref={scroller} onScroll={() => (pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40)}>
        <Show
          when={session()}
          fallback={
            <div class="panel-empty">
              <h2>What should I do?</h2>
              <p>Describe a task. I work in background tabs and show each step here. Open any of them to watch or take over.</p>
            </div>
          }
        >
          <For each={session()!.items}>
            {(item) => (
              <Switch>
                <Match when={item.kind === 'user'}>
                  {/* A short request reads as a heading; a long one is set smaller so it does not shout. */}
                  <div class="q" classList={{ long: (item as Extract<Item, { kind: 'user' }>).text.length > 110 }}>
                    {(item as Extract<Item, { kind: 'user' }>).text}
                  </div>
                </Match>
                <Match when={item.kind === 'text'}>
                  <Markdown text={(item as Extract<Item, { kind: 'text' }>).text} onLink={openLink} />
                </Match>
                <Match when={item.kind === 'thinking'}>
                  <div class="thinking">{(item as Extract<Item, { kind: 'thinking' }>).text}</div>
                </Match>
                {/* In chat mode the steps are listed in the task log beside the conversation. */}
                <Match when={item.kind === 'step' && !center()}>
                  <Step item={item as Extract<Item, { kind: 'step' }>} />
                </Match>
                <Match when={item.kind === 'approval'}>
                  {(() => {
                    const a = item as Extract<Item, { kind: 'approval' }>
                    return (
                      <div class="approval" classList={{ answered: !!a.answered }}>
                        <div class="approval-title">Before I go on</div>
                        <div class="approval-summary">{a.summary}</div>
                        <Show when={a.detail}>
                          <div class="approval-detail">{a.detail}</div>
                        </Show>
                        <Show when={!a.answered} fallback={<div class="approval-answer">{a.answered === 'allow' ? 'Allowed' : 'Declined'}</div>}>
                          <div class="approval-actions">
                            <button class="text-btn allow" onClick={() => answerApproval(session()!.id, a.id, true)}>
                              Allow
                            </button>
                            <button class="text-btn" onClick={() => answerApproval(session()!.id, a.id, false)}>
                              Decline
                            </button>
                          </div>
                        </Show>
                      </div>
                    )
                  })()}
                </Match>
                <Match when={item.kind === 'result'}>
                  {(() => {
                    const r = item as Extract<Item, { kind: 'result' }>
                    return (
                      <div class="result" classList={{ failed: !r.ok }}>
                        {r.ok ? '' : 'Stopped after '}
                        {(r.ms / 1000).toFixed(1)}s<Show when={r.cost !== undefined}> · ${r.cost!.toFixed(3)}</Show>
                        <Show when={r.jev}>
                          <span title={`Jev ${jevLine(r.jev!)}`}> · Jev made {r.jev!.decisions === 1 ? 'one judgment' : `${r.jev!.decisions} judgments`}</span>
                        </Show>
                      </div>
                    )
                  })()}
                </Match>
                <Match when={item.kind === 'files'}>
                  {(() => {
                    const made = item as Extract<Item, { kind: 'files' }>
                    const home = (path: string) => path.replace(/^\/Users\/[^/]+/, '~')
                    // A file in the task's own folder needs no address beyond any folder inside it; one put elsewhere says where.
                    const place = (path: string) => {
                      const dir = path.slice(0, path.lastIndexOf('/'))
                      return dir.startsWith(made.folder) ? dir.slice(made.folder.length + 1) : home(dir)
                    }
                    return (
                      <div class="made">
                        <div class="made-label">
                          <span class="made-folder" title={made.folder}>
                            Files in {home(made.folder)}
                          </span>
                          <button class="text-btn" onClick={() => bridge.invoke('app:reveal', made.folder)}>
                            Show folder
                          </button>
                        </div>
                        <For each={made.files}>
                          {(file) => (
                            <div class="made-row" title={file.path} onClick={() => bridge.invoke('app:open-file', file.path)}>
                              <span class="made-name">{file.name}</span>
                              <span class="made-place">{place(file.path)}</span>
                              <button
                                class="text-btn made-show"
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void bridge.invoke('app:reveal', file.path)
                                }}
                              >
                                Show in Finder
                              </button>
                            </div>
                          )}
                        </For>
                      </div>
                    )
                  })()}
                </Match>
                <Match when={item.kind === 'error'}>
                  <div class="msg-error">{(item as Extract<Item, { kind: 'error' }>).text}</div>
                </Match>
              </Switch>
            )}
          </For>
          <Show when={busy()}>
            <div class="msg-working">Working</div>
          </Show>
        </Show>
      </div>

      <footer class="composer">
        <textarea
          ref={input}
          rows={1}
          placeholder={session() ? 'Reply, or give another task' : 'Ask Brewse to do something'}
          value={draft()}
          onInput={(e) => {
            setDraft(e.currentTarget.value)
            e.currentTarget.style.height = 'auto'
            e.currentTarget.style.height = `${Math.min(180, e.currentTarget.scrollHeight)}px`
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div class="composer-row">
          <div class="modes" role="radiogroup" aria-label="Effort">
            <For each={MODES}>
              {(m) => (
                <button class="text-btn" role="radio" aria-checked={mode() === m.id} classList={{ on: mode() === m.id }} title={m.hint} onClick={() => setMode(m.id)}>
                  {m.label}
                </button>
              )}
            </For>
          </div>
          <Show
            when={busy()}
            fallback={
              <button class="text-btn" classList={{ on: !!draft().trim() }} disabled={!draft().trim()} onClick={submit}>
                Send
              </button>
            }
          >
            <button class="text-btn on" onClick={() => stop(session()!.id)}>
              Stop
            </button>
          </Show>
        </div>
      </footer>
    </section>
  )
}
