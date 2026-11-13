import { For, Show, createEffect, createMemo, createSignal, onMount, type Accessor, type JSX } from 'solid-js'
import type { OverlayMode, Suggestion, TabsState } from '../../shared/protocol'
import { bridge, core } from './bridge'

const URLISH = /^([a-z][a-z0-9+.-]*:\/\/|localhost|\d{1,3}(\.\d{1,3}){3})|^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i

export const LABEL: Record<Suggestion['kind'], string> = {
  ask: 'Ask Brewse',
  go: 'Open',
  search: 'Search',
  history: '',
  tab: 'Switch to tab',
  routine: 'Run routine',
}

/**
 * What a piece of typed text could mean: an address to open, a search, a page
 * from history, a tab that is already open, or a task for Brewse. The most
 * likely reading comes first.
 */
export function createSuggestions(text: Accessor<string>, tabs: Accessor<TabsState>, askOnly: Accessor<boolean> = () => false): Accessor<Suggestion[]> {
  const [remote, setRemote] = createSignal<Suggestion[]>([])
  // History suggestions come from the core's in-memory index; ignore stale replies.
  let seq = 0
  createEffect(() => {
    const q = text().trim()
    const mine = ++seq
    if (!q || askOnly()) {
      setRemote([])
      return
    }
    core<Suggestion[]>('omnibox.query', { q, limit: 5 })
      .then((r) => mine === seq && setRemote(r ?? []))
      .catch(() => mine === seq && setRemote([]))
  })
  return createMemo<Suggestion[]>(() => {
    const q = text().trim()
    if (!q) return []
    const ask: Suggestion = { kind: 'ask', title: q }
    if (askOnly()) return [ask]
    const isUrl = URLISH.test(q)
    const go: Suggestion = { kind: isUrl ? 'go' : 'search', title: q }
    const lower = q.toLowerCase()
    const open = tabs()
      .tabs.filter((t) => t.id !== tabs().activeId && t.url !== 'about:blank' && (t.title.toLowerCase().includes(lower) || t.url.toLowerCase().includes(lower)))
      .slice(0, 3)
      .map((t): Suggestion => ({ kind: 'tab', title: t.title, url: t.url, tabId: t.id }))
    // A long, sentence-like entry is most likely a task for the agent.
    const taskLike = !isUrl && q.split(/\s+/).length >= 5
    const head = taskLike ? [ask, go] : [go, ask]
    // A page that is already open is offered once, as the tab.
    const history = remote().filter((r) => !open.some((t) => t.url === r.url))
    return [head[0], ...history, ...open, head[1]]
  })
}

/** The command bar: one field for addresses, searches and tasks. It lives in its own layer above the page. */
export function CommandBar(): JSX.Element {
  const [mode, setMode] = createSignal<OverlayMode>('new-tab')
  const [text, setText] = createSignal('')
  const [open, setOpen] = createSignal(false)
  const [tabs, setTabs] = createSignal<TabsState>({ tabs: [], activeId: null })
  const [selected, setSelected] = createSignal(0)
  /** Where the tab's word is, when an address is being edited in place. */
  const [anchor, setAnchor] = createSignal<{ x: number; y: number; width: number; height: number } | null>(null)
  /** Nothing is suggested for an address that has only been opened for editing, not changed. */
  const [edited, setEdited] = createSignal(false)
  let input!: HTMLInputElement

  onMount(() => {
    bridge.on('overlay:show', (p: { mode: OverlayMode; url?: string; anchor?: { x: number; y: number; width: number; height: number } }) => {
      setAnchor(p.mode === 'address' && p.anchor ? p.anchor : null)
      setEdited(p.mode !== 'address')
      setMode(p.mode)
      setText(p.mode === 'address' ? (p.url ?? '') : '')
      setSelected(0)
      setOpen(true)
      queueMicrotask(() => {
        input.focus()
        input.select()
      })
    })
    bridge.on('overlay:hide', () => setOpen(false))
    bridge.on('tabs:state', (s: TabsState) => setTabs(s))
    void bridge.invoke<TabsState>('tabs:state').then(setTabs)
  })

  const suggestions = createSuggestions(text, tabs, () => mode() === 'ask')

  createEffect(() => {
    suggestions()
    setSelected(0)
  })

  // In place: the field sits exactly over the tab's word and is wide enough to read a whole address.
  const place = (): JSX.CSSProperties | undefined => {
    const a = anchor()
    if (!a) return undefined
    const width = Math.min(Math.max(a.width + 40, 460), window.innerWidth - 32)
    const left = Math.max(12, Math.min(a.x - 3, window.innerWidth - width - 12))
    return { left: `${left}px`, top: `${a.y + (a.height - 36) / 2}px`, width: `${width}px` }
  }

  const close = () => void bridge.invoke('overlay:close')
  const submit = (s: Suggestion | undefined) => {
    if (!s) return
    void bridge.invoke('overlay:submit', { kind: s.kind, text: s.title, url: s.kind === 'history' ? s.url : undefined, tabId: s.tabId, mode: mode() })
  }

  return (
    <div class="overlay" classList={{ open: open(), anchored: !!anchor() }} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="command" style={place()}>
        <div class="command-input">
          <input
            ref={input}
            spellcheck={false}
            placeholder={mode() === 'ask' ? 'What should Brewse do for you?' : 'Search, enter an address, or describe a task'}
            value={text()}
            onInput={(e) => {
              setEdited(true)
              setText(e.currentTarget.value)
            }}
            onKeyDown={(e) => {
              const list = suggestions()
              if (e.key === 'Escape') close()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelected((selected() + 1) % Math.max(1, list.length))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelected((selected() - 1 + list.length) % Math.max(1, list.length))
              } else if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault()
                if (e.metaKey) submit({ kind: 'ask', title: text().trim() })
                else submit(list[selected()])
              } else if (e.key === 'Tab' && !anchor()) {
                e.preventDefault()
                setMode(mode() === 'ask' ? 'new-tab' : 'ask')
              }
            }}
          />
          <Show when={!anchor()}>
            <span class="command-hint">{mode() === 'ask' ? 'Tab to browse' : 'Tab to ask'}</span>
          </Show>
        </div>
        <Show when={edited() && suggestions().length > 0}>
          <div class="suggestions">
            <For each={suggestions()}>
              {(s, i) => (
                <div class="suggestion" classList={{ selected: selected() === i() }} onMouseEnter={() => setSelected(i())} onMouseDown={() => submit(s)}>
                  <span class="suggestion-title">{s.title}</span>
                  <span class="suggestion-detail">{s.kind === 'history' ? s.url?.replace(/^https?:\/\/(www\.)?/, '') : LABEL[s.kind]}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}
