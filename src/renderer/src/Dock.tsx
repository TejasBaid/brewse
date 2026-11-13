import { For, Match, Show, Switch, createComputed, createEffect, createMemo, createSignal, on, onCleanup, onMount, type JSX } from 'solid-js'
import type { EffortMode } from '../../shared/protocol'
import { bridge } from './bridge'
import { Markdown } from './markdown'
import { activeTab, answerApproval, ask, initAgent, initShell, lastTurn, layout, markSeen, mode, openTask, sessions, setMode, stop, threadFor, type Session } from './store'

// The dock lives in the layer above the page and rises from its bottom edge.
// It is how a task is given, and how its outcome is delivered:
//   prompt    the field for a new task (⌘K, or resting the pointer on the bottom edge)
//   line      while tasks run: a thin moving line, nothing more
//   detail    resting the pointer on the line: exactly what is going on
//   approval  a question that must be answered before a task goes on
//   result    the outcome of a task worth reading, over the lower half of the page
// Scrolling the result, or choosing "Open task", goes to the task itself.
//
// The prompt, the detail and the approval share one panel: a solid surface that
// slides up from the bottom edge. The layer is sized first and the panel moves
// only once the layer is on screen, so it never appears half-drawn; on the way
// out the panel leaves before the layer is taken away.

type Phase = 'hidden' | 'prompt' | 'line' | 'detail' | 'approval' | 'result' | 'expanding'
type Kind = 'none' | 'panel' | 'sheet'
type PanelPhase = 'prompt' | 'detail' | 'approval'

const kindOf = (p: Phase): Kind => (p === 'prompt' || p === 'detail' || p === 'approval' ? 'panel' : p === 'result' || p === 'expanding' ? 'sheet' : 'none')

/** How long the pointer must rest on the bottom edge before it counts as meant. */
const DWELL_PROMPT = 240
const DWELL_DETAIL = 140
/** Space kept above the panel for its shadow, and its distance from the bottom of the page. */
const PANEL_HEADROOM = 56
const PANEL_BOTTOM = 14

/** Run once the next frame has been drawn (or shortly after, if frames are not being drawn yet). */
function afterFrame(fn: () => void): void {
  let done = false
  const go = () => {
    if (done) return
    done = true
    fn()
  }
  requestAnimationFrame(() => requestAnimationFrame(go))
  setTimeout(go, 140)
}

const MODES: { id: EffortMode; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'fast', label: 'Fast' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'thorough', label: 'Thorough' },
]

const openLink = (url: string) => void bridge.invoke('tabs:create', { url })

/** An answer worth a sheet: more than a line or two, or structured. A bare confirmation is not. */
function isResult(text: string): boolean {
  return text.length > 240 || /(^|\n)\s*([-*]\s|\d+[.)]\s|#{1,4}\s|\|.+\|)/.test(text)
}

/** Split an answer into its opening statement, shown as the headline, and the rest. */
function splitAnswer(text: string): { headline: string; body: string } {
  const [first, ...rest] = text.trim().split(/\n\s*\n/)
  const plain = first && first.length <= 240 && !/^\s*([-*#|>]|\d+[.)]\s)/.test(first) && !first.includes('\n')
  if (!plain || !rest.length) return { headline: '', body: text.trim() }
  // The headline is set as plain words: links keep their text, and emphasis marks go.
  const headline = first.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|`/g, '')
  return { headline, body: rest.join('\n\n') }
}

function sourcesOf(text: string): { host: string; url: string }[] {
  const seen = new Map<string, string>()
  for (const m of text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
    try {
      const host = new URL(m[0]).host.replace(/^www\./, '')
      if (!seen.has(host)) seen.set(host, m[0])
    } catch {}
  }
  return [...seen].slice(0, 6).map(([host, url]) => ({ host, url }))
}

export function Dock(): JSX.Element {
  const [prompting, setPrompting] = createSignal(false)
  const [hovered, setHovered] = createSignal(false)
  const [sheet, setSheet] = createSignal<string | null>(null)
  const [linger, setLinger] = createSignal<string | null>(null)
  const [expanding, setExpanding] = createSignal(false)
  const [covered, setCovered] = createSignal(false)
  const [draft, setDraft] = createSignal('')
  const [lift, setLift] = createSignal(0)
  /** The layer is sized and on screen, so what it holds may move into view. */
  const [ready, setReady] = createSignal(false)
  const [near, setNear] = createSignal(false)
  /** The field was summoned by the pointer, not asked for; it goes away again if it is left alone. */
  const [byHover, setByHover] = createSignal(false)
  /** Where the request being written will go: to the page in view, or into a task of its own. */
  const [scope, setScope] = createSignal<'page' | 'task'>('task')
  let input!: HTMLTextAreaElement
  let panel!: HTMLDivElement
  let lingerTimer: ReturnType<typeof setTimeout> | undefined
  let leaveTimer: ReturnType<typeof setTimeout> | undefined
  let hoverTimer: ReturnType<typeof setTimeout> | undefined

  // A task about the page in view is shown beside that page, so the dock leaves it alone.
  const mine = (s: Session) => !s.attached
  const running = createMemo(() => sessions.list.filter((s) => mine(s) && s.status === 'running'))
  const waiting = createMemo(() => sessions.list.find((s) => mine(s) && s.status === 'waiting' && lastTurn(s).pending))
  const byId = (id: string | null) => sessions.list.find((s) => s.id === id)
  const inTaskView = () => layout().mode !== 'browse'

  // Asked on a page, a request belongs to that page: its conversation opens beside it and is picked
  // up again next time. That is offered whenever a real page is in view and its conversation is free.
  const pageTab = () => {
    const tab = activeTab()
    return layout().mode === 'browse' && tab && /^https?:/.test(tab.url) ? tab : undefined
  }
  const canPage = () => {
    const thread = threadFor(pageTab()?.id)
    return !!pageTab() && thread?.status !== 'running' && thread?.status !== 'waiting'
  }
  createEffect(() => {
    if (scope() === 'page' && !canPage()) setScope('task')
  })

  const phase = createMemo<Phase>(() => {
    if (expanding()) return 'expanding'
    if (inTaskView()) return 'hidden'
    if (waiting()) return 'approval'
    if (sheet() && byId(sheet())) return 'result'
    if (prompting()) return 'prompt'
    if (running().length || (linger() && byId(linger()))) return hovered() ? 'detail' : 'line'
    return 'hidden'
  })

  // The panel keeps what it was showing while it slides away.
  const [panelPhase, setPanelPhase] = createSignal<PanelPhase>('prompt')
  createComputed(() => {
    const p = phase()
    if (p === 'prompt' || p === 'detail' || p === 'approval') setPanelPhase(p)
  })

  const panelPx = () => (panel?.offsetHeight || 110) + PANEL_BOTTOM + PANEL_HEADROOM

  // The layer covers only what the dock draws, so the rest of the page stays usable.
  let turn = 0
  createEffect(
    on(phase, (p, before) => {
      const kind = kindOf(p)
      const was = before ? kindOf(before) : 'none'
      const mine = ++turn
      if (kind === 'none') {
        setReady(false)
        const settle = () => turn === mine && void bridge.invoke('dock:size', { px: p === 'line' ? 10 : 0 })
        // Whatever was up leaves first; then the layer shrinks to the line, or goes.
        // A task that has just finished passes through here on its way to its result; do not drop the layer for that instant.
        if (was === 'none') p === 'hidden' ? setTimeout(settle, 90) : settle()
        else setTimeout(settle, 300)
        return
      }
      if (kind !== was) setReady(false)
      const spec = p === 'result' ? { fraction: 0.5, focus: true } : p === 'expanding' ? { fraction: 1 } : { px: panelPx(), focus: p !== 'detail' }
      void bridge.invoke('dock:size', spec).then(() => {
        if (turn !== mine) return
        if (p === 'prompt') input?.focus()
        afterFrame(() => turn === mine && setReady(true))
      })
    }),
  )

  // Resting the pointer on the bottom edge is a request; passing over it is not.
  createEffect(
    on(near, (isNear) => {
      clearTimeout(hoverTimer)
      clearTimeout(leaveTimer)
      if (isNear) {
        if (phase() === 'hidden' && !covered()) {
          hoverTimer = setTimeout(() => {
            if (phase() !== 'hidden' || !near()) return
            setByHover(true)
            setScope(canPage() ? 'page' : 'task')
            setPrompting(true)
          }, DWELL_PROMPT)
        } else if (phase() === 'line') hoverTimer = setTimeout(() => phase() === 'line' && near() && setHovered(true), DWELL_DETAIL)
        return
      }
      if (hovered()) leaveTimer = setTimeout(() => !near() && setHovered(false), 380)
      // A field the pointer summoned, left empty and then left behind, is put away again.
      else if (phase() === 'prompt' && byHover() && !draft().trim()) leaveTimer = setTimeout(() => !near() && phase() === 'prompt' && byHover() && !draft().trim() && setPrompting(false), 900)
    }),
  )

  // When a task finishes, deliver it: a sheet for an answer worth reading, otherwise the line rests a moment.
  const statuses = createMemo(() => sessions.list.map((s) => `${s.id}:${s.status}`).join(','))
  let previous = new Map<string, string>()
  createEffect(
    on(statuses, () => {
      for (const s of sessions.list) {
        const was = previous.get(s.id)
        const finished = (was === 'running' || was === 'waiting') && s.status !== 'running' && s.status !== 'waiting'
        if (finished && mine(s) && !inTaskView()) {
          if (s.status === 'done' && isResult(lastTurn(s).answer)) setSheet(s.id)
          else {
            clearTimeout(lingerTimer)
            setLinger(s.id)
            lingerTimer = setTimeout(() => setLinger(null), s.status === 'done' ? 6000 : 12_000)
          }
        }
      }
      previous = new Map(sessions.list.map((s) => [s.id, s.status]))
    }),
  )

  const run = async (text: string, where: 'page' | 'task' = scope()) => {
    const prompt = text.trim()
    if (!prompt) return
    const tab = where === 'page' ? pageTab() : undefined
    setDraft('')
    if (input) input.style.height = 'auto'
    setPrompting(false)
    setSheet(null)
    const id = await ask(prompt, { scope: tab ? 'page' : 'task' })
    if (!id) return
    // A request made on a page opens beside that page. A task is a place of its own, and you are taken there.
    if (tab) void bridge.invoke('app:open-thread', { id, tab: tab.id })
    else openTask(id)
  }

  const closeSheet = () => {
    const id = sheet()
    if (id) markSeen(id)
    setSheet(null)
  }

  /** Grow the sheet to fill the card, then go to the task underneath it. */
  const open = (id: string | null) => {
    if (!id) return
    if (phase() !== 'result') {
      openTask(id)
      setHovered(false)
      setLinger(null)
      return
    }
    setLift(window.innerHeight)
    setExpanding(true)
    requestAnimationFrame(() => requestAnimationFrame(() => setLift(0)))
    setTimeout(() => {
      openTask(id)
      setTimeout(() => {
        setSheet(null)
        setExpanding(false)
      }, 160)
    }, 440)
  }

  onMount(() => {
    initShell()
    initAgent()
    bridge.on('dock:show', (p: { scope?: 'task' } | undefined) => {
      // Never put an empty field over a question that is waiting for an answer.
      if (waiting() || expanding()) return
      clearTimeout(hoverTimer)
      setSheet(null)
      setScope(p?.scope !== 'task' && canPage() ? 'page' : 'task')
      // Asked for outright: it stays until it is used or dismissed.
      setByHover(false)
      setPrompting(true)
      queueMicrotask(() => input?.focus())
    })
    bridge.on('dock:pointer', (p: { near: boolean }) => setNear(p.near))
    // The panel is as tall as what it holds; the layer follows it.
    const observer = new ResizeObserver(() => kindOf(phase()) === 'panel' && void bridge.invoke('dock:size', { px: panelPx() }))
    observer.observe(panel)
    onCleanup(() => observer.disconnect())
    // Clicking back into the page puts an unused field away.
    window.addEventListener('blur', () => phase() === 'prompt' && !draft().trim() && setPrompting(false))
    // Typed into a new tab or the address field: a task of its own.
    bridge.on('dock:run', ({ prompt }: { prompt: string }) => void run(prompt, 'task'))
    // Development screenshots: go from the result into the task.
    bridge.on('dock:dev-open', () => open(sheet()))
    bridge.on('dock:dev-hover', () => setHovered(true))
    bridge.on('dock:dev-ask', (p: { prompt: string; scope: 'page' | 'task' }) => void run(p.prompt, p.scope))
    bridge.on('overlay:show', () => setCovered(true))
    bridge.on('overlay:hide', () => setCovered(false))
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || covered()) return
      if (phase() === 'result') closeSheet()
      else dismiss()
    })
  })

  const sheetTask = () => byId(sheet())
  const sheetTurn = createMemo(() => lastTurn(sheetTask()))
  const sheetParts = createMemo(() => splitAnswer(sheetTurn().answer))
  const sheetSources = createMemo(() => sourcesOf(sheetTurn().answer))
  const approval = () => (waiting() ? lastTurn(waiting()).pending : undefined)
  const watched = () => (running().length ? running() : byId(linger()) ? [byId(linger())!] : [])

  /** Put away whatever the pointer or the keyboard brought up. */
  const dismiss = () => {
    if (phase() === 'prompt') setPrompting(false)
    else if (phase() === 'detail') setHovered(false)
  }

  return (
    <div class="dock" classList={{ live: phase() !== 'hidden', covered: covered(), [`is-${phase()}`]: true }} onMouseDown={(e) => e.target === e.currentTarget && dismiss()}>
      {/* The line: all there is while a task runs. */}
      <div class="dock-rail" classList={{ on: phase() === 'line' || phase() === 'detail', resting: !running().length }} />

      {/* The panel: the field for a task, what a running task is doing, or a question before it goes on. */}
      <div ref={panel} class="dock-panel" classList={{ up: ready() && kindOf(phase()) === 'panel' }}>
        <Switch>
          <Match when={panelPhase() === 'prompt'}>
            <textarea
              ref={input}
              class="dock-input"
              rows={1}
              placeholder={scope() === 'page' ? 'Ask about this page, or have Brewse work on it' : 'What should Brewse do?'}
              value={draft()}
              onInput={(e) => {
                setDraft(e.currentTarget.value)
                e.currentTarget.style.height = 'auto'
                e.currentTarget.style.height = `${Math.min(72, e.currentTarget.scrollHeight)}px`
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                  e.preventDefault()
                  void run(draft())
                } else if (e.key === 'Tab' && canPage()) {
                  e.preventDefault()
                  setScope(scope() === 'page' ? 'task' : 'page')
                }
              }}
            />
            <div class="dock-row">
              <div class="modes">
                {/* Where the request goes. Shown only when there is a choice. */}
                <Show when={canPage()}>
                  <button class="text-btn scope" classList={{ on: scope() === 'page' }} title="About this page. The conversation opens beside it and stays with this tab. (Tab switches)" onClick={() => setScope('page')}>
                    This page
                  </button>
                  <button class="text-btn scope" classList={{ on: scope() === 'task' }} title="A task of its own, with its own pages. (Tab switches)" onClick={() => setScope('task')}>
                    New task
                  </button>
                  <span class="modes-rule" />
                </Show>
                <For each={MODES}>
                  {(m) => (
                    <button class="text-btn" role="radio" aria-checked={mode() === m.id} classList={{ on: mode() === m.id }} onClick={() => setMode(m.id)}>
                      {m.label}
                    </button>
                  )}
                </For>
              </div>
              <button class="text-btn" classList={{ on: !!draft().trim() }} disabled={!draft().trim()} onClick={() => void run(draft())}>
                Send
              </button>
            </div>
          </Match>

          <Match when={panelPhase() === 'detail'}>
            <For each={watched().slice(0, 2)}>
              {(task) => {
                const turn = () => lastTurn(task)
                return (
                  <div class="watch">
                    <div class="watch-head">
                      <span class="watch-title">{turn().request || task.title}</span>
                      <span class="watch-actions">
                        <Show when={task.status === 'running'}>
                          <button class="text-btn" onClick={() => stop(task.id)}>
                            Stop
                          </button>
                        </Show>
                        <button class="text-btn on" onClick={() => open(task.id)}>
                          Open task
                        </button>
                      </span>
                    </div>
                    <Show
                      when={task.status === 'running'}
                      fallback={<div class="watch-outcome" classList={{ bad: task.status === 'error' }}>{turn().failure ?? (turn().answer.split('\n')[0] || 'Done.')}</div>}
                    >
                      <div class="watch-steps">
                        <For each={turn().steps.slice(-4)}>{(step) => <div class="watch-step" classList={{ now: step.status === 'run', bad: step.status === 'error' }}>{step.summary}</div>}</For>
                        <Show when={!turn().steps.length}>
                          <div class="watch-step now">Thinking</div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                )
              }}
            </For>
          </Match>

          <Match when={panelPhase() === 'approval'}>
            <div class="dock-label">Before I go on</div>
            <div class="dock-ask">{approval()?.summary}</div>
            <div class="dock-detail">{approval()?.detail}</div>
            <div class="dock-row start">
              <button class="text-btn on" onClick={() => approval() && answerApproval(waiting()!.id, approval()!.id, true)}>
                Allow
              </button>
              <button class="text-btn" onClick={() => approval() && answerApproval(waiting()!.id, approval()!.id, false)}>
                Decline
              </button>
            </div>
          </Match>

        </Switch>
      </div>

      {/* The sheet: the outcome of a task, over the lower half of the page. */}
      <div class="dock-sheet" classList={{ on: ready() && kindOf(phase()) === 'sheet' }} onWheel={(e) => phase() === 'result' && Math.abs(e.deltaY) > 4 && open(sheet())}>
        <div class="dock-ground" />
        <div class="dock-solid" />
        <div class="dock-body" style={{ transform: lift() ? `translateY(${lift() / 2}px)` : undefined }}>
          <Show when={phase() === 'result' || phase() === 'expanding'}>
            <div class="sheet-head rise" style={{ '--i': 0 }}>
              <span class="dock-label">
                {sheetTurn().steps.length ? `${sheetTurn().steps.length} ${sheetTurn().steps.length === 1 ? 'step' : 'steps'}` : 'Answered'}
                <Show when={sheetTurn().outcome}> in {(sheetTurn().outcome!.ms / 1000).toFixed(0)}s</Show>
              </span>
              <span class="sheet-actions">
                <button class="text-btn on" onClick={() => open(sheet())}>
                  Open task
                </button>
                <button class="text-btn" onClick={closeSheet}>
                  Close
                </button>
              </span>
            </div>
            <div class="sheet">
              <div class="sheet-request rise" style={{ '--i': 1 }}>
                {sheetTurn().request}
              </div>
              <Show when={sheetParts().headline}>
                <h1 class="sheet-headline rise" style={{ '--i': 2 }}>
                  {sheetParts().headline}
                </h1>
                <div class="sheet-rule rise" style={{ '--i': 3 }} />
              </Show>
              <div class="sheet-body rise" style={{ '--i': 4 }}>
                <Markdown text={sheetParts().body} onLink={openLink} />
              </div>
            </div>
            <Show when={sheetSources().length > 0}>
              <div class="sheet-sources rise" style={{ '--i': 5 }}>
                <span class="dock-label">Sources</span>
                <For each={sheetSources()}>
                  {(s) => (
                    <button class="text-btn" onClick={() => openLink(s.url)}>
                      {s.host}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  )
}
