import type { WebContentsView } from 'electron'
import type { Shell } from './shell'
import type { TabManager } from './tabs'
import type { Rpc } from '../shared/rpc'

// `--selftest`: walk through the window the way a person would, with real
// pointer and keyboard events sent to the interface, and check after each step
// that the browser did what was asked. Screenshots show what the window looks
// like; this shows whether it works.
//
// What it cannot see: how macOS itself routes a click (window-drag areas, the
// title bar). The audit step checks the things that decide that from our side:
// that nothing clickable sits inside or under a drag area, and that every
// control is the topmost thing at its own centre.

interface Probe {
  x: number
  y: number
  onTop: boolean
  top: string
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export async function selftest(shell: Shell, tabs: TabManager, core: Rpc, phase: 'all' | 'restore' = 'all'): Promise<number> {
  const results: { ok: boolean; name: string; detail: string }[] = []
  const check = (name: string, ok: boolean, detail = '') => {
    results.push({ ok, name, detail })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  }
  const js = <T>(view: WebContentsView, code: string): Promise<T> => view.webContents.executeJavaScript(code, true) as Promise<T>
  const until = async (cond: () => boolean | Promise<boolean>, ms = 4000): Promise<boolean> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await cond()) return true
      await wait(60)
    }
    return false
  }
  const probe = (view: WebContentsView, selector: string, index = 0) =>
    js<Probe | null>(
      view,
      `(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.getClientRects().length)[${index}]
        if (!el) return null
        const r = el.getBoundingClientRect()
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2)
        const top = document.elementFromPoint(x, y)
        return { x, y, onTop: !!top && (top === el || el.contains(top)), top: top ? top.tagName.toLowerCase() + '.' + String(top.className.baseVal ?? top.className).split(' ').join('.') : 'nothing' }
      })()`,
    )
  const count = (view: WebContentsView, selector: string) => js<number>(view, `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.getClientRects().length).length`)
  const click = async (view: WebContentsView, selector: string, index = 0): Promise<boolean> => {
    const p = await probe(view, selector, index)
    if (!p) return false
    const wc = view.webContents
    wc.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    await wait(40)
    wc.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 })
    await wait(260)
    return true
  }
  const key = async (view: WebContentsView, keyCode: string) => {
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode })
    await wait(200)
  }
  /** Put text in the focused field the way typing does, one input event per character. */
  const type = (view: WebContentsView, selector: string, text: string) =>
    js<boolean>(
      view,
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return false
        el.focus()
        const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set
        let value = ''
        for (const ch of ${JSON.stringify(text)}) {
          value += ch
          set.call(el, value)
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }))
        }
        return true
      })()`,
    )
  const pressEnter = (view: WebContentsView, selector: string) =>
    js(view, `document.querySelector(${JSON.stringify(selector)})?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
  const pressEscape = (view: WebContentsView) => js(view, `(document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)

  const { ui, overlay } = shell
  /** Play a task's events back, to the interface and to the record on disk, the way the agent's own would go. */
  const play = (session: string) => (e: object) => {
    const event = { session, ...e }
    shell.send('core:agent', event)
    void core.call('tasks.record', event).catch(() => {})
  }
  // Anything the interface reports as an error counts against it, whatever else passes.
  const errors: string[] = []
  for (const [name, view] of [['window', ui], ['layer', overlay]] as const) {
    view.webContents.on('console-message', (e) => {
      if (e.level === 'error') errors.push(`${name}: ${e.message.slice(0, 300)} (${e.sourceId.split('/').pop()}:${e.lineNumber})`)
    })
  }
  const userTabs = () => tabs.state().tabs.filter((t) => t.owner === 'user')
  const activeUrl = () => tabs.active()?.info.url ?? ''
  const shown = () => [...tabs.state().tabs].filter((t) => tabs.get(t.id)?.view?.getVisible()).map((t) => t.id)
  /** With nothing asked of it, the layer above the page must be out of the way, or it takes every click. */
  const layerClear = (step: string) => {
    const b = overlay.getBounds()
    const [w, h] = shell.win.getContentSize()
    const covering = overlay.getVisible() && b.height > h * 0.6 && b.width > w * 0.6
    check(`${step}: nothing invisible is left covering the window`, !covering, covering ? `layer visible at ${b.width}x${b.height}` : '')
  }

  // Window buttons are recorded, not carried out: the test must not close or minimise anything.
  const windowActions: string[] = []
  shell.windowAction = (action) => void windowActions.push(action)

  // ---- a second launch on the same profile: what was asked before is still there -----------------
  if (phase === 'restore') {
    await until(async () => (await count(ui, '.word.tab')) >= 1, 15000)
    await wait(800)
    check('after a restart the top row starts with no tasks open', (await count(ui, '.word.task')) === 0)
    await click(ui, '[data-nav="tasks"]')
    check('the tasks from before are on the Tasks page', await until(async () => (await count(ui, '.task-row')) === 3, 5000), `${await count(ui, '.task-row')} listed`)
    const row = await js<number>(ui, `[...document.querySelectorAll('.task-row')].findIndex((r) => r.textContent.includes('Compare three kettles'))`)
    await click(ui, '.task-row', row)
    const back = await until(async () => shell.layout.mode === 'chat' && (await js<string>(ui, `document.querySelector('.panel.center')?.textContent ?? ''`)).includes('Bonavita'), 5000)
    check('opening one brings back what was asked and what was answered', back, shell.layout.mode)
    check('and what was done for it', (await count(ui, '.log .step')) >= 1, `${await count(ui, '.log .step')} steps in the log`)
    check('it is open again in the top row', (await count(ui, '.word.task.current')) === 1)
    await click(ui, '.word.tab', 0)
    await click(ui, '[data-nav="tasks"]')
    await until(async () => (await count(ui, '.task-row')) === 3)
    const p = await probe(ui, '.task-row', 0)
    if (p) ui.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y })
    await wait(150)
    await click(ui, '.task-row .task-remove')
    const left = await core.call<unknown[]>('tasks.list')
    check('Remove takes a task away for good', (await until(async () => (await count(ui, '.task-row')) === 2)) && left.length === 2, `${await count(ui, '.task-row')} listed, ${left.length} stored`)
    check('the interface reported no errors while all this happened', errors.length === 0, errors.slice(0, 4).join(' | '))
    const failedRestore = results.filter((r) => !r.ok)
    console.log(failedRestore.length ? `\n${failedRestore.length} of ${results.length} failed` : `\nall ${results.length} passed`)
    return failedRestore.length
  }

  // ---- start -------------------------------------------------------------------
  const ready = await until(async () => userTabs().length >= 2 && (await count(ui, '.word.tab')) >= 2 && !tabs.active()?.info.loading, 15000)
  check('window opens with its tabs in the top row', ready, `${userTabs().length} tabs`)
  await wait(600)
  layerClear('at start')

  // ---- audit: can each control be reached at all? -------------------------------
  const audit = await js<{ covered: string[]; inDrag: string[]; drags: number }>(
    ui,
    `(() => {
      const visible = (e) => e.getClientRects().length > 0
      const name = (e) => e.tagName.toLowerCase() + '.' + String(e.className.baseVal ?? e.className).trim().split(/\\s+/).join('.') + (e.getAttribute('aria-label') ? '[' + e.getAttribute('aria-label') + ']' : '')
      const region = (e) => getComputedStyle(e).getPropertyValue('app-region') || getComputedStyle(e).getPropertyValue('-webkit-app-region')
      const controls = [...document.querySelectorAll('button, .word, input, textarea, .over-card, .row, a')].filter(visible)
      const drags = [...document.querySelectorAll('*')].filter((e) => visible(e) && region(e) === 'drag')
      const covered = [], inDrag = []
      for (const c of controls) {
        const r = c.getBoundingClientRect()
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        // A disabled button and a control that only appears under the pointer are not expected to be on top.
        if (!c.disabled && getComputedStyle(c).pointerEvents !== 'none' && !(top && (top === c || c.contains(top)))) covered.push(name(c) + ' under ' + (top ? name(top) : 'nothing'))
        if (region(c) === 'drag') inDrag.push(name(c))
        for (const d of drags) {
          const q = d.getBoundingClientRect()
          if (!(r.right <= q.left || r.left >= q.right || r.bottom <= q.top || r.top >= q.bottom) && !inDrag.includes(name(c))) inDrag.push(name(c) + ' overlaps ' + name(d))
        }
      }
      return { covered, inDrag, drags: drags.length }
    })()`,
  )
  check('no control sits inside or under a window-drag area', audit.inDrag.length === 0, audit.inDrag.slice(0, 6).join('; ') || `${audit.drags} drag areas, all empty`)
  check('every control is the topmost thing where it is drawn', audit.covered.length === 0, audit.covered.slice(0, 6).join('; '))

  // ---- window buttons -----------------------------------------------------------
  for (const [selector, action] of [
    ['.light-close', 'close'],
    ['.light-min', 'minimize'],
    ['.light-zoom', 'zoom'],
  ] as const) {
    windowActions.length = 0
    await click(ui, selector)
    check(`window button: ${action}`, windowActions.join() === action, windowActions.join() || 'no action reached the window')
  }

  // ---- tabs ---------------------------------------------------------------------
  const first = tabs.activeId
  await click(ui, '.word.tab:not(.current)')
  check('clicking another tab goes to it', tabs.activeId !== first && shown().join() === tabs.activeId, `active ${tabs.activeId}, on screen ${shown().join() || 'none'}`)
  await click(ui, '.word.tab:not(.current)')
  check('clicking back returns to the first tab', tabs.activeId === first && shown().join() === first)
  // A tab restored from the last session is not loaded until it is chosen.
  const asleep = tabs.createAsleep('https://example.net/', 'Example Net')
  await wait(200)
  await click(ui, '.word.tab.asleep')
  check('clicking a tab left from last time wakes it and shows it', (await until(() => tabs.activeId === asleep.id && shown().join() === asleep.id && activeUrl().includes('example.net'), 12000)), `active ${tabs.activeId}, ${activeUrl()}`)
  await until(() => !tabs.active()?.info.loading, 12000)
  tabs.close(asleep.id)
  await wait(200)
  tabs.activate(first!)
  await wait(200)
  layerClear('after switching tabs')

  // ---- address, in place ----------------------------------------------------------
  await click(ui, '.word.tab.current')
  const editing = await until(async () => shell.overlayOpen && (await count(overlay, '.overlay.anchored.open input')) === 1)
  const fieldValue = editing ? await js<string>(overlay, `document.querySelector('.command-input input').value`) : ''
  check('clicking the address edits it in place', editing && fieldValue === activeUrl(), editing ? `field holds ${fieldValue}` : 'no field opened')
  if (editing) {
    const word = await probe(ui, '.word.tab.current')
    const field = await probe(overlay, '.command-input')
    check('the field opens where the address is', !!word && !!field && Math.abs(word.y - field.y) <= 4, word && field ? `word y ${word.y}, field y ${field.y}` : '')
    await pressEscape(overlay)
    check('Escape leaves the address as it was', await until(() => !shell.overlayOpen && !overlay.getVisible()))
    await click(ui, '.word.tab.current')
    await until(() => shell.overlayOpen)
    await type(overlay, '.command-input input', 'https://example.org/')
    await pressEnter(overlay, '.command-input input')
    check('typing an address and pressing Enter goes there, in the same tab', (await until(() => activeUrl().includes('example.org'), 12000)) && tabs.activeId === first, activeUrl())
    check('the field goes away afterwards', !shell.overlayOpen && !overlay.getVisible())
  }
  await until(() => !tabs.active()?.info.loading, 12000)
  await wait(300)
  await click(ui, 'button[aria-label="Back"]')
  check('Back goes to the page before', await until(() => !activeUrl().includes('example.org'), 8000), activeUrl())
  await until(() => !tabs.active()?.info.loading, 8000)
  await wait(300)
  await click(ui, 'button[aria-label="Forward"]')
  check('Forward returns', await until(() => activeUrl().includes('example.org'), 8000), activeUrl())

  // ---- new tab --------------------------------------------------------------------
  let before = userTabs().length
  await click(ui, 'button[aria-label="New tab"]')
  const opened = await until(async () => userTabs().length === before + 1 && tabs.isBlank(tabs.activeId) && (await count(ui, '.start-input')) === 1)
  check('+ opens a new tab on the start page', opened, `${userTabs().length} tabs, start page ${await count(ui, '.start-input')}`)
  check('the new tab is in the top row, and no page is drawn over the start page', (await count(ui, '.word.tab.current')) === 1 && shown().length === 0, `on screen ${shown().join() || 'none'}`)
  check('the field is ready to type in', await js<boolean>(ui, `document.activeElement === document.querySelector('.start-input')`))
  await click(ui, 'button[aria-label="New tab"]')
  check('asking again does not pile up empty tabs', userTabs().length === before + 1, `${userTabs().length} tabs`)
  const recents = await until(async () => (await count(ui, '.start-card')) >= 1, 3000)
  check('a new tab shows the pages you go to, as pictures', recents && (await count(ui, '.start-thumb:not(.blank)')) >= 1, `${await count(ui, '.start-card')} pages, ${await count(ui, '.start-thumb:not(.blank)')} with a picture`)
  check('before any task has been given, it suggests what can be asked', (await count(ui, '.start-example')) === 3)
  if (recents) {
    const title = await js<string>(ui, `document.querySelector('.start-card .start-card-host').textContent`)
    await click(ui, '.start-card')
    check('choosing one opens it in this tab', (await until(() => !tabs.isBlank(tabs.activeId) && activeUrl().includes(title.split('/')[0]), 12000)) && userTabs().length === before + 1, `${title} -> ${activeUrl()}`)
    await until(() => !tabs.active()?.info.loading, 12000)
    await click(ui, 'button[aria-label="New tab"]')
    await until(() => tabs.isBlank(tabs.activeId))
    before = userTabs().length - 1
  }
  await type(ui, '.start-input', 'example.com')
  check('typing lists what it could mean', (await count(ui, '.start-row')) >= 2, `${await count(ui, '.start-row')} rows`)
  await pressEnter(ui, '.start-input')
  const went = await until(() => activeUrl().includes('example.com'), 12000)
  check('Enter opens the address in this tab', went && userTabs().length === before + 1 && shown().join() === tabs.activeId, activeUrl())
  check('the start page gives way to the page', (await count(ui, '.start-input')) === 0)

  // ---- closing ----------------------------------------------------------------------
  before = userTabs().length
  const closing = tabs.activeId
  await click(ui, '.word.tab.current .word-x')
  check('the x on a tab closes it', userTabs().length === before - 1 && tabs.activeId !== closing && !!tabs.activeId && shown().join() === tabs.activeId, `${userTabs().length} tabs, active ${tabs.activeId}`)

  // ---- overview -----------------------------------------------------------------------
  await click(ui, '[data-nav="tabs"]')
  check('All shows every tab at once, with no page on top', shell.layout.mode === 'overview' && shown().length === 0 && (await count(ui, '.over-card')) === userTabs().length + 1, `mode ${shell.layout.mode}, ${await count(ui, '.over-card')} cards`)
  const target = userTabs().find((t) => t.id !== tabs.activeId)?.id
  const index = userTabs().findIndex((t) => t.id === target)
  await click(ui, '.over-card', index)
  check('choosing a tab there goes to it', shell.layout.mode === 'browse' && tabs.activeId === target && shown().join() === target, `mode ${shell.layout.mode}, active ${tabs.activeId}`)
  await click(ui, '[data-nav="tabs"]')
  await pressEscape(ui)
  check('Escape leaves the overview', await until(() => shell.layout.mode === 'browse'), shell.layout.mode)
  await click(ui, '[data-nav="tabs"]')
  await click(ui, '[data-nav="ask"]')
  check('Ask from the overview goes back to the page and opens the field', (await until(async () => shell.layout.mode === 'browse' && (await count(overlay, '.dock-panel.up textarea')) === 1)) && overlay.getVisible(), `mode ${shell.layout.mode}`)
  await pressEscape(overlay)
  check('Escape puts the field away', await until(() => !overlay.getVisible()))
  layerClear('after the overview')

  // ---- asking -----------------------------------------------------------------------------
  await click(ui, '[data-nav="ask"]')
  const asked = await until(async () => overlay.getVisible() && (await count(overlay, '.dock-panel.up textarea')) === 1)
  const dockBounds = overlay.getBounds()
  check('Ask opens the field at the bottom, and only there', asked && dockBounds.height < 260 && shown().join() === tabs.activeId, `layer ${dockBounds.width}x${dockBounds.height}`)
  check('the field has the keyboard', await js<boolean>(overlay, `document.activeElement?.tagName === 'TEXTAREA'`))
  const scopes = await js<string>(overlay, `[...document.querySelectorAll('.dock-panel.up .scope')].map((b) => b.textContent.trim() + (b.classList.contains('on') ? '*' : '')).join(' | ')`)
  check('on a page, the field says where the request will go, and starts with this page', scopes === 'This page* | New task', scopes || 'no choice shown')
  await wait(700)
  await click(overlay, '.dock-panel.up .scope', 1)
  const scopeProbe = await probe(overlay, '.dock-panel.up .scope', 1)
  check('choosing New task switches it', (await js<string>(overlay, `document.querySelector('.dock-panel.up .scope.on')?.textContent.trim()`)) === 'New task', `button on top: ${scopeProbe?.onTop} (${scopeProbe?.top}) at ${scopeProbe?.x},${scopeProbe?.y}; dock is ${await js<string>(overlay, `document.querySelector('.dock').className + ' / panel ' + document.querySelector('.dock-panel').className + ' / scopes ' + document.querySelectorAll('.scope').length`)}`)
  await pressEscape(overlay)
  await until(() => !overlay.getVisible())

  // Resting the pointer on the bottom edge.
  overlay.webContents.send('dock:pointer', { near: true })
  await wait(120)
  check('passing over the bottom edge does nothing', !overlay.getVisible())
  const restedAt = Date.now()
  const rested = await until(async () => overlay.getVisible() && (await count(overlay, '.dock-panel.up textarea')) === 1, 3000)
  check('resting there opens the field, promptly', rested && Date.now() - restedAt < 700, `${Date.now() - restedAt + 120}ms after the pointer arrived`)
  overlay.webContents.send('dock:pointer', { near: false })
  check('left alone and empty, it goes away again', await until(() => !overlay.getVisible(), 2500))
  layerClear('after the bottom edge')

  // ---- a request made on a page (events played back, no model is called) ------------------------
  const pageTab = tabs.activeId!
  const full = tabs.get(pageTab)!.view!.getBounds()
  const thread = play('thread')
  thread({ type: 'session', title: 'Summarise this page', status: 'running', mode: 'auto' })
  thread({ type: 'user', text: 'Summarise this page' })
  thread({ type: 'attach', tab: pageTab })
  thread({ type: 'step', id: 'p1', tool: 'browser_read', summary: 'Read the page', status: 'run', tab: pageTab })
  const beside = await until(() => shell.layout.panel > 0 && shell.layout.mode === 'browse' && shell.layout.frame)
  check('a request made on a page opens beside that page, not as a task elsewhere', beside && tabs.activeId === pageTab, `panel ${shell.layout.panel}, mode ${shell.layout.mode}, border ${shell.layout.frame}`)
  await wait(150)
  const framed = tabs.get(pageTab)!.view!.getBounds()
  check('the page being worked on gets a border all round', (await count(ui, '.card.working')) === 1 && framed.x === full.x + 3 && framed.y === full.y + 3, `page drawn at ${framed.x},${framed.y} ${framed.width}x${framed.height}, was ${full.x},${full.y} ${full.width}x${full.height}`)
  const cardBox = await js<{ x: number; y: number }>(ui, `(() => { const r = document.querySelector('.card').getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top) } })()`)
  check('the border is drawn round the page, where the page is', cardBox.x === full.x && cardBox.y === full.y - 44, `card at ${cardBox.x},${cardBox.y}; page was at ${full.x},${full.y}`)
  check('its tab says it is working, and it is not listed among the tasks', (await js<string>(ui, `document.querySelector('.word.tab.current .row-meta')?.textContent.trim() ?? ''`)) === 'working' && (await count(ui, '.word.task')) === 0)
  check('the line at the bottom is not used for it', (await count(overlay, '.dock-rail.on')) === 0)
  thread({ type: 'step', id: 'p1', tool: 'browser_read', summary: 'Read the page', status: 'ok', tab: pageTab })
  thread({ type: 'text', id: 'pt', delta: 'It is an example page.' })
  thread({ type: 'done', ok: true, ms: 1500 })
  thread({ type: 'session', title: 'Summarise this page', status: 'done', mode: 'auto' })
  check('when it finishes the border goes', (await until(() => !shell.layout.frame)) && (await count(ui, '.card.working')) === 0)
  check('the answer is beside the page', (await js<string>(ui, `document.querySelector('.panel:not(.center)')?.textContent ?? ''`)).includes('It is an example page.'))
  check('an answer you are looking at is not flagged as new', await until(async () => (await count(ui, '.word.tab.current .row-meta')) === 0, 1500))
  await click(ui, '.word.tab:not(.current)')
  check('going to another tab leaves that conversation behind', await until(() => shell.layout.panel === 0), `panel ${shell.layout.panel}`)
  tabs.activate(pageTab)
  await wait(250)
  if (shell.layout.panel > 0) shell.setLayout({ panel: 0 })
  await wait(200)

  // ---- a task, from start to result (the agent's events are played back, no model is called) ----
  const agent = play('selftest')
  agent({ type: 'session', title: 'Compare three kettles', status: 'running', mode: 'auto' })
  agent({ type: 'user', text: 'Compare three kettles' })
  agent({ type: 'step', id: 's1', tool: 'browser_read', summary: 'Read wirecutter.com/kettles', status: 'run' })
  const lineUp = await until(async () => overlay.getVisible() && overlay.getBounds().height <= 12 && (await count(ui, '.word.task')) === 1)
  check('a running task is a thin line at the bottom and a word in the top row', lineUp, `layer height ${overlay.getBounds().height}, task words ${await count(ui, '.word.task')}`)
  overlay.webContents.send('dock:pointer', { near: true })
  check('resting on the line shows what it is doing', await until(async () => (await count(overlay, '.dock-panel.up .watch')) === 1, 1500), `${await count(overlay, '.watch-step')} steps listed`)
  overlay.webContents.send('dock:pointer', { near: false })
  check('moving away folds it back to the line', await until(() => overlay.getBounds().height <= 12, 2500), `layer height ${overlay.getBounds().height}`)

  await click(ui, '.word.task')
  check('clicking the task goes to it', shell.layout.mode === 'chat' && (await count(ui, '.card.task')) === 1, shell.layout.mode)
  await click(ui, '.word.task')
  check('clicking it again goes back to the page', shell.layout.mode === 'browse' && shown().join() === tabs.activeId, shell.layout.mode)
  await click(ui, '.word.task')
  await click(ui, '.word.tab', 0)
  check('clicking a tab leaves the task', shell.layout.mode === 'browse' && shown().join() === tabs.activeId, shell.layout.mode)

  // The page a task is working on floats beside its conversation, and can be opened in full.
  const taskTab = tabs.create({ url: 'https://example.org/', owner: 'agent', session: 'selftest', activate: false })
  await until(() => !tabs.get(taskTab.id)?.info.loading && tabs.get(taskTab.id)?.info.url.includes('example.org') === true, 12000)
  await click(ui, '.word.task')
  const floating = await until(async () => shell.layout.peek === taskTab.id && shown().join() === taskTab.id && (await count(ui, '.tile')) === 1)
  check("the task's page floats beside its conversation", floating, `peek ${shell.layout.peek}, on screen ${shown().join() || 'none'}`)
  await click(ui, '.tile button')
  check('Open shows that page in full, with its own word and address in the top row', shell.layout.mode === 'browse' && tabs.activeId === taskTab.id && shown().join() === taskTab.id && (await count(ui, '.word.tab.current')) === 1, `mode ${shell.layout.mode}, current words ${await count(ui, '.word.tab.current')}`)
  await click(ui, '.word.tab', 0)

  agent({ type: 'step', id: 's1', tool: 'browser_read', summary: 'Read wirecutter.com/kettles', status: 'ok' })
  agent({ type: 'text', id: 't1', delta: 'The Fellow Stagg is the best of the three.\n\n- **Fellow Stagg**: precise pour, holds temperature\n- **Cuisinart**: cheapest, fastest boil\n- **Bonavita**: plain and reliable\n\nSource: https://example.com/kettles' })
  agent({ type: 'done', ok: true, ms: 4200 })
  agent({ type: 'session', title: 'Compare three kettles', status: 'done', mode: 'auto' })
  const [, h] = shell.win.getContentSize()
  const sheetUp = await until(async () => overlay.getVisible() && overlay.getBounds().height > h * 0.35 && (await count(overlay, '.dock-sheet.on .sheet-headline')) === 1)
  check('when it finishes, the result rises over the lower half', sheetUp, `layer height ${overlay.getBounds().height} of ${h}`)
  await wait(250)
  const closeButton = await probe(overlay, '.sheet-actions button', 1)
  await click(overlay, '.sheet-actions button', 1)
  check('Close puts the result away and leaves the page', await until(() => !overlay.getVisible(), 2500), `button on top: ${closeButton?.onTop} (${closeButton?.top}); dock is ${await js<string>(overlay, `document.querySelector('.dock').className`)}`)
  check('the task stays in the top row to come back to', (await count(ui, '.word.task')) === 1)
  layerClear('after a task')

  // ---- a task split between sub-agents, each in its own tab ------------------------------------
  const multi = play('multi')
  multi({ type: 'session', title: 'Compare three laptops', status: 'running', mode: 'auto' })
  multi({ type: 'user', text: 'Compare three laptops' })
  const parts = ['https://example.com/', 'https://example.org/', 'https://example.net/'].map((url) => tabs.create({ url, owner: 'agent', session: 'multi', activate: false }))
  parts.forEach((t, i) => {
    multi({ type: 'worker', worker: `w${i}`, label: `Laptop ${i + 1}`, status: 'running' })
    multi({ type: 'step', id: `m${i}`, tool: 'browser_read', summary: `Read ${t.url}`, status: 'run', worker: `w${i}`, tab: t.id })
  })
  await until(() => parts.every((t) => !tabs.get(t.id)?.info.loading), 15000)
  await click(ui, '.word.task', 0)
  const tilesUp = await until(async () => shell.layout.mode === 'chat' && shell.layout.tiles.length === 3 && shown().length === 3 && (await count(ui, '.tile')) === 3)
  check('every page a task is working in is shown live on the task page', tilesUp, `${shell.layout.tiles.length} tiles, ${shown().length} pages on screen`)
  const drawn = await js<{ x: number; y: number; width: number; height: number }[]>(ui, `[...document.querySelectorAll('.tile')].map((e) => { const r = e.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } })`)
  const framesMatch = shell.layout.tiles.every((t) => {
    const d = drawn.find((r) => r.x === t.x && r.y === t.y && r.width === t.width && r.height === t.height)
    const v = tabs.get(t.id)?.view?.getBounds()
    return !!d && !!v && v.x === t.x + 3 && v.y === t.y + t.header && v.width === t.width - 6 && v.height === t.height - t.header - 3
  })
  check('each live page sits exactly inside the frame drawn for it', framesMatch, JSON.stringify({ frames: drawn.map((r) => [r.x, r.y, r.width, r.height]), tiles: shell.layout.tiles.map((t) => [t.x, t.y, t.width, t.height]) }))
  const sizes = shell.layout.tiles.map((t) => t.width)
  check('one page is large and the others sit small beneath it', sizes.length === 3 && sizes[0] > sizes[1] * 1.8 && shell.layout.tiles[1].y >= shell.layout.tiles[0].y + shell.layout.tiles[0].height, sizes.join(', '))
  check('each page carries the name of the part working in it, and a border while it works', (await js<string>(ui, `[...document.querySelectorAll('.tile .tile-name')].map((e) => e.textContent.trim()).sort().join(', ')`)) === 'Laptop 1, Laptop 2, Laptop 3' && (await count(ui, '.tile.working')) === 3, `${await count(ui, '.tile.working')} with a border`)
  check('the log lists each part under its own name', (await count(ui, '.log-worker')) === 3 && (await count(ui, '.log-worker.running')) === 3, `${await count(ui, '.log-worker')} parts`)
  const wasFirst = shell.layout.peeks[0]
  await click(ui, '.tile:not(.primary) .tile-head')
  check('clicking a small page makes it the large one', await until(() => shell.layout.peeks[0] !== wasFirst && shell.layout.tiles[0]?.id === shell.layout.peeks[0]), `${wasFirst} -> ${shell.layout.peeks[0]}`)
  multi({ type: 'worker', worker: 'w0', label: 'Laptop 1', status: 'done' })
  check('a part that has finished loses its border', await until(async () => (await count(ui, '.tile.working')) === 2 && (await count(ui, '.log-worker.running')) === 2))
  await click(ui, '.word.tab', 0)
  check('leaving the task puts its pages away', shell.layout.mode === 'browse' && shown().join() === tabs.activeId, `on screen ${shown().join()}`)
  for (const t of parts) tabs.close(t.id)
  multi({ type: 'done', ok: true, ms: 100 })
  multi({ type: 'session', title: 'Compare three laptops', status: 'done', mode: 'auto' })
  await wait(500)

  // ---- what a task may do with files ---------------------------------------------------------------
  const rules = await core.call<{ read: string[]; write: string[] }>('files.judge', {
    read: ['notes.txt', '~/Desktop/report.txt', '/usr/share/dict/words', '~/.ssh/id_rsa', '~/Library/Cookies/x', '~/Projects/thing/.env'],
    write: ['out/report.pdf', '~/Desktop/brewse-selftest-new-file.pdf', '~/Documents', '~/.zshrc', '~/Library/LaunchAgents/x.plist', '/etc/hosts', '~/Projects/thing/readme.md'],
  })
  check('a task reads its own folder, your Desktop and system files freely, and asks before keys or application data', rules.read.join() === 'allow,allow,allow,ask,ask,ask', rules.read.join())
  check('a task writes in its own folder and adds new files to your Desktop; replacing asks; settings and system files are refused', rules.write.join() === 'allow,allow,ask,deny,deny,deny,ask', rules.write.join())
  agent({ type: 'files', folder: '/tmp/brewse-selftest', files: [{ path: '/tmp/brewse-selftest/report.pdf', name: 'report.pdf', size: 1200 }] })
  await click(ui, '.word.task', (await count(ui, '.word.task')) - 1)
  check('the files a task made are listed with its answer', await until(async () => shell.layout.mode === 'chat' && (await count(ui, '.made-row')) === 1), `${await count(ui, '.made-row')} listed`)
  await click(ui, '.word.tab', 0)

  // ---- where tasks are kept ------------------------------------------------------------------------
  await click(ui, '[data-nav="tasks"]')
  const listed = await until(async () => shell.layout.mode === 'tasks' && (await count(ui, '.task-row')) === 3 && shown().length === 0)
  check('Tasks lists everything that has been asked, tasks and page conversations alike', listed, `${await count(ui, '.task-row')} listed, mode ${shell.layout.mode}`)
  check('each line says what came of it', (await js<string>(ui, `[...document.querySelectorAll('.task-row .task-outcome')].map((e) => e.textContent).join(' | ')`)).includes('The Fellow Stagg is the best of the three.'))
  check('a conversation that belongs to a page says which', (await js<string>(ui, `document.querySelector('.task-row .task-page')?.textContent ?? ''`)).startsWith('On '))
  await type(ui, '.tasks-search', 'kettles')
  check('typing narrows the list', await until(async () => (await count(ui, '.task-row')) === 1), `${await count(ui, '.task-row')} listed`)
  await type(ui, '.tasks-search', '')
  await until(async () => (await count(ui, '.task-row')) === 3)
  await pressEscape(ui)
  check('Escape leaves the Tasks page', await until(() => shell.layout.mode === 'browse'))

  const openBefore = await count(ui, '.word.task')
  await click(ui, '.word.task .word-x')
  check('closing a task takes it out of the top row', (await count(ui, '.word.task')) === openBefore - 1, `${openBefore} -> ${await count(ui, '.word.task')}`)
  await click(ui, '[data-nav="tasks"]')
  check('a closed task is still on the Tasks page', await until(async () => (await count(ui, '.task-row')) === 3), `${await count(ui, '.task-row')} listed`)
  const stored = await core.call<{ id: string; headline: string }[]>('tasks.list')
  check('and is kept on disk, with its outcome', stored.length === 3 && stored.some((t) => t.headline.startsWith('The Fellow Stagg')), `${stored.length} stored`)
  const reopen = await js<number>(ui, `[...document.querySelectorAll('.task-row')].findIndex((r) => r.textContent.includes('Compare three kettles'))`)
  await click(ui, '.task-row', reopen)
  check('choosing it there opens it again, conversation and all', (await until(async () => shell.layout.mode === 'chat' && (await js<string>(ui, `document.querySelector('.panel.center')?.textContent ?? ''`)).includes('Fellow Stagg'))) && (await count(ui, '.word.task.current')) === 1, `mode ${shell.layout.mode}`)
  await click(ui, '.word.tab', 0)
  await click(ui, 'button[aria-label="New tab"]')
  check('a new tab lists your latest tasks under the field', await until(async () => (await count(ui, '.start-section .task-row')) >= 2 && (await count(ui, '.start-example')) === 0), `${await count(ui, '.start-section .task-row')} listed`)
  await click(ui, '.word.tab.current .word-x')
  await wait(200)

  // ---- the last tab -----------------------------------------------------------------------------
  for (let i = 0; i < 6 && userTabs().some((t) => !tabs.isBlank(t.id)); i++) {
    await click(ui, '.word.tab.current .word-x')
    await wait(200)
  }
  check('closing every tab leaves one empty tab, never an empty window', (await until(() => userTabs().length === 1 && tabs.isBlank(tabs.activeId))) && (await count(ui, '.start-input')) === 1, `${userTabs().length} tabs`)

  check('the interface reported no errors while all this happened', errors.length === 0, errors.slice(0, 4).join(' | '))
  const failed = results.filter((r) => !r.ok)
  console.log(failed.length ? `\n${failed.length} of ${results.length} failed` : `\nall ${results.length} passed`)
  return failed.length
}
